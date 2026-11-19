/* background.js —— CDP 输入层 + LLM 代发 + 轮次调度（Service Worker）
 *
 * 为什么点击/打字走这里而不是 content 的 dispatchEvent：
 *   合成事件 isTrusted=false，X 的风控能看出来。chrome.debugger 挂上后
 *   用 CDP Input.dispatch* 派发的是**浏览器级可信事件**，和 Python 版
 *   SendInput 一个级别（差别：不带贝塞尔移动过程，但轨迹抖动在这里
 *   用分步 mouseMoved 模拟）。
 *
 * 纪律（继承 Python 版踩坑）：
 *   · 只 attach debugger，不发 Page.enable / Runtime.enable —— 会触发反调试
 *   · 打字逐字符 rawKeyDown+char+keyUp，间隔 perCharMs（默认 130ms）
 *   · 滚轮按 120 单位一格，一格一格发
 *   · 中文直接走 char 事件，不走剪贴板
 */

const DBG = "xauto-cdp";
let attachedTab = null;

async function ensureAttached(tabId) {
  if (attachedTab === tabId) return true;
  try {
    if (attachedTab !== null) await chrome.debugger.detach({ tabId: attachedTab });
  } catch (e) { /* 已经掉了 */ }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTab = tabId;
    return true;
  } catch (e) {
    console.warn("debugger attach 失败:", e.message);
    return false;
  }
}

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId === attachedTab) attachedTab = null;
});

async function cdp(tabId, method, params) {
  if (!(await ensureAttached(tabId))) return null;
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params || {});
  } catch (e) {
    console.warn(`CDP ${method} 失败:`, e.message);
    return null;
  }
}

// ---------------- 自动注入兜底 ----------------
// manifest 的 content_scripts 只在**页面加载**时自动注入。真实坑：
//   · 扩展重载/更新后，已经开着的 x.com 标签页里脚本是"死的"（旧代码上下文），
//     必须重新注入才恢复 —— 这就是用户觉得"要一直点注入按钮"的原因。
// 对策：安装/更新/浏览器启动 + 标签页加载完成时都兜底注入一次。
// content.js 有 window.__XA_LOADED__ 守卫、sop/comment 用 globalThis 赋值，
// 所以重复注入是幂等的，不会重跑会话。

const CS_FILES = ["sop.js", "comment.js", "review.js", "content.js"];

async function injectTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CS_FILES });
    return true;
  } catch (e) {
    // chrome:// 页面、扩展未就绪等都会到这里，静默跳过
    return false;
  }
}

async function injectAllX() {
  const tabs = await chrome.tabs.query({ url: "https://x.com/*" });
  let n = 0;
  for (const t of tabs) if (await injectTab(t.id)) n++;
  return n;
}

chrome.runtime.onInstalled.addListener(() => { injectAllX().catch(() => {}); resumeAuto(); });
chrome.runtime.onStartup.addListener(() => { injectAllX().catch(() => {}); resumeAuto(); });

/* 浏览器/扩展重启后恢复自动任务。
 * alarms 本身会跨重启保留，但配置可能被改过、或 alarm 已被清掉，
 * 所以统一按「当前配置」重排一次，保证状态一致。 */
async function resumeAuto() {
  try {
    const cfg = await getAuto();
    if (cfg.auto_on) await scheduleNext(cfg);
    else await chrome.alarms.clear(ALARM);
  } catch (_) {}
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!/^https:\/\/x\.com\//.test(tab.url || "")) return;
  injectTab(tabId).catch(() => {});
});



