/* comment-rule.js —— 评论规则独立窗口的逻辑
 *
 * 存的位置和主控制台一致：chrome.storage.local 的 xa_settings
 * （提示词/模板也在里面，所以 content.js 的 getBeh 直接能读到）。
 * 保存用「合并」而不是整体替换，避免把 API Key 之类别的字段抹掉。
 */

const $ = (id) => document.getElementById(id);
const FIELDS = ["comment_rule", "comment_prob", "comment_prob_cap", "dedup_comment",
                "focus_keywords", "comment_target_len", "style", "tone",
                "comment_prompt", "comment_templates"];
const PROB = ["comment_prob", "comment_prob_cap"];
const NUM = ["comment_target_len"];

const RULE_HINT = {
  mine: "当前：什么帖子都能评，只卡 20 字上限，13 字左右随机",
  sop: "当前：严格校验，质量分不足或接不住具体点的帖子不评",
};

function setStatus(msg, cls) {
  $("status").innerHTML = msg
    ? `${msg} <span class="pill ${cls || "off"}">${new Date().toLocaleTimeString()}</span>` : "";
}

function msg(t, cls) {
  $("saveMsg").textContent = t;
  $("saveMsg").style.color = cls === "bad" ? "#f9158b" : cls === "on" ? "#00ba7c" : "#71767b";
}

// ---------------- 载入 ----------------

async function load() {
  const d = await chrome.storage.local.get(["xa_settings", "xa_llm"]);
  const s = d.xa_settings || {};
  const llm = d.xa_llm || {};

  $("comment_rule").value = s.comment_rule || "mine";
  $("comment_prob").value = s.comment_prob ?? 0.85;
  $("comment_prob_cap").value = s.comment_prob_cap ?? 1;
  $("dedup_comment").checked = s.dedup_comment !== false;
  $("focus_keywords").value = s.focus_keywords || "";
  $("comment_target_len").value = s.comment_target_len ?? 13;
  $("style").value = s.style || "normal";
  $("tone").value = s.tone || "friendly";

  // 提示词/模板：存的优先，没存过就显示默认（让人看到现在到底在用什么）
  $("comment_prompt").value = s.comment_prompt || COMMENT_GEN.DEFAULT_MINE_PROMPT;
  $("comment_templates").value = s.comment_templates ||
    COMMENT_GEN.DEFAULT_MINE_TEMPLATES.join("\n");

  $("ruleHint").textContent = RULE_HINT[$("comment_rule").value];
  renderPlaceholders();
  updateTplCount();
  renderPreview();
  setStatus(llm.apiKey
    ? '<span class="pill on">API 已配置</span> 提示词会真正发给模型'
    : '<span class="pill warn">未配 API Key</span> 会走下面的模板句', "");
}

// ---------------- 占位符插入 ----------------

const PLACEHOLDERS = [
  ["{len}", "目标字数（每次随机）"],
  ["{lo}", "字数区间下限"],
  ["{hi}", "字数区间上限"],
  ["{cap}", "硬上限 20"],
  ["{tone}", "语气档"],
  ["{post}", "原帖正文"],
];

function renderPlaceholders() {
  $("phRow").innerHTML = PLACEHOLDERS
    .map(([k, d]) => `<span data-ph="${k}" title="${d}">${k} · ${d}</span>`).join("");
  $("phRow").querySelectorAll("[data-ph]").forEach((el) => {
    el.onclick = () => insertAtCursor($("comment_prompt"), el.dataset.ph);
  });
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = start + text.length;
}

// ---------------- 计数与预览 ----------------

