/* comment-rule.js —— 评论规则独立窗口的逻辑
 *
 * 存的位置和主控制台一致：chrome.storage.local 的 xa_settings
 * （提示词/模板也在里面，所以 content.js 的 getBeh 直接能读到）。
 * 保存用「合并」而不是整体替换，避免把 API Key 之类别的字段抹掉。
 *
 * 2026-11-18 改：
 *   · 提示词支持保存多套（comment_prompts 数组 + comment_prompt_id 指向当前用的）
 *   · 加「用真实帖子试效果」：读 15 条程序实际保存的帖子，一键调模型生成评论
 */

const $ = (id) => document.getElementById(id);
const FIELDS = ["comment_rule", "comment_prob", "comment_prob_cap", "dedup_comment",
                "focus_keywords", "comment_target_len", "style", "tone",
                "comment_templates"];
const PROB = ["comment_prob", "comment_prob_cap"];
const NUM = ["comment_target_len"];

const RULE_HINT = {
  mine: "当前：什么帖子都能评，句子完整优先，13 字左右随机",
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

// ---------------- 多套提示词 ----------------
// 存储结构：
//   comment_prompts: [{ id, name, body }]   所有保存的提示词
//   comment_prompt_id: "xxx"                当前使用哪一套
// 运行时代码（content.js/getBeh）读 comment_prompt 字段；
// 保存时把选中那套的 body 写进 comment_prompt，保持向后兼容。

let PROMPTS = [];       // [{id,name,body}]
let CURRENT = "";       // 当前选中的 id

function uid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function defaultPreset() {
  return { id: "default", name: "内置默认（评论者视角）", body: COMMENT_GEN.DEFAULT_MINE_PROMPT };
}

function ensurePrompts(s) {
  const list = Array.isArray(s.comment_prompts) ? s.comment_prompts.filter((p) => p && p.body) : [];
  if (!list.length) {
    // 迁移：老版本只存一个 comment_prompt 字符串
    const old = (s.comment_prompt || "").trim();
    PROMPTS = old && old !== COMMENT_GEN.DEFAULT_MINE_PROMPT.trim()
      ? [defaultPreset(), { id: uid(), name: "我之前用的", body: old }]
      : [defaultPreset()];
    CURRENT = old && old !== COMMENT_GEN.DEFAULT_MINE_PROMPT.trim()
      ? PROMPTS[PROMPTS.length - 1].id : "default";
  } else {
    // 内置默认永远在列表里（可能被用户改名/改内容，就按存的来）
    PROMPTS = list;
    CURRENT = s.comment_prompt_id && list.some((p) => p.id === s.comment_prompt_id)
      ? s.comment_prompt_id : list[0].id;
  }
}

function renderPromptSelect() {
  const sel = $("promptPreset");
  sel.innerHTML = PROMPTS.map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || "(未命名)")}</option>`).join("");
  sel.value = CURRENT;
  const cur = PROMPTS.find((p) => p.id === CURRENT) || PROMPTS[0];
  $("promptName").value = cur ? cur.name : "";
  $("comment_prompt").value = cur ? cur.body : COMMENT_GEN.DEFAULT_MINE_PROMPT;
  updatePromptMeta();
}

function curPrompt() {
  return PROMPTS.find((p) => p.id === CURRENT) || PROMPTS[0];
}

function updatePromptMeta() {
  const body = $("comment_prompt").value || "";
  const hasTone = body.includes("{tone}");
  const hasLen = body.includes("{len}");
  const bits = [`${body.length} 字符`];
  if (!hasTone) bits.push("⚠ 没写 {tone} → 语气选择不生效");
  if (!hasLen) bits.push("⚠ 没写 {len} → 模型不知道目标长度");
  const el = $("promptMeta");
  if (el) el.textContent = bits.join(" · ");
}

// ---------------- 载入 ----------------

let LLM = {};

async function load() {
  const d = await chrome.storage.local.get(["xa_settings", "xa_llm", "xa_stats"]);
  const s = d.xa_settings || {};
  LLM = d.xa_llm || {};

  $("comment_rule").value = s.comment_rule || "mine";
  $("comment_prob").value = s.comment_prob ?? 0.85;
  $("comment_prob_cap").value = s.comment_prob_cap ?? 1;
  $("dedup_comment").checked = s.dedup_comment !== false;
  $("focus_keywords").value = s.focus_keywords || "";
  $("comment_target_len").value = s.comment_target_len ?? 13;
  $("style").value = s.style || "normal";
  $("tone").value = s.tone || "friendly";

  ensurePrompts(s);
  renderPromptSelect();

  // 模板：留空表示用内置分场景池（推荐），所以空就显示空
  $("comment_templates").value = s.comment_templates || "";

  $("ruleHint").textContent = RULE_HINT[$("comment_rule").value];
  renderPlaceholders();
  updateTplCount();
  setStatus(LLM.apiKey
    ? '<span class="pill on">API 已配置</span> 可以用下面的按钮真实生成'
    : '<span class="pill warn">未配 API Key</span> 只能看模板效果', "");

  loadPosts();
}

// ---------------- 占位符插入 ----------------

const PLACEHOLDERS = [
  ["{len}", "目标字数（建议值，非上限）"],
  ["{lo}", "字数区间下限"],
  ["{hi}", "字数区间上限"],
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
  updatePromptMeta();
}

// ---------------- 模板计数 ----------------

function tplList() {
  return $("comment_templates").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

function updateTplCount() {
  const n = tplList().length;
  $("tplCount").textContent = n
    ? `共 ${n} 条自定义模板（会覆盖内置分场景模板）`
    : "当前用内置分场景模板（推荐）";
}

function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- 真实帖子样本 ----------------

let POSTS = [];

async function loadPosts() {
  const box = $("postList");
  box.innerHTML = '<div class="item">读取中…</div>';
  let posts = [];
  try {
    const r = await chrome.runtime.sendMessage({ t: "get_posts_sample", n: 15 });
    posts = (r && r.items) || [];
  } catch (e) { posts = []; }

  // 拿不到就退回内置样本，至少能试
  if (!posts.length) {
    posts = [
      "我靠，辛辛苦苦定投一年，牛市赚的钱，熊市几天就给你收回去了。",
      "很多人第一次做独立开发，最容易掉进一直闷头改产品、不敢拿出去给人用的坑里。",
      "AI 并没有让构建变得容易。它让分发变得更贵。",
      "我把全部身家压在了一个没人看好的方向上，今天终于有了第一个付费用户。",
      "招人的时候我只看一件事：这个人是不是真的对这个东西感兴趣。技术可以教，兴趣教不了。",
      "写了一年多 newsletter，订阅从 0 到 3000。内容质量只决定留存，选题才决定打开率。",
      "这个应用的收入一个月几万美金，但平台规则一变就可能归零。",
      "一年多来，我一直在默默地做一件事情。今晚它会不再是秘密。",
    ].map((text, i) => ({ id: "sample" + i, text, sample: true }));
  }
  POSTS = posts;
  renderPosts([]);
  $("genMsg").textContent = posts[0] && posts[0].sample
    ? "没读到保存的帖子，用的是内置样本" : `已读取 ${posts.length} 条真实帖子`;
}

function renderPosts(results) {
  const box = $("postList");
  box.innerHTML = POSTS.map((p, i) => {
    const r = results[i];
    const cmt = r === undefined ? "" :
      r === null ? '<div class="cmt bad">生成失败</div>'
      : !r ? '<div class="cmt bad">没有合格评论</div>'
      : `<div class="cmt">→ ${escapeHtml(r)} <span class="num">${r.length} 字</span></div>`;
    return `<div class="item">
      <div class="num">#${i + 1}${p.sample ? " · 内置样本" : ""}</div>
      <div>${escapeHtml(String(p.text || "").slice(0, 160))}</div>
      ${cmt}
    </div>`;
  }).join("");
}

// ---------------- 生成 ----------------

async function generateAll(useLlm) {
  if (!POSTS.length) { $("genMsg").textContent = "先点「重新读取帖子」"; return; }
  if (useLlm && (!LLM.apiKey || !LLM.baseUrl || !LLM.model)) {
    $("genMsg").textContent = "没配 API，只能用模板生成";
    useLlm = false;
  }

  const beh = {
    comment_rule: $("comment_rule").value,
    comment_target_len: Math.max(5, Math.min(40, parseInt($("comment_target_len").value, 10) || 13)),
    tone: $("tone").value,
    comment_prompt: $("comment_prompt").value,
    comment_templates: $("comment_templates").value,
  };

  COMMENT_GEN.applyCustom(beh);
  COMMENT_GEN.setHistory([]);
  renderPosts([]);

  const results = [];
  for (let i = 0; i < POSTS.length; i++) {
    $("genMsg").textContent = `生成中… ${i + 1}/${POSTS.length}`;
    try {
      let r = "";
      if (useLlm) {
        const g = await COMMENT_GEN.generateMine(
          { text: POSTS[i].text }, $("comment_prompt").value, beh, LLM);
        r = (g && g.text) || "";
      }
      if (!r) r = COMMENT_GEN.tryTemplates({ text: POSTS[i].text }, beh.comment_target_len, beh) || "";
      results.push(r || null);
    } catch (e) {
      results.push(null);
    }
    renderPosts(results);
  }
  const ok = results.filter(Boolean).length;
  $("genMsg").textContent = `完成：${ok}/${POSTS.length} 条生成成功` + (useLlm ? "（调用模型）" : "（模板）");
}

// ---------------- 保存 ----------------

async function save() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (PROB.includes(f)) s[f] = Math.max(0, Math.min(1, parseFloat(el.value) || 0));
    else if (NUM.includes(f)) s[f] = Math.max(5, Math.min(40, parseInt(el.value, 10) || 13));
    else if (f === "dedup_comment") s[f] = el.checked;
    else s[f] = el.value;
  }

  // 把当前编辑框内容写回这套提示词
  const cur = curPrompt();
  if (cur) {
    cur.name = $("promptName").value.trim() || cur.name || "未命名";
    cur.body = $("comment_prompt").value;
  }
  s.comment_prompts = PROMPTS;
  s.comment_prompt_id = CURRENT;
  // 向后兼容：content.js 读 comment_prompt 这个字段
  s.comment_prompt = cur ? cur.body : COMMENT_GEN.DEFAULT_MINE_PROMPT;
  // 如果当前就是内置默认，清掉以跟随代码默认值更新
  if (s.comment_prompt.trim() === COMMENT_GEN.DEFAULT_MINE_PROMPT.trim()) delete s.comment_prompt;

  // 合并保存：别把 API Key 等其它字段抹掉
  const cur2 = (await chrome.storage.local.get(["xa_settings"])).xa_settings || {};
  await chrome.storage.local.set({ xa_settings: { ...cur2, ...s } });

  const n = tplList().length;
  msg(`已保存 · ${s.comment_rule === "sop" ? "原 SOP 规则" : "我的规则"} · ${s.comment_target_len} 字左右` +
      ` · 提示词「${cur ? cur.name : "默认"}」` + (n ? ` · 模板 ${n} 条` : " · 用内置模板"), "on");
  setStatus('<span class="pill on">已保存</span> 下一轮会话生效', "");
  renderPromptSelect();
}

// ---------------- 绑定 ----------------

$("comment_rule").onchange = () => { $("ruleHint").textContent = RULE_HINT[$("comment_rule").value]; };

// 提示词：切换 / 新建 / 删除
$("promptPreset").onchange = () => {
  // 先把编辑框里未保存的改动存回上一套
  const prev = curPrompt();
  if (prev) { prev.body = $("comment_prompt").value; prev.name = $("promptName").value.trim() || prev.name; }
  CURRENT = $("promptPreset").value;
  renderPromptSelect();
  msg("已切换提示词（点保存生效）");
};

$("promptNew").onclick = () => {
  const prev = curPrompt();
  if (prev) { prev.body = $("comment_prompt").value; }
  const p = { id: uid(), name: "新提示词 " + (PROMPTS.length + 1), body: COMMENT_GEN.DEFAULT_MINE_PROMPT };
  PROMPTS.push(p); CURRENT = p.id;
  renderPromptSelect();
  msg("已新建一套，改完点保存");
};

$("promptDel").onclick = () => {
  if (PROMPTS.length <= 1) { msg("至少保留一套提示词", "bad"); return; }
  PROMPTS = PROMPTS.filter((p) => p.id !== CURRENT);
  CURRENT = PROMPTS[0].id;
  renderPromptSelect();
  msg("已删除这套（点保存生效）");
};

$("promptSaveAs").onclick = () => {
  const p = { id: uid(), name: ($("promptName").value.trim() || "副本") + " 副本",
              body: $("comment_prompt").value };
  PROMPTS.push(p); CURRENT = p.id;
  renderPromptSelect();
  msg("已另存为新的一套（点保存生效）");
};

$("comment_prompt").oninput = () => updatePromptMeta();
$("promptName").oninput = () => { const c = curPrompt(); if (c) c.name = $("promptName").value; };

$("resetPrompt").onclick = () => {
  $("comment_prompt").value = COMMENT_GEN.DEFAULT_MINE_PROMPT;
  updatePromptMeta();
  msg("提示词已改成内置默认（保存后生效）");
};
$("resetTemplates").onclick = () => {
  $("comment_templates").value = "";
  updateTplCount(); msg("已清空，将使用内置分场景模板（保存后生效）");
};
$("comment_templates").oninput = () => updateTplCount();

$("reloadPosts").onclick = () => loadPosts();
$("genAll").onclick = () => generateAll(true);
$("genTpl").onclick = () => generateAll(false);
$("save").onclick = save;
$("close").onclick = () => window.close();

load();