const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function humanMove(tabId, x, y, speed = 1) {
  // 两段贝塞尔 + 每步抖动。speed>1 = 更慢（步间停顿乘 speed）
  const cur = (await cdp(tabId, "Runtime.evaluate", {
    expression: "window.__XA_MOUSE__ || [0,0]", returnByValue: true,
  }))?.result?.value || [0, 0];
  const [x0, y0] = typeof cur === "object" && !Array.isArray(cur) ? [0, 0] : cur;
  const steps = Math.max(10, Math.round(Math.hypot(x - x0, y - y0) / rnd(10, 20)));
  const cx1 = x0 + (x - x0) * 0.3 + rnd(-40, 40), cy1 = y0 + (y - y0) * 0.1 + rnd(-30, 30);
  const cx2 = x0 + (x - x0) * 0.7 + rnd(-25, 25), cy2 = y0 + (y - y0) * 0.9 + rnd(-15, 15);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const bx = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x;
    const by = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y;
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: Math.round(bx + rnd(-1.5, 1.5)),
      y: Math.round(by + rnd(-1.5, 1.5)), button: "none", modifiers: 0,
    });
    await sleep(rnd(10, 26) * speed);
  }
  await cdp(tabId, "Runtime.evaluate", { expression: `window.__XA_MOUSE__=[${x},${y}]` });
}

async function inputMove(tabId, x, y, speed) {
  await humanMove(tabId, x, y, speed || 1);
  return { ok: true };
}

async function inputPress(tabId, x, y, speed) {
  // 只负责按下+抬起：移动由 hoverHits 校验阶段完成，避免重复移动
  await sleep(rnd(90, 220) * (speed || 1));        // 到位后的悬停停顿
  /* modifiers 必须是 0。
   * 以前写成 1（Ctrl），在 X 上等于「Ctrl+左键」，
   * 会被当成右键/长按，弹出「管理时间线 / 移除 XX」菜单——
   * 用户看到的就是机器人点栏目时long press出那个菜单。 */
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0,
  });
  await sleep(rnd(60, 160) * (speed || 1));        // 按压时长，别太久（太久也像长按）
  const r = await cdp(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0,
  });
  return r !== null;
}

async function inputClick(tabId, x, y, speed) {
  await humanMove(tabId, x, y, speed || 1);
  return inputPress(tabId, x, y, speed);
}

async function inputWheel(tabId, x, y, notches, speed) {
  await humanMove(tabId, x, y, speed || 1);
  for (let i = 0; i < Math.abs(notches); i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0,
      deltaY: notches > 0 ? -120 : 120,
    });
    await sleep(rnd(90, 280) * (speed || 1));
  }
  return { ok: true };
}

async function inputType(tabId, text, perCharMs) {
  const ms = perCharMs || 130;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const base = { text: ch, unmodifiedText: ch };
    if (code >= 0x20) {
      base.key = ch; base.code = "KeyU"; base.keyCode = code; base.windowsVirtualKeyCode = code;
    }
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(rnd(ms * 0.6, ms * 1.4));          // 抖动：不是节拍器
  }
  return { ok: true };
}

const KEYMAP = {
  ctrl: ["Control", "ControlLeft", 17], enter: ["Enter", "Enter", 13],
  backspace: ["Backspace", "Backspace", 8], a: ["a", "KeyA", 65],
  v: ["v", "KeyV", 86], c: ["c", "KeyC", 67], x: ["x", "KeyX", 88],
};

async function inputHotkey(tabId, keys) {
  const mods = keys.includes("ctrl") ? 2 : 0;
  const main = keys.filter((k) => k !== "ctrl")[0];
  const m = KEYMAP[main] || [];
  if (!m.length) return { ok: false };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: mods });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: m[0], code: m[1], windowsVirtualKeyCode: m[2], modifiers: mods });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: m[0], code: m[1], windowsVirtualKeyCode: m[2], modifiers: mods });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 });
  return { ok: true };
}

// ---------------- LLM 代发（内容脚本 fetch 会被 CORS 拦）----------------

async function llmChat({ system, user, cfg }) {
  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.9, max_tokens: 200,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
  const j = await resp.json();
  return (j.choices?.[0]?.message?.content || "").trim();
}

