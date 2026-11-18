/* dashboard.js —— 控制台页面逻辑（面板 panel.js 的完整版） */

const $ = (id) => document.getElementById(id);
const NUM = ["session_minutes", "typing_ms", "follow_per_session",
             "max_like", "max_reply", "max_follow",
             "comment_target_len", "expand_char_min", "write_gap_min", "write_gap_max",
             "min_read_before_refresh"];
const PROB = ["like_prob", "comment_prob", "expand_prob", "bookmark_prob", "explore_prob",
              "like_prob_cap", "comment_prob_cap"];
const TEXT = ["tone", "style", "feed", "llm_key", "llm_base", "llm_model",
              "comment_rule", "focus_keywords", "my_handles"];
const FIELDS = [...NUM, ...PROB, ...TEXT, "speed"];

const DEFAULTS = {
  session_minutes: 30, typing_ms: 130, speed: 1.5, feed: "for_you",
  like_prob: 0.85, comment_prob: 0.85, explore_prob: 0.5,
  expand_prob: 0.9, bookmark_prob: 0.3, follow_per_session: 5,
  comment_rule: "mine", comment_target_len: 13,
  like_prob_cap: 0.9, comment_prob_cap: 1, expand_char_min: 220,
  write_gap_min: 30, write_gap_max: 90, dedup_comment: true, focus_keywords: "",
  my_handles: "johnJackyoi0f, 4395Aron",
  min_read_before_refresh: 12,
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
  const d = await chrome.storage.local.get(["xa_settings", "xa_llm"]);
  const s = { ...DEFAULTS, ...(d.xa_settings || {}) };
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? "";
  // API 配置放在独立的 xa_llm 里，优先级高于 xa_settings（迁移旧值）
  const llm = d.xa_llm || {};
  if (llm.apiKey) $("llm_key").value = llm.apiKey;
  if (llm.baseUrl) $("llm_base").value = llm.baseUrl;
  if (llm.model) $("llm_model").value = llm.model;
  $("notif_enabled").checked = !!s.notif_enabled;
  $("dedup_comment").checked = s.dedup_comment !== false;
  updateKeyState();
  const sum = $("ruleSummary");
  if (sum) {
    sum.textContent = s.comment_rule === "sop"
      ? "原 SOP 规则（严格校验）"
      : `我的规则 · ${s.comment_target_len ?? 13} 字左右 · 上限 20`;
  }
}

/* API Key 状态提示：让人一眼看出「已保存」还是「还没填」。
 * 密钥只存本地 chrome.storage.local，不上传任何服务器（除了发给模型接口本身）。 */
function updateKeyState() {
  const el = $("keyState");
  if (!el) return;
  const v = ($("llm_key").value || "").trim();
  if (v) {
    const mask = v.slice(0, 4) + "…" + v.slice(-4);
    el.innerHTML = `<span class="pill on">已填写</span> <code>${esc(mask)}</code>` +
      '<span style="color:#71767b"> 点「保存 API 配置」写入本地；下次打开自动带出</span>';
  } else {
    el.innerHTML = '<span class="pill off">未填写</span><span style="color:#71767b"> 不填也能跑，评论走短句模板兜底</span>';
  }
}

async function saveLlm() {
  const apiKey = ($("llm_key").value || "").trim();
  const baseUrl = ($("llm_base").value || "").trim() || "https://api.deepseek.com/v1";
  const model = ($("llm_model").value || "").trim() || "deepseek-flash";
  // 留空不覆盖：用户可能只是想改模型名
  const cur = (await chrome.storage.local.get(["xa_llm"])).xa_llm || {};
  const next = { ...cur, baseUrl, model };
  if (apiKey) next.apiKey = apiKey;   // 只有真填了才写，避免误清空
  await chrome.storage.local.set({ xa_llm: next });
  updateKeyState();
  flash(apiKey ? "API 配置已保存到本地（下次自动带出）" : "已保存模型设置（密钥保持原值）", "on");
}

async function clearLlm() {
  const cur = (await chrome.storage.local.get(["xa_llm"])).xa_llm || {};
  delete cur.apiKey;
  await chrome.storage.local.set({ xa_llm: cur });
  $("llm_key").value = "";
  updateKeyState();
  flash("已清除本地保存的 API Key", "warn");
}

