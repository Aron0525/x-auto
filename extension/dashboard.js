/* dashboard.js —— 控制台页面逻辑（面板 panel.js 的完整版） */

const $ = (id) => document.getElementById(id);
const NUM = ["session_minutes", "typing_ms", "follow_per_session",
             "max_like", "max_reply", "max_follow"];
const PROB = ["like_prob", "comment_prob", "expand_prob", "bookmark_prob"];
const TEXT = ["tone", "style", "feed", "llm_key", "llm_base", "llm_model"];
const FIELDS = [...NUM, ...PROB, ...TEXT, "speed"];

const DEFAULTS = {
  session_minutes: 30, typing_ms: 130, speed: 1.5, feed: "for_you",
  like_prob: 0.85, comment_prob: 0.8,
  expand_prob: 0.9, bookmark_prob: 0.3, follow_per_session: 3,
  tone: "friendly", style: "normal", notif_enabled: false,
  llm_key: "", llm_base: "https://api.deepseek.com/v1", llm_model: "deepseek-flash",
  max_like: 60, max_reply: 20, max_follow: 25,
};

let xTabId = null;
let lastStats = null;

// ---------------- 与 x.com 标签页通信 ----------------

async function findXTab() {
  const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
  return tabs[0] || null;
}

async function sendCmd(op) {
  if (xTabId === null) return null;
  try { return await chrome.tabs.sendMessage(xTabId, { t: "cmd", op }); }
  catch (e) { return null; }        // content 未注入
}

// ---------------- 设置 ----------------

async function loadSettings() {
  const d = await chrome.storage.local.get(["xa_settings"]);
  const s = { ...DEFAULTS, ...(d.xa_settings || {}) };
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? "";
  $("notif_enabled").checked = !!s.notif_enabled;
}

async function saveSettings() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    if (PROB.includes(f)) s[f] = Math.max(0, Math.min(1, parseFloat(el.value) || 0));
    else if (f === "speed") s[f] = Math.max(0.5, Math.min(3, parseFloat(el.value) || 1.5));
    else if (NUM.includes(f)) s[f] = Math.max(0, parseInt(el.value, 10) || 0);
    else s[f] = el.value.trim();
  }
  s.notif_enabled = $("notif_enabled").checked;
  await chrome.storage.local.set({ xa_settings: s });
  flash(`设置已保存 · 速度系数 ${s.speed}`, "on");
}

function flash(msg, cls) {
  const el = $("status");
  el.innerHTML = `${msg} <span class="pill ${cls || "off"}">${new Date().toLocaleTimeString()}</span>`;
  setTimeout(refresh, 2500);
}

// ---------------- 渲染 ----------------

function stat(label, value, used, cap, color) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const full = cap > 0 && used >= cap;
  return `<div class="stat"><b style="color:${full ? "#f9158b" : (color || "#e7e9ea")}">${value}</b>
    <span>${label}${cap ? ` · 上限 ${cap}` : ""}</span>
    <div class="bar"><i style="width:${pct}%;background:${full ? "#f9158b" : (color || "#1d9bf0")}"></i></div></div>`;
}

const todayCount = (events, kind) => {
  const t = new Date().toISOString().slice(0, 10);
  return events.filter((e) => e.kind === kind && (e.at || "").startsWith(t)).length;
};

function renderQuota(s, cfg) {
  const ev = s.events || [];
  const like = todayCount(ev, "like"), reply = todayCount(ev, "reply"), fl = todayCount(ev, "follow");
  $("quota").innerHTML =
    stat("点赞", like, like, cfg.max_like, "#f9158b") +
    stat("评论/回复", reply, reply, cfg.max_reply, "#1d9bf0") +
    stat("关注", fl, fl, cfg.max_follow, "#ffd400") +
    `<div class="stat"><b>${(s.records || []).length}</b><span>帖子留档条数</span></div>` +
    `<div class="stat"><b>${Object.keys(s.replied || {}).length}</b><span>累计已回过的帖子</span></div>`;
}