// ---------------- 轮次调度：在随机区间内自动开新一轮 ----------------
/* 用户要求：不能定死一个时间，要是随机动态范围。
 *
 * 为什么必须随机：固定间隔（每 30 分钟整）在平台侧看就是脚本特征——
 * 行为间隔的方差接近 0，人做不到。所以每轮结束后重新掷一次随机值。
 *
 * chrome.alarms 单次只设一个时间点，所以不用 periodInMinutes，
 * 而是每轮结束时用 when 指定下一次的绝对时间，形成随机间隔的滚动链。
 */

const ALARM = "xa-round";
const AUTO_DEFAULTS = {
  auto_on: false,
  auto_min: 40,        // 最短间隔（分钟）
  auto_max: 110,       // 最长间隔（分钟）
  auto_quiet_start: 1, // 安静时段开始（1 点）
  auto_quiet_end: 8,   // 安静时段结束（8 点）—— 深夜不动，像人一样
  auto_jitter: true,   // 区间内随机（关掉则用中点固定值）
  auto_max_rounds: 0,  // 0 = 不限轮数
};

// 在 [lo, hi] 里随机一个整数分钟
function pickGap(min, max, jitter) {
  const lo = Math.max(1, Math.round(min || 40));
  const hi = Math.max(lo, Math.round(max || 110));
  if (!jitter) return Math.round((lo + hi) / 2);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/* 把「从现在起 N 分钟后」调整到安静时段之外。
 * 人不会每天凌晨 3 点准时发帖，深夜执行反而是最明显的机器特征。 */
function avoidQuiet(ts, qStart, qEnd) {
  const d = new Date(ts);
  const h = d.getHours();
  const s = Number(qStart), e = Number(qEnd);
  if (!(s < e) || s === e) return ts;        // 时段无效或全天不禁 → 不改
  if (h >= s && h < e) {
    // 落在安静时段里 → 推到今天/明天的结束点，再加一点随机偏移
    d.setHours(e, Math.floor(Math.random() * 40), 0, 0);
    if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return ts;
}

async function getAuto() {
  const st = await chrome.storage.local.get(["xa_settings"]);
  return { ...AUTO_DEFAULTS, ...((st.xa_settings || {}).auto || {}) };
}

/* 排下一次。返回下一次的时间戳。 */
async function scheduleNext(cfg) {
  const c = cfg || await getAuto();
  if (!c.auto_on) { await chrome.alarms.clear(ALARM); return 0; }

  // 轮数上限到了就停
  if (c.auto_max_rounds > 0) {
    const st = await chrome.storage.local.get(["xa_auto_state"]);
    const done = (st.xa_auto_state || {}).done || 0;
    if (done >= c.auto_max_rounds) {
      await chrome.alarms.clear(ALARM);
      await chrome.storage.local.set({
        xa_auto_state: { ...(st.xa_auto_state || {}), running: false, stopped: "轮数已达上限" },
      });
      return 0;
    }
  }

  const gap = pickGap(c.auto_min, c.auto_max, c.auto_jitter !== false);
  let when = Date.now() + gap * 60000;
  when = avoidQuiet(when, c.auto_quiet_start, c.auto_quiet_end);

  /* 兜底：间隔不能短于会话时长，否则下一轮会在上一轮还没跑完时就开。
   * 会话时长本身是随机的（18~45 分钟），这里按最大值算，避免踩线。 */
  const stS = await chrome.storage.local.get(["xa_settings"]);
  const ss = stS.xa_settings || {};
  const maxDur = Math.max(3, Math.round(ss.session_max_min || ss.session_minutes || 30));
  const floor = Date.now() + (maxDur + 3) * 60000;
  if (when < floor) when = floor + Math.floor(Math.random() * 5) * 60000;

  // 晚于 1 分钟才有效（chrome.alarms 要求未来时间）
  when = Math.max(when, Date.now() + 60000);
  await chrome.alarms.create(ALARM, { when });

  const prev = (await chrome.storage.local.get(["xa_auto_state"])).xa_auto_state || {};
  await chrome.storage.local.set({
    xa_auto_state: {
      ...prev,
      running: true,
      stopped: "",
      nextAt: when,
      nextIn: Math.round((when - Date.now()) / 60000),
      plannedGap: gap,
      updatedAt: new Date().toLocaleString(),
    },
  });
  return when;
}

async function scheduleRounds(on) {
  if (!on) {
    await chrome.alarms.clear(ALARM);
    const st = await chrome.storage.local.get(["xa_settings"]);
    const s = st.xa_settings || {};
    if (s.auto) { s.auto.auto_on = false; await chrome.storage.local.set({ xa_settings: s }); }
    await chrome.storage.local.set({
      xa_auto_state: { ...((await chrome.storage.local.get(["xa_auto_state"])).xa_auto_state || {}),
                       running: false, stopped: "手动关闭" },
    });
    return 0;
  }
  const st = await chrome.storage.local.get(["xa_settings"]);
  const s = st.xa_settings || {};
  s.auto = { ...AUTO_DEFAULTS, ...(s.auto || {}), auto_on: true };
  await chrome.storage.local.set({ xa_settings: s });
  return scheduleNext(s.auto);
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const [tab] = await chrome.tabs.query({ url: "https://x.com/*" });
  const st0 = await chrome.storage.local.get(["xa_auto_state"]);
  const prev = st0.xa_auto_state || {};

  if (!tab) {
    // 没有 x.com 标签页就跑不了，但不要放弃整个计划，继续排下一轮
    await chrome.storage.local.set({
      xa_auto_state: { ...prev, last: new Date().toLocaleString(), lastResult: "没有打开的 x.com 标签页，跳过" },
    });
    await scheduleNext();
    return;
  }

  /* 上一轮还没跑完就不要叠着开新的。
   * 会话时长（默认 30 分钟）可能比最小间隔还长，不检查就会两个会话同时操作页面。 */
  const stRun = await chrome.storage.local.get(["xa_state"]);
  const running = !!(stRun.xa_state && stRun.xa_state.running);
  if (running) {
    await chrome.storage.local.set({
      xa_auto_state: { ...prev, last: new Date().toLocaleString(), lastResult: "上一轮还在跑，跳过这次" },
    });
    await scheduleNext();
    return;
  }

  chrome.tabs.sendMessage(tab.id, { t: "cmd", op: "start" }).catch(() => {});
  const done = (prev.done || 0) + 1;
  await chrome.storage.local.set({
    xa_auto_state: { ...prev, done, last: new Date().toLocaleString(), lastResult: "已开始新一轮" },
  });
  await scheduleNext();
});

// ---------------- 消息路由 ----------------

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    const tabId = m.tabId ?? sender.tab?.id ?? null;
    if (m.t === "input" && tabId !== null) {
      if (m.op === "click") reply(await inputClick(tabId, m.x, m.y, m.speed));
      else if (m.op === "move") reply(await inputMove(tabId, m.x, m.y, m.speed));
      else if (m.op === "press") reply(await inputPress(tabId, m.x, m.y, m.speed));
      else if (m.op === "wheel") reply(await inputWheel(tabId, m.x, m.y, m.notches, m.speed));
      else if (m.op === "type") reply(await inputType(tabId, m.text, m.perCharMs));
      else if (m.op === "hotkey") reply(await inputHotkey(tabId, m.keys));
      else reply({ ok: false });
    } else if (m.t === "get_posts_sample") {
      /* 给「评论规则」窗口用：从已保存的浏览记录里随机取 N 条帖子正文。
       * 两个数据源合并：
       *   seenTweets —— 运行时读到的所有帖子（量大，主力来源）
       *   records    —— 处理过的帖子（有动作标记，量少但正文全）
       * 只读，不改任何状态。 */
      const st = await chrome.storage.local.get(["xa_state"]);
      const S = st.xa_state || {};
      const seenT = S.seenTweets ? Object.values(S.seenTweets) : [];
      const recs = S.records || [];
      const seenText = new Set();
      const pool = [];

      const add = (r) => {
        const text = String(r.text || "").trim();
        if (text.length < 15) return;                 // 排除纯图/纯链接
        const key = text.slice(0, 40);                // 按正文前缀去重
        if (seenText.has(key)) return;
        seenText.add(key);
        pool.push({ id: r.id, handle: r.handle, text });
      };

      // seenTweets 优先（新数据源，量大）
      for (const r of seenT) add(r);
      for (const r of recs) add(r);

      // Fisher-Yates 随机打乱后取前 n 条
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      reply({ ok: true, items: pool.slice(0, Math.max(1, Math.min(50, m.n || 15))),
              total: pool.length });
    } else if (m.t === "llm") {
      try { reply(await llmChat(m)); } catch (e) { reply({ __error: String(e.message || e) }); }
    } else if (m.t === "rounds") {
      const when = await scheduleRounds(!!m.on);
      reply({ ok: true, on: !!m.on, nextAt: when });
    } else if (m.t === "auto_get") {
      const cfg = await getAuto();
      const st = await chrome.storage.local.get(["xa_auto_state"]);
      const alarm = await chrome.alarms.get(ALARM);
      reply({ ok: true, cfg, state: st.xa_auto_state || {},
              nextAt: alarm ? alarm.scheduledTime : 0, on: !!alarm });
    } else if (m.t === "auto_set") {
      // 存配置并按新配置重排下一次
      const st = await chrome.storage.local.get(["xa_settings"]);
      const s = st.xa_settings || {};
      s.auto = { ...AUTO_DEFAULTS, ...(s.auto || {}), ...(m.cfg || {}) };
      await chrome.storage.local.set({ xa_settings: s });
      if (m.resetCount) {
        await chrome.storage.local.set({ xa_auto_state: { done: 0 } });
      }
      const when = await scheduleNext(s.auto);
      reply({ ok: true, nextAt: when });
    } else if (m.t === "auto_stop") {
      await scheduleRounds(false);
      reply({ ok: true });
    } else if (m.t === "open-dashboard") {
      await chrome.windows.create({ url: chrome.runtime.getURL("dashboard.html"),
                                   type: "popup", width: 1180, height: 860 });
      reply({ ok: true });
    } else if (m.t === "rounds-status") {
      const st = await chrome.storage.local.get(["xa_rounds"]);
      reply(st.xa_rounds || { done: 0 });
    } else if (m.t === "ui-ping") {
      reply({ ok: true });   // content 记了活动，面板自己会拉
    } else if (m.t === "round-done") {
      /* 会话结束 → 立刻排下一轮。
       * 关键：间隔必须从「这一轮真正结束」开始算，而不是从上一轮开始时算。
       * 否则会话时长一变，间隔就跟着被动变化，容易出现「刚跑完马上又开」。
       * 这里重排一次，把基准点挪到结束时刻。 */
      const st = await chrome.storage.local.get(["xa_auto_state"]);
      const prev = st.xa_auto_state || {};
      await chrome.storage.local.set({
        xa_auto_state: { ...prev, lastEnd: new Date().toLocaleString() },
      });
      const cfg = await getAuto();
      if (cfg.auto_on) await scheduleNext(cfg);
      reply({ ok: true, rescheduled: !!cfg.auto_on });
    } else {
      reply({ ok: false, error: "unknown" });
    }
  })();
  return true;   // 异步 reply
});

chrome.action.onClicked.addListener(async () => {
  // 点图标 = 打开控制台窗口（已开则聚焦，不重复开）
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    const d = (w.tabs || []).find((t) => (t.url || "").includes("dashboard.html"));
    if (d) { await chrome.windows.update(w.id, { focused: true }); await chrome.tabs.update(d.id, { active: true }); return; }
  }
  await chrome.windows.create({ url: chrome.runtime.getURL("dashboard.html"),
                               type: "popup", width: 1180, height: 860 });
});