async function saveSettings() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    // API Key 留空 = 保持原值，不覆盖已保存的密钥
    if (f === "llm_key" && !el.value.trim()) continue;
    if (PROB.includes(f)) s[f] = Math.max(0, Math.min(1, parseFloat(el.value) || 0));
    else if (f === "speed") s[f] = Math.max(0.5, Math.min(3, parseFloat(el.value) || 1.5));
    else if (f === "comment_target_len") s[f] = Math.max(5, Math.min(20, parseInt(el.value, 10) || 13));
    else if (NUM.includes(f)) s[f] = Math.max(0, parseInt(el.value, 10) || 0);
    else s[f] = el.value.trim();
  }
  // 写操作间隔：确保下限 ≤ 上限
  if (s.write_gap_min > s.write_gap_max) s.write_gap_max = s.write_gap_min;
  s.notif_enabled = $("notif_enabled").checked;
  s.dedup_comment = $("dedup_comment").checked;

  // 关键：与已有设置**合并**，不能整体替换。
  // 侧边栏和这个控制台字段不完全相同，整体替换会互相抹掉对方保存的字段
  // （API Key 丢失就是这么来的）。
  const cur = (await chrome.storage.local.get(["xa_settings"])).xa_settings || {};
  const merged = { ...cur, ...s };
  await chrome.storage.local.set({ xa_settings: merged });

  const ruleCn = merged.comment_rule === "sop" ? "原 SOP 规则" : `我的规则（${merged.comment_target_len} 字左右）`;
  flash(`设置已保存 · 速度 ${merged.speed} · 评论：${ruleCn}`, "on");
}

function flash(msg, cls) {
  const el = $("status");
  el.innerHTML = `${msg} <span class="pill ${cls || "off"}">${new Date().toLocaleTimeString()}</span>`;
  setTimeout(refresh, 2500);
}

// ---------------- 渲染 ----------------

function stat(label, value, used, cap, color, drillKey) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const full = cap > 0 && used >= cap;
  const cls = "stat" + (drillKey ? " click" : "");
  return `<div class="${cls}" ${drillKey ? `data-drill="${drillKey}"` : ""}
             title="${drillKey ? "点开看具体记录" : ""}">
    <b style="color:${full ? "#f9158b" : (color || "#e7e9ea")}">${value}</b>
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
    stat("点赞", like, like, cfg.max_like, "#f9158b", "like") +
    stat("评论/回复", reply, reply, cfg.max_reply, "#1d9bf0", "reply") +
    stat("关注", fl, fl, cfg.max_follow, "#ffd400", "follow") +
    `<div class="stat click" data-drill="records"><b>${(s.records || []).length}</b>
       <span>帖子留档条数</span></div>` +
    `<div class="stat click" data-drill="replied"><b>${Object.keys(s.replied || {}).length}</b>
       <span>累计已回过的帖子</span></div>`;
}

function renderSess(st) {
  if (!st) { $("sessStats").innerHTML = '<span style="color:#71767b">还没跑过会话</span>'; return; }
  const cell = (l, v, c, k) =>
    `<div class="stat click" data-drill="sess:${k}"><b style="color:${c || "#e7e9ea"}">${v}</b><span>${l}</span></div>`;
  $("sessStats").innerHTML =
    cell("读帖", st.read || 0, "", "read") + cell("展开", st.expanded || 0, "", "expanded") +
    cell("点赞", st.liked || 0, "#f9158b", "liked") + cell("评论", st.commented || 0, "#1d9bf0", "commented") +
    cell("收藏", st.bookmarked || 0, "#00bc7c", "bookmarked") + cell("关注", st.followed || 0, "#ffd400", "followed") +
    cell("滑过", st.skipped || 0, "#71767b", "skipped");
}

const ACT_BADGE = { like: ["赞", "b-like"], comment: ["评", "b-cmt"], bookmark: ["藏", "b-bm"],
                    follow: ["关注", "b-fl"], skip: ["滑过", "b-skip"] };