function renderSess(st) {
  if (!st) { $("sessStats").innerHTML = '<span style="color:#71767b">还没跑过会话</span>'; return; }
  const cell = (l, v, c) => `<div class="stat"><b style="color:${c || "#e7e9ea"}">${v}</b><span>${l}</span></div>`;
  $("sessStats").innerHTML =
    cell("读帖", st.read) + cell("展开", st.expanded) +
    cell("点赞", st.liked, "#f9158b") + cell("评论", st.commented, "#1d9bf0") +
    cell("收藏", st.bookmarked, "#00ba7c") + cell("关注", st.followed, "#ffd400") +
    cell("滑过", st.skipped, "#71767b");
}

const ACT_BADGE = { like: ["赞", "b-like"], comment: ["评", "b-cmt"], bookmark: ["藏", "b-bm"],
                    follow: ["关注", "b-fl"], skip: ["滑过", "b-skip"] };

function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRecords(s) {
  const q = ($("recFilter").value || "").trim().toLowerCase();
  const rows = (s.records || []).slice().reverse().filter((r) => {
    if (!q) return true;
    return ((r.handle || "") + " " + (r.author || "") + " " + (r.text || "")).toLowerCase().includes(q);
  }).slice(0, 400);
  $("recCount").textContent = `共 ${(s.records || []).length} 条，显示 ${rows.length} 条`;
  $("recBody").innerHTML = rows.map((r) => {
    const acts = r.actions || {};
    const badges = Object.keys(acts).map((k) => {
      const [label, cls] = ACT_BADGE[k] || [k, "b-skip"];
      if (k === "skip" && !acts[k]) return "";
      if (k === "comment" && typeof acts[k] === "string")
        return `<span class="badge b-cmt" title="${esc(acts[k])}">评</span>`;
      return `<span class="badge ${cls}">${label}</span>`;
    }).join("");
    const link = r.href ? `<a class="lnk" href="https://x.com${esc(r.href)}" target="_blank">${esc(r.handle || r.id)}</a>`
                        : esc(r.handle || r.id || "");
    return `<tr><td>${esc(r.at || "")}</td><td>${link}</td>` +
           `<td class="txt">${esc(r.text)}</td><td>${badges || '<span class="badge b-skip">无</span>'}</td></tr>`;
  }).join("") || '<tr><td colspan="4" style="color:#71767b">还没有留档。跑一轮会话后这里会有内容。</td></tr>';
}

const PHASE_CN = { home: "浏览时间线", detail: "详情页互动", profile: "作者主页评估",
                   notif: "看通知", notif_reply: "回复通知" };

function renderNow(s, running) {
  const el = $("nowView"), feed = $("nowFeed");
  if (!running) {
    el.innerHTML = '<span style="color:#71767b">空闲中——点「开始一轮」后这里显示当前正在读的帖子。</span>';
    feed.innerHTML = ""; return;
  }
  const n = s.now || {};
  const badge = `<span class="pill on">${esc(PHASE_CN[n.phase || s.phase] || n.phase || "…")}</span>`;
  const cat = n.cat ? ` <span class="badge b-fl">${esc(n.cat)}</span>` : "";
  el.innerHTML = n.text
    ? `${badge} <b>@${esc(n.handle || "?")}</b>${cat}<div class="txt" style="margin-top:4px">${esc(n.text)}</div>`
    : `${badge} 正在翻页/等待加载…`;
  // 最近 3 条活动直接放在视窗下面，不用切日志页
  const acts = (s.activity || []).slice(-3);
  feed.innerHTML = acts.map((a) =>
    `<div style="color:#71767b">[${esc(a.at)}] ${esc(a.msg.slice(0, 90))}</div>`).join("");
}

function renderLog(s) {
  const el = $("log");
  const keep = el.scrollTop;
  el.textContent = (s.activity || []).map((a) => `[${a.at}] ${a.msg}`).join("\n") || "（还没有活动）";
  if (el.dataset.follow === "1" || Math.abs(keep + el.clientHeight - el.scrollHeight) < 60)
    el.scrollTop = el.scrollHeight;
  el.dataset.follow = Math.abs(keep + el.clientHeight - el.scrollHeight) < 60 ? "1" : "0";
}

// ---------------- 刷新 ----------------

