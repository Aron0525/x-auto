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

// ---------------- 拟人输入 ----------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

async function humanMove(tabId, x, y) {
  // 两段贝塞尔 + 每步抖动，45~120 步/秒的节奏
  const cur = (await cdp(tabId, "Runtime.evaluate", {
    expression: "window.__XA_MOUSE__ || [0,0]", returnByValue: true,
  }))?.result?.value || [0, 0];
  const [x0, y0] = typeof cur === "object" && !Array.isArray(cur) ? [0, 0] : cur;
  const steps = Math.max(8, Math.round(Math.hypot(x - x0, y - y0) / rnd(12, 25)));
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
    await sleep(rnd(8, 22));
  }
  await cdp(tabId, "Runtime.evaluate", { expression: `window.__XA_MOUSE__=[${x},${y}]` });
}

async function inputClick(tabId, x, y) {
  await humanMove(tabId, x, y);
  await sleep(rnd(80, 280));                 // 到位后停一下（人的悬停）
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 1 });
  await sleep(rnd(45, 130));                 // 按压时长
  const r = await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0 });
  return r !== null;
}

async function inputWheel(tabId, x, y, notches) {
  await humanMove(tabId, x, y);
  for (let i = 0; i < Math.abs(notches); i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0,
      deltaY: notches > 0 ? -120 : 120,
    });
    await sleep(rnd(60, 220));
  }
  return { ok: true };
}

async function inputType(tabId, text, perCharMs) {
  const ms = perCharMs || 130;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const base = { text: ch, unmodifiedText: ch };
    if (code >= 0x20) {
      // 控制字符（\n 等）不发 keydown 的 keyCode，避免触发快捷键
      base.key = ch; base.code = "KeyU"; base.keyCode = code; base.windowsVirtualKeyCode = code;
    }
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(rnd(ms * 0.6, ms * 1.4));    // 抖动：不是节拍器
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
      if (m.op === "click") reply(await inputClick(tabId, m.x, m.y));
      else if (m.op === "wheel") reply(await inputWheel(tabId, m.x, m.y, m.notches));
      else if (m.op === "type") reply(await inputType(tabId, m.text, m.perCharMs));
      else if (m.op === "hotkey") reply(await inputHotkey(tabId, m.keys));
      else reply({ ok: false });
    } else if (m.t === "llm") {
      try { reply(await llmChat(m)); } catch (e) { reply({ __error: String(e.message || e) }); }
    } else if (m.t === "rounds") {
      await scheduleRounds(!!m.on);
      reply({ ok: true, on: !!m.on });
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.sidePanel.open({ windowId: tab.windowId });
});
