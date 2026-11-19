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

const CS_FILES = ["sop.js", "comment.js", "content.js"];

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

chrome.runtime.onInstalled.addListener(() => { injectAllX().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { injectAllX().catch(() => {}); });
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
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 1 });
  await sleep(rnd(60, 160) * (speed || 1));        // 按压时长
  const r = await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
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

// ---------------- 轮次调度：每 30 分钟一轮 30 分钟会话 ----------------

const ALARM = "xa-round";

async function scheduleRounds(on) {
  if (on) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 30 });
    const st = await chrome.storage.local.get(["xa_rounds"]);
    const rounds = st.xa_rounds || { done: 0 };
    rounds.next = Date.now() + 30 * 60000;
    await chrome.storage.local.set({ xa_rounds: rounds });
  } else {
    await chrome.alarms.clear(ALARM);
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const [tab] = await chrome.tabs.query({ url: "https://x.com/*" });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { t: "cmd", op: "start" }).catch(() => {});
  const st = await chrome.storage.local.get(["xa_rounds"]);
  const rounds = st.xa_rounds || { done: 0 };
  rounds.done = (rounds.done || 0) + 1; rounds.last = new Date().toLocaleString();
  rounds.next = Date.now() + 30 * 60000;
  await chrome.storage.local.set({ xa_rounds: rounds });
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
      /* 给「评论规则」窗口用：从已保存的浏览记录里随机取 N 条帖子正文，
       * 用来看提示词效果。只读，不改任何状态。
       * 只取有实际正文的（排除纯图/纯链接的短记录），并按文本去重。 */
      const st = await chrome.storage.local.get(["xa_state"]);
      const recs = (st.xa_state && st.xa_state.records) || [];
      const seen = new Set();
      const pool = [];
      for (const r of recs) {
        const text = String(r.text || "").trim();
        if (text.length < 15) continue;
        const key = text.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push({ id: r.id, handle: r.handle, text });
      }
      // 随机打乱后取前 n 条
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      reply({ ok: true, items: pool.slice(0, Math.max(1, Math.min(50, m.n || 15))) });
    } else if (m.t === "llm") {
      try { reply(await llmChat(m)); } catch (e) { reply({ __error: String(e.message || e) }); }
    } else if (m.t === "rounds") {
      await scheduleRounds(!!m.on);
      reply({ ok: true, on: !!m.on });
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
      reply({ ok: true });   // 会话到点：周期 alarm 还在，无需处理
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