async function refresh() {
  const tab = await findXTab();
  xTabId = tab ? tab.id : null;
  const stEl = $("status");
  let running = false;
  if (!tab) {
    stEl.innerHTML = '<span class="pill bad">没找到 x.com 标签页</span> 请打开并登录 x.com';
    $("start").disabled = true; $("stop").disabled = true;
  } else {
    const ping = await sendCmd("ping");
    if (!ping) {
      stEl.innerHTML = '<span class="pill warn">页面未注入</span> 点「修复页面注入」';
      $("start").disabled = false; $("stop").disabled = true;
    } else if (ping.running) {
      running = true;
      stEl.innerHTML = `<span class="pill on">会话中</span> 阶段 <code>${esc(ping.phase)}</code>`;
      $("start").disabled = true; $("stop").disabled = false;
    } else {
      stEl.innerHTML = '<span class="pill off">空闲</span> 已连接 x.com 标签页';
      $("start").disabled = false; $("stop").disabled = true;
    }
  }

  const d = await chrome.storage.local.get(["xa_settings", "xa_state", "xa_rounds"]);
  const cfg = { ...DEFAULTS, ...(d.xa_settings || {}) };
  const s = d.xa_state || { events: [], records: [], activity: [], replied: {} };
  renderQuota(s, cfg);
  if (s.stats) lastStats = s.stats;
  renderSess(lastStats);
  renderNow(s, running);
  renderRecords(s);
  renderLog(s);

  const rounds = d.xa_rounds || {};
  $("rounds").textContent = rounds.on ? `循环：开（已 ${rounds.done || 0} 轮）` : "循环：关";
  $("rounds").classList.toggle("ghost", !rounds.on);
  $("roundInfo").innerHTML = rounds.on && rounds.next
    ? `<span style="color:#71767b">下一轮 ${new Date(rounds.next).toLocaleTimeString()}</span>` : "";
}

// ---------------- 动作 ----------------

async function start() {
  const r = await sendCmd("start");
  if (r && r.ok) flash("会话已启动", "on");
  else flash("启动失败：页面没就绪，先点「修复页面注入」", "bad");
}

async function stop() {
  await sendCmd("stop");
  flash("已停止", "warn");
}

async function toggleRounds() {
  const d = await chrome.storage.local.get(["xa_rounds"]);
  const rounds = d.xa_rounds || {};
  const on = !rounds.on;
  await chrome.runtime.sendMessage({ t: "rounds", on });
  rounds.on = on;
  if (on) rounds.next = Date.now() + 30 * 60000;
  await chrome.storage.local.set({ xa_rounds: rounds });
  if (on && xTabId !== null) {
    const r = await sendCmd("start");
    if (!r) flash("循环已开，但当前页面未注入", "warn");
  }
  refresh();
}

async function reinject() {
  if (xTabId === null) { flash("没有 x.com 标签页可注入", "bad"); return; }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: xTabId },
      files: ["sop.js", "comment.js", "content.js"],
    });
    await chrome.tabs.sendMessage(xTabId, { t: "cmd", op: "ping" });
    flash("注入完成", "on");
  } catch (e) {
    flash("注入失败：" + (e.message || e), "bad");
  }
  refresh();
}

async function exportRecords() {
  const d = await chrome.storage.local.get(["xa_state"]);
  const s = d.xa_state || {};
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
  flash("已导出", "on");
}

// ---------------- 绑定 ----------------

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.remove("cur"));
    document.querySelectorAll("section").forEach((x) => x.classList.remove("cur"));
    b.classList.add("cur");
    $("sec-" + b.dataset.tab).classList.add("cur");
  };
});

$("start").onclick = start;
$("stop").onclick = stop;
$("rounds").onclick = toggleRounds;
$("save").onclick = saveSettings;
$("reinject").onclick = reinject;
$("export").onclick = exportRecords;
$("openX").onclick = () => chrome.tabs.create({ url: "https://x.com/home" });
$("recFilter").oninput = () => refresh();
$("clearLog").onclick = () => { $("log").textContent = "（已清空显示，新的活动会继续进来）"; };

loadSettings();
refresh();
setInterval(refresh, 4000);
chrome.storage.onChanged.addListener((_, area) => { if (area === "local") refresh(); });