function tplList() {
  return $("comment_templates").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

function updateTplCount() {
  const n = tplList().length;
  const noP = tplList().filter((t) => !t.includes("{p}")).length;
  $("tplCount").textContent = `共 ${n} 条` + (noP ? ` · 其中 ${noP} 条没有 {p}（不会回应帖子内容）` : "");
}

// 复刻 content.js 里 shortPhrase 的逻辑，用于预览「回应帖子」那一部分
function shortPhrase(text, limit) {
  const clauses = (text || "").split(/[。！？；;!?\n]+/).map((c) => c.trim().replace(/^[，,、：:]+|[，,、：:]+$/g, "")).filter(Boolean);
  const pool = clauses.filter((c) => c.length >= 6 && c.length <= 40);
  if (!pool.length) return "";
  const best = pool.reduce((a, b) => (b.length > a.length ? b : a));
  if (best.length <= limit) return best;
  const w = best.slice(0, limit);
  const idx = Math.max(w.lastIndexOf("，"), w.lastIndexOf(","));
  return idx > limit * 0.5 ? w.slice(0, idx) : w.slice(0, limit - 1) + "…";
}

function renderPreview() {
  const target = Math.max(5, Math.min(40, parseInt($("comment_target_len").value, 10) || 13));
  const lo = Math.max(4, target - 5), hi = Math.min(20, target + 5);
  const post = $("samplePost").value || "";
  const list = tplList();
  const box = $("liveBox");
  if (!list.length) {
    box.innerHTML = '<div class="item" style="color:#f9158b">模板是空的，没配 API Key 时会完全评不了。至少留一条。</div>';
    return;
  }
  const out = [];
  for (let i = 0; i < 6; i++) {
    const tpl = list[Math.floor(Math.random() * list.length)];
    const len = lo + Math.floor(Math.random() * (hi - lo + 1));
    const phrase = shortPhrase(post, Math.max(6, len - 6)) || "这个观点";
    const text = tpl.replaceAll("{p}", phrase);
    const over = text.length > 20;
    out.push(`<div class="item">${escapeHtml(text)} <span class="num">${text.length} 字${over ? " · 超 20 字会被拒" : ""}</span></div>`);
  }
  box.innerHTML = out.join("");
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- 保存 ----------------

async function save() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (PROB.includes(f)) s[f] = Math.max(0, Math.min(1, parseFloat(el.value) || 0));
    else if (NUM.includes(f)) s[f] = Math.max(5, Math.min(20, parseInt(el.value, 10) || 13));
    else if (f === "dedup_comment") s[f] = el.checked;
    else s[f] = el.value;
  }
  // 提示词如果是默认值原样，就不存（以后改默认模板能自动跟上）
  if (s.comment_prompt.trim() === COMMENT_GEN.DEFAULT_MINE_PROMPT.trim()) delete s.comment_prompt;
  const tplDefault = COMMENT_GEN.DEFAULT_MINE_TEMPLATES.join("\n");
  if (s.comment_templates.trim() === tplDefault.trim()) delete s.comment_templates;

  if (s.comment_templates !== undefined) {
    const list = (s.comment_templates || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) { msg("模板不能为空（没配 API Key 时全靠它）", "bad"); return; }
  }

  // 合并保存：别把 API Key 等其它字段抹掉
  const cur = (await chrome.storage.local.get(["xa_settings"])).xa_settings || {};
  await chrome.storage.local.set({ xa_settings: { ...cur, ...s } });

  const n = (s.comment_templates || "").split(/\n+/).filter((x) => x.trim()).length;
  msg(`已保存 · ${s.comment_rule === "sop" ? "原 SOP 规则" : "我的规则"} · ${s.comment_target_len} 字左右` +
      (n ? ` · 模板 ${n} 条` : ""), "on");
  setStatus('<span class="pill on">已保存</span> 下一轮会话生效', "");
  renderPreview();
}

// ---------------- 绑定 ----------------

$("comment_rule").onchange = () => { $("ruleHint").textContent = RULE_HINT[$("comment_rule").value]; };
$("resetPrompt").onclick = () => { $("comment_prompt").value = COMMENT_GEN.DEFAULT_MINE_PROMPT; msg("提示词已恢复默认（保存后生效）"); };
$("resetTemplates").onclick = () => {
  $("comment_templates").value = COMMENT_GEN.DEFAULT_MINE_TEMPLATES.join("\n");
  updateTplCount(); renderPreview(); msg("模板已恢复默认（保存后生效）");
};
$("comment_templates").oninput = () => updateTplCount();
$("samplePost").oninput = () => renderPreview();
$("preview").onclick = () => renderPreview();
$("save").onclick = save;
$("close").onclick = () => window.close();

load();
