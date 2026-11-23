/* panel.js —— 侧边栏控制面板 */

const $ = (id) => document.getElementById(id);
const FIELDS = ["session_minutes", "typing_ms", "like_prob", "comment_prob",
                "explore_prob", "comment_rule", "comment_target_len",
                "expand_prob", "bookmark_prob", "follow_per_session", "tone", "style",
                "llm_key", "llm_model", "max_like", "max_reply", "max_follow"];

async function xTab() {
  const [tab] = await chrome.tabs.query({ url: "https://x.com/*" });
  return tab || null;
}

async function sendCmd(op) {
  const tab = await xTab();
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { t: "cmd", op }); }
  catch (e) { return null; }   // content 没注入（页面比插件先开）
}

const DEFAULTS = {
  session_minutes: 30, typing_ms: 130, like_prob: 0.85, comment_prob: 0.85,
  expand_prob: 0.9, bookmark_prob: 0.3, follow_per_session: 5, explore_prob: 0.5,
  comment_rule: "mine", comment_target_len: 13,
  tone: "friendly", style: "normal", notif_enabled: false,
  llm_key: "", llm_model: "deepseek-flash",
  max_like: 60, max_reply: 20, max_follow: 25,
  // 评论审核：默认关闭（用户要求先暂停）。及格线只有开启时才生效。
  review_enabled: false, review_threshold: 60,
};

async function loadSettings() {
  const d = await chrome.storage.local.get(["xa_settings"]);
  const s = { ...DEFAULTS, ...(d.xa_settings || {}) };
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? "";
  $("notif_enabled").checked = !!s.notif_enabled;
  /* 评论审核：侧边栏也能开关、改及格线。默认关闭。 */
  if ($("review_enabled")) $("review_enabled").checked = s.review_enabled === true;
  if ($("review_threshold")) $("review_threshold").value = s.review_threshold ?? 60;
  /* 三道基础检查：默认**全关**（用户要求"生成什么就发什么"），只有 true 才开 */
  if ($("check_validate")) $("check_validate").checked = s.check_validate === true;
  if ($("check_echo")) $("check_echo").checked = s.check_echo === true;
  if ($("check_opinion")) $("check_opinion").checked = s.check_opinion === true;
  updateReviewHint();
  return s;
}

/* 审核开关状态提示：关着的时候明确告诉用户及格线现在不生效 */
function updateReviewHint() {
  const el = $("reviewHint");
  const on = $("review_enabled") ? $("review_enabled").checked : false;
  if (el) el.textContent = on ? "已开启：不合格的评论会被丢弃" : "默认关闭：模型写什么就发什么";
  const th = $("review_threshold");
  if (th) {
    th.disabled = !on;
    th.style.opacity = on ? "1" : "0.45";
  }
}

async function saveSettings() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    const raw = el.value;
    // API Key 留空 = 保持原值，不覆盖已保存的密钥
    if (f === "llm_key" && !raw.trim()) continue;
    s[f] = ["like_prob", "comment_prob", "expand_prob", "bookmark_prob", "explore_prob"].includes(f)
      ? Math.max(0, Math.min(1, parseFloat(raw) || 0))
      : f === "comment_target_len" ? Math.max(5, Math.min(40, parseInt(raw, 10) || 13))
      : raw;
  }
  s.notif_enabled = $("notif_enabled").checked;
  /* 审核字段必须显式取：checkbox 走通用循环会被存成 "on" 字符串。 */
  s.review_enabled = $("review_enabled") ? $("review_enabled").checked : false;
  s.review_threshold = $("review_threshold")
    ? Math.max(0, Math.min(100, parseInt($("review_threshold").value, 10) || 60))
    : 60;
  /* 三道基础检查：显式存布尔 */
  s.check_validate = $("check_validate") ? $("check_validate").checked : true;
  s.check_echo = $("check_echo") ? $("check_echo").checked : true;
  s.check_opinion = $("check_opinion") ? $("check_opinion").checked : true;
  // 合并而不是整体替换：控制台独有的字段（speed/feed 等）不能被抹掉
  const cur = (await chrome.storage.local.get(["xa_settings"])).xa_settings || {};
  await chrome.storage.local.set({ xa_settings: { ...cur, ...s } });
  flash("已保存");
}