function esc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRecords(s) {
  const q = ($("recFilter").value || "").trim().toLowerCase();
  const act = ($("recAct") ? $("recAct").value : "") || "";
  const rows = (s.records || []).slice().reverse().filter((r) => {
    if (act && !(r.actions && r.actions[act])) return false;
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

const PHASE_CN = { home: "浏览时间线", explore: "发现页找用户", detail: "详情页互动", profile: "作者主页浏览",
                   notif: "看通知", notif_reply: "回复通知" };

// 日志分类 → 中文标签（和 content.js 的 guessKind 对应）
const KIND_CN = { like: "点赞", cmt: "评论", follow: "关注", skip: "滑过", fail: "失败",
                  read: "读帖", judge: "判定", nav: "导航", wait: "等待", ok: "成功", info: "信息" };

function kindColor(k) { return "lg-" + (KIND_CN[k] ? k : "info"); }

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
  // 全部历史放进可滑动区域；贴底时自动跟随，往上翻看历史时不打扰
  const acts = s.activity || [];
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  feed.innerHTML = acts.map((a) =>
    `<div class="${kindColor(a.kind)}" style="padding:1px 0">
       <span class="lgt">[${esc(a.at)}]</span> ${esc(a.msg)}</div>`).join("");
  if (nearBottom || feed.dataset.init !== "1") {
    feed.scrollTop = feed.scrollHeight;
    feed.dataset.init = "1";
  }
}

function renderLog(s) {
  const el = $("log");
  const keep = el.scrollTop;
  const follow = el.dataset.follow === "1" || Math.abs(keep + el.clientHeight - el.scrollHeight) < 60;
  const want = ($("logKind") ? $("logKind").value : "") || "";
  const acts = (s.activity || []).filter((a) => !want || a.kind === want);
  el.innerHTML = acts.length
    ? acts.map((a) => `<div class="${kindColor(a.kind)}"><span class="lgt">[${esc(a.at)}]</span> ${esc(a.msg)}</div>`).join("")
    : `<span style="color:#71767b">（${want ? "没有该类型的活动" : "还没有活动"}）</span>`;
  el.dataset.follow = follow ? "1" : "0";
  if (follow) el.scrollTop = el.scrollHeight;
}

// ---------------- 统计详情抽屉（点数字看具体做了什么）----------------

const DRILL_META = {
  like:   { title: "今日点赞", color: "b-like", field: "like" },
  reply:  { title: "今日评论/回复", color: "b-cmt", field: "reply" },
  follow: { title: "今日关注", color: "b-fl", field: "follow" },
};

async function openDrill(key) {
  const d = await chrome.storage.local.get(["xa_state"]);
  const s = d.xa_state || {};
  const recs = s.records || [], acts = s.activity || [];
  const me = key.startsWith("sess:") ? key.slice(5) : key;
  const box = $("drillBody");
  let title = "明细", sub = "", html = "";

  const rowPost = (r) => {
    const href = r.href ? (/^https?:/.test(r.href) ? r.href : "https://x.com" + r.href) : "";
    const link = href ? `<a class="lnk" href="${esc(href)}" target="_blank">@${esc(r.handle || "?")}</a>`
                      : `<b>@${esc(r.handle || "?")}</b>`;
    return `<div class="drow"><div class="t">${esc(r.at || "")}</div><div class="c">
      <div>${link} ${esc((r.author || "").slice(0, 40))}</div>
      <div class="m">${esc((r.text || "").slice(0, 220)) || "（无文字）"}</div>
      ${r.actions && r.actions.comment ? `<div class="m" style="color:#1d9bf0">评论：${esc(r.actions.comment)}</div>` : ""}
      ${r.actions && r.actions.skip ? `<div class="m" style="color:#71767b">跳过原因：${esc(r.actions.skip)}</div>` : ""}
    </div></div>`;
  };

  if (DRILL_META[me]) {
    const m = DRILL_META[me];
    title = m.title;
    // 今日事件 → 找对应帖子留档
    const t = new Date().toISOString().slice(0, 10);
    const evs = (s.events || []).filter((e) => e.kind === me && (e.at || "").startsWith(t));
    sub = `今天 ${evs.length} 条`;
    const hit = recs.filter((r) => r.actions &&
      (me === "like" ? r.actions.like : me === "reply" ? r.actions.comment : r.actions.follow)).reverse();
    html = hit.length ? hit.slice(0, 200).map(rowPost).join("")
                      : '<div class="empty">今天还没有这类记录。</div>';
  } else if (me === "records") {
    title = "帖子留档"; sub = `共 ${recs.length} 条`;
    html = recs.length ? recs.slice().reverse().slice(0, 300).map(rowPost).join("")
                       : '<div class="empty">还没有留档。</div>';
  } else if (me === "replied") {
    title = "累计已回过的帖子"; sub = `共 ${Object.keys(s.replied || {}).length} 帖`;
    const ks = Object.keys(s.replied || {}).reverse();
    html = ks.length ? ks.slice(0, 300).map((id) => {
      const v = s.replied[id] || {};
      const r = recs.find((x) => x.id === id) || {};
      return `<div class="drow"><div class="t">${esc((v.at || "").slice(11, 19))}</div><div class="c">
        <div><b>@${esc(r.handle || "?")}</b>
          <a class="lnk" href="https://x.com/i/status/${esc(id)}" target="_blank">原帖 ›</a></div>
        <div class="m">${esc((r.text || "").slice(0, 180))}</div>
        <div class="m" style="color:#1d9bf0">我回的：${esc(v.text || "")}</div></div></div>`;
    }).join("") : '<div class="empty">还没有回过帖。</div>';
  } else {
    // 会话统计各格
    const label = { read: "读帖", expanded: "展开", liked: "点赞", commented: "评论",
                    bookmarked: "收藏", followed: "关注", skipped: "滑过" }[me] || me;
    title = `本轮${label}`;
    const kindMap = { read: "read", expanded: "read", liked: "like", commented: "cmt",
                      bookmarked: "info", followed: "follow", skipped: "skip" };
    const k = kindMap[me] || me;
    const hit = acts.filter((a) => a.kind === k);
    sub = `共 ${hit.length} 条活动`;
    html = hit.length ? hit.slice().reverse().map((a) =>
      `<div class="drow"><div class="t">${esc(a.at)}</div>
         <div class="c"><div class="${kindColor(a.kind)}">${esc(a.msg)}</div></div></div>`).join("")
      : `<div class="empty">本轮还没有「${label}」记录。` +
        `<div style="margin-top:8px;font-size:12px">说明：活动日志只保留最近 300 条，` +
        `更早的明细可以在「帖子留档」里按动作筛选。</div></div>`;
  }

  $("drillTitle").textContent = title;
  $("drillSub").textContent = sub;
  box.innerHTML = html;
  $("drill").classList.add("open");
}

function closeDrill() { $("drill").classList.remove("open"); }

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
    let ping = await sendCmd("ping");
    if (!ping) {
      // 自动兜底注入：扩展重载后已开着的标签页里脚本是死的，直接补一次
      try {
        await chrome.scripting.executeScript({
          target: { tabId: xTabId },
          files: ["sop.js", "comment.js", "content.js"],
        });
        await new Promise((r) => setTimeout(r, 400));
        ping = await sendCmd("ping");
      } catch (e) { /* 下面统一提示 */ }
    }
    if (!ping) {
      stEl.innerHTML = '<span class="pill warn">页面未注入</span> 自动注入失败，点「重新注入」';
      $("start").disabled = false; $("stop").disabled = true;
    } else {
      // 显示当前登录账号，避免测试号和正式号搞混
      const acc = ping.me ? ` <span class="pill on">@${esc(ping.me)}</span>` : ' <span class="pill warn">账号未识别</span>';
      if (ping.running) {
        running = true;
        stEl.innerHTML = `<span class="pill on">会话中</span> 阶段 <code>${esc(ping.phase)}</code>${acc}`;
        $("start").disabled = true; $("stop").disabled = false;
      } else {
        stEl.innerHTML = `<span class="pill off">空闲</span> 已连接 x.com${acc}`;
        $("start").disabled = false; $("stop").disabled = true;
      }
      // ping 带回来的实时统计优先（比 storage 里的快一拍）
      if (ping.stats) lastStats = ping.stats;
    }
  }

  const d = await chrome.storage.local.get(["xa_settings", "xa_state", "xa_rounds"]);
  const cfg = { ...DEFAULTS, ...(d.xa_settings || {}) };
  const s = d.xa_state || { events: [], records: [], activity: [], replied: {} };
  renderQuota(s, cfg);
  if (!lastStats && s.stats) lastStats = s.stats;
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
$("recAct").onchange = () => refresh();
$("logKind").onchange = () => refresh();
$("clearLog").onclick = () => { $("log").textContent = "（已清空显示，新的活动会继续进来）"; };

// 统计卡片点开看明细（事件委托：卡片是 refresh 动态重绘的）
document.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-drill]");
  if (!cell) return;
  document.querySelectorAll(".stat.on").forEach((x) => x.classList.remove("on"));
  cell.classList.add("on");
  openDrill(cell.dataset.drill).catch((err) => {
    $("drillTitle").textContent = "打开失败";
    $("drillSub").textContent = String(err.message || err);
    $("drillBody").innerHTML = '<div class="empty">读取记录失败，稍后再试。</div>';
    $("drill").classList.add("open");
  });
});
$("drillClose").onclick = closeDrill;
$("drill").addEventListener("click", (e) => { if (e.target.id === "drill") closeDrill(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrill(); });

$("openCommentRule").onclick = () => chrome.windows.create({
  url: chrome.runtime.getURL("comment-rule.html"),
  type: "popup", width: 980, height: 900,
});
$("openCommentRule2").onclick = $("openCommentRule").onclick;
$("saveLlm").onclick = saveLlm;
$("clearLlm").onclick = clearLlm;
$("llm_key").oninput = updateKeyState;

loadSettings();
refresh();
setInterval(refresh, 4000);
chrome.storage.onChanged.addListener((_, area) => { if (area === "local") refresh(); });