function flash(msg) {
  $("status").textContent = msg;
  setTimeout(refresh, 2000);
}

async function refresh() {
  const tab = await xTab();
  if (!tab) { $("status").textContent = "没找到 x.com 标签页"; return; }
  const ping = await sendCmd("ping");
  const running = !!(ping && ping.running);
  $("status").innerHTML = `已连接 · ` +
    (running ? `<span class="pill on">会话中（${ping.phase}）</span>`
             : `<span class="pill off">空闲</span>`);
  $("start").disabled = running;
  $("stop").disabled = !running;

  const st = await chrome.storage.local.get(["xa_state"]);
  const s = st.xa_state || {};
  const today = new Date().toISOString().slice(0, 10);
  const cnt = (k) => (s.events || []).filter((e) => e.kind === k && (e.at || "").startsWith(today)).length;
  $("stats").innerHTML =
    `<span class="stat">今日赞 ${cnt("like")}</span>` +
    `<span class="stat">评 ${cnt("reply")}</span>` +
    `<span class="stat">关注 ${cnt("follow")}</span>` +
    `<span class="stat">留档 ${(s.records || []).length}</span>`;

  // 定时状态由 background 统一管理（随机间隔），这里只读展示
  const auto = await chrome.runtime.sendMessage({ t: "auto_get" }).catch(() => null);
  const autoOn = !!(auto && auto.on);
  const btn = $("rounds");
  if (btn) {
    if (autoOn) {
      const mins = auto.nextAt ? Math.max(0, Math.round((auto.nextAt - Date.now()) / 60000)) : 0;
      btn.textContent = `定时：开（${mins} 分钟后）`;
    } else {
      btn.textContent = "定时：关";
    }
    btn.classList.toggle("ghost", !autoOn);
  }

  const log = (s.activity || []).slice(-120).map((a) => `[${a.at}] ${a.msg}`).join("\n");
  const el = $("log");
  el.textContent = log || "（还没有活动）";
  el.scrollTop = el.scrollHeight;
}

async function toggleRounds() {
  const auto = await chrome.runtime.sendMessage({ t: "auto_get" }).catch(() => null);
  const on = !!(auto && auto.on);
  if (on) {
    await chrome.runtime.sendMessage({ t: "auto_stop" }).catch(() => {});
  } else {
    // 沿用已保存的随机区间，只把开关打开
    await chrome.runtime.sendMessage({ t: "auto_set", cfg: { auto_on: true } }).catch(() => {});
    const tab = await xTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { t: "cmd", op: "start" }).catch(() => {});
  }
  refresh();
}

async function exportRecords() {
  const st = await chrome.storage.local.get(["xa_state"]);
  const s = st.xa_state || {};
  const blob = new Blob([JSON.stringify({
    exported: new Date().toISOString(),
    records: s.records || [], replied: s.replied || {},
    liked: s.liked || {}, followed: s.followed || {}, events: s.events || [],
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `xauto-ext-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("start").onclick = async () => { const r = await sendCmd("start"); flash(r ? "会话已启动" : "启动失败：页面没就绪"); };
$("stop").onclick = async () => { await sendCmd("stop"); flash("已停止"); };
$("dash").onclick = () => chrome.runtime.sendMessage({ t: "open-dashboard" });
$("save").onclick = saveSettings;
$("rounds").onclick = toggleRounds;
$("export").onclick = exportRecords;

/* 审核开关：勾上/取消时立刻更新提示和及格线可用状态 */
if ($("review_enabled")) $("review_enabled").onchange = updateReviewHint;
/* 打开审核词表窗口（评论规则窗口，词表在里面增删改） */
if ($("openReviewRules")) $("openReviewRules").onclick = () => chrome.windows.create({
  url: chrome.runtime.getURL("comment-rule.html"),
  type: "popup", width: 980, height: 900,
});

loadSettings();
refresh();
setInterval(refresh, 4000);
