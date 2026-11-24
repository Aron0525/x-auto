/* content.js —— 页面操作 + 会话状态机（Python 版 pages/x_twitter.py + tools/x_session.py 的移植）
 *
 * 分工：
 *   · 本文件只碰 DOM：读帖、找元素、算坐标；所有「点击/打字/滚轮」经
 *     background 的 CDP Input 派发（可信事件，带贝塞尔轨迹 / 逐字 130ms）。
 *   · 会话循环跑在页面里（content 有 setInterval 不被回收），状态存
 *     sessionStorage —— 点进详情页/主页发生导航后，新页面的 content 恢复续跑。
 *   · 导航纪律同 Python 版：只点界面元素（左栏/帖子/返回箭头），不拼 URL。
 */
(() => {
  if (window.__XA_LOADED__) return;
  window.__XA_LOADED__ = true;

  let aborted = false;        // 停止标志（提前声明：sleep 要用）
  let timer = null;           // 主循环定时器（提前声明：startSession/stopSession 要用）

  /* 可中断的 sleep —— 全项目所有等待点都走它。
   * 停止时（aborted=true）立即抛 AbortError，而不是傻等完剩下的毫秒。
   * 这是「点了停止还在动」的核心修复：以前 sleep 只是 setTimeout，
   * 停止信号要等当前步骤所有 sleep 跑完才生效。 */
  const ABORT = Symbol("aborted");
  const sleep = (ms) => new Promise((resolve, reject) => {
    if (aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const total = Math.max(0, ms);
    const tick = 120;                          // 每 120ms 检查一次停止标志
    const start = Date.now();
    const step = () => {
      if (aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      const left = total - (Date.now() - start);
      if (left <= 0) return resolve();
      setTimeout(step, Math.min(tick, left));
    };
    setTimeout(step, Math.min(tick, total));
  });
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
  /* 所有输入类消息（点击/滚动/打字）在发出去之前都检查停止标志 ——
   * 停止后一毫秒都不该再动页面。日志类消息不拦。 */
  const send = (m) => {
    if (aborted && m && m.t === "input") {
      return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
    return chrome.runtime.sendMessage(m);
  };

  const SEL = {
    article: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    editor: 'div[contenteditable="true"][data-testid^="tweetTextarea_"]',
    submit: '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]',
    like: '[data-testid="like"]',
    unlike: '[data-testid="unlike"]',        // 已赞态：点赞后验证按钮翻转用
    liked: '[data-testid="unlike"]',
    replyBtn: '[data-testid="reply"]',
    bookmark: '[data-testid="bookmark"]',
    bookmarked: '[data-testid="unbookmark"]',
    back: '[data-testid="app-bar-back"]',
    cell: '[data-testid="cellInnerDiv"]',
    userNameLink: '[data-testid="User-Name"] a[role="link"]',
    bio: '[data-testid="ProfileBio"]',
    follow: '[data-testid$="-follow"]',
    unfollow: '[data-testid$="-unfollow"]',
    navHome: '[data-testid="AppTabBar_Home_Link"]',
    navNotif: '[data-testid="AppTabBar_Notifications_Link"]',
    tab: '[role="tab"]',
    appClose: '[data-testid="app-bar-close"]',
    userCell: '[data-testid="UserCell"]',   // 详情页右侧 Relevant People 的作者行
    navExplore: '[data-testid="AppTabBar_Explore_Link"]',
    // 长文折叠的「显示更多」——中英文界面都是同一个 data-testid，但要按文案兜底
    showMore: '[data-testid="tweet-text-show-more-link"]',
    // 顶部「新帖」提示条：优先 data-testid（界面语言无关），aria-label 只作兜底
    newPostsBtn: '[data-testid="newTweetsPill"], [data-testid="floatingButton"], [data-testid="scrollToTopButton"], [aria-label="New posts"], [aria-label="新帖子"], [aria-label="已发布"]',
    // 时间线顶部的「Show N posts」按钮（有新帖待加载时出现），点它直接拉新一批
    showPostsBtn: '[data-testid="newTweetsPill"], [data-testid="pillButton"], button[aria-label*="posts"], button[aria-label*="帖子"]',
  };

  const DISCARD_TEXTS = ["不保存", "放弃", "丢弃", "Discard", "Don't save"];

  // ---------------- 基础动作 ----------------

  let SPD = 1.5;                          // 速度系数：1=原速，1.5=慢一半（面板可调）
  // 落点系统性偏移（页面缩放/滚动造成）；hoverUnavailable=后台标签页 :hover 不可用时退回不校验
  const _off = { dx: 0, dy: 0, calibrated: false, hoverUnavailable: false };

  async function waitFor(fn, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(300);
    }
    return false;
  }

  async function stableRect(el) {
    // 滚到视口中部并等滚动稳定（Python 版踩过的坑：滚动中读坐标是过渡值）
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(450 * SPD);
    let r = el.getBoundingClientRect();
    for (let i = 0; i < 5; i++) {
      await sleep(250 * SPD);
      const r2 = el.getBoundingClientRect();
      if (Math.abs(r2.x - r.x) < 1 && Math.abs(r2.y - r.y) < 1) { r = r2; break; }
      r = r2;
    }
    return r;
  }

  async function hoverHits(el, x, y) {
    // 落点校验：把鼠标移过去后，看目标元素是否真的进入 :hover 链。
    // CDP 坐标与 CSS 坐标在页面缩放/滚动异常时有系统性偏差——不校验就点，
    // 就是之前「反复点同一处空点」的根因（Python 版靠 :hover 扫描标定解决）。
    // 注意：标签页不可见时 :hover 可能永远不亮，连续 3 次全失败则退回直点模式。
    if (_off.hoverUnavailable) { await send({ t: "input", op: "move", x, y, speed: SPD }); return true; }
    await send({ t: "input", op: "move", x, y, speed: SPD });
    await sleep(rnd(160, 320) * SPD);
    let hit = false;
    try { hit = el.matches(":hover"); } catch (e) { hit = false; }
    if (hit) { _off.hoverFails = 0; return true; }
    _off.hoverFails = (_off.hoverFails || 0) + 1;
    if (_off.hoverFails >= 3) {
      _off.hoverUnavailable = true;
      await logAct("⚠ :hover 始终不亮（标签页可能不可见），落点校验退回直点模式");
    }
    return false;
  }

  async function scanForHit(el, cx, cy, radius, step) {
    const cand = [];
    for (let ry = -radius; ry <= radius; ry += step)
      for (let rx = -radius; rx <= radius; rx += step)
        if (rx || ry) cand.push([rx * rx + ry * ry, rx, ry]);
    cand.sort((a, b) => a[0] - b[0]);           // 由近及远：偏移一般不大
    for (const [, rx, ry] of cand) {
      if (await hoverHits(el, cx + rx + _off.dx, cy + ry + _off.dy))
        return { x: cx + rx + _off.dx, y: cy + ry + _off.dy, dx: rx, dy: ry };
    }
    return null;
  }

  /* 落点标定：现在**不再依赖 :hover**。
   * 每个点击都会用 elementFromPoint 逐个校验（见 clickEl），
   * 所以这里只把偏移清零即可。以前那套 :hover 标定在标签页不可见时
   * 永远失败，还会打出「退回直点模式」的误导日志。 */
  async function calibrateOffset() {
    _off.dx = 0;
    _off.dy = 0;
    _off.calibrated = true;
    return true;
  }

  async function clickEl(el, opts = {}) {
    if (!el) return false;
    checkAbort();                    // 停止后不再发起新的点击
    const r = await stableRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let x = cx + _off.dx, y = cy + _off.dy;

    /* 几何命中校验：用 elementFromPoint 判断落点是否真的在这个元素上。
     * 它不依赖 :hover 渲染——标签页在后台时 :hover 永远不亮，
     * 旧代码会退回「直点模式」完全不校验，带着偏移盲点，很容易点错。 */
    const geoHit = (px, py) => {
      const t = document.elementFromPoint(px, py);
      return !!t && (el === t || el.contains(t) || t.contains(el));
    };

    if (!geoHit(x, y)) {
      // 偏移可能已经偏了：清零回到中心重试
      _off.dx = 0; _off.dy = 0;
      x = cx; y = cy;
      if (!geoHit(x, y)) {
        // 在元素矩形内部小范围找落点（最多到边框内 2px）
        const maxD = Math.max(2, Math.min(r.width, r.height) / 2 - 2);
        let found = false;
        for (let d = 2; d <= maxD && !found; d += 2) {
          for (const [ox, oy] of [[0, -d], [0, d], [-d, 0], [d, 0],
                                  [d, d], [-d, -d], [d, -d], [-d, d]]) {
            const px = Math.min(r.right - 2, Math.max(r.left + 2, cx + ox));
            const py = Math.min(r.bottom - 2, Math.max(r.top + 2, cy + oy));
            if (geoHit(px, py)) { x = px; y = py; found = true; break; }
          }
        }
        if (!found) {
          await logAct("落点校验失败：鼠标移不到目标上，跳过这次点击");
          return false;
        }
      }
    }
    await send({ t: "input", op: "press", x, y, speed: SPD });
    await sleep(opts.settle ? rnd(opts.settle[0] * SPD, opts.settle[1] * SPD)
                           : rnd(600, 1300) * SPD);
    return true;
  }

  const q = (sel) => document.querySelector(sel);
  const clickSel = (sel, opts) => clickEl(q(sel), opts);

  async function scrollBy(notches) {
    // 正数向下、负数向上（看上文）；先把鼠标放到内容区再滚，和真人一致
    checkAbort();
    const anchor = q(SEL.article) || q(SEL.cell) || document.body;
    const r = await stableRect(anchor);
    await send({ t: "input", op: "wheel",
                 x: Math.min(innerWidth - 80, Math.max(80, r.left + r.width / 2)),
                 y: Math.min(innerHeight - 60, Math.max(60, r.top + r.height / 2)),
                 notches: -notches, speed: SPD });
    await sleep(rnd(600, 1200) * SPD);
  }

  // ---------------- 加载监控（慢网适配） ----------------
  // 用户网速慢：点击/滚动后 DOM 不会立刻更新。不等就动手 = 在旧页面上点新页面的坐标。

  function timelineSig(sel) {
    const els = [...document.querySelectorAll(sel || SEL.article)];
    return els.length + "|" + (els[0] ? norm(els[0].innerText).slice(0, 48) : "");
  }

  function pageLoading() {
    /* 只认**可见**的加载转圈。
     * 旧写法只要 DOM 里存在 progressbar 就返回 true——但 X 会保留隐藏的
     * 转圈节点（例如列表底部的占位），导致 waitContent 每次都等满 25 秒超时。
     * 这就是「切栏目永远超时 → 守卫每 1.5 秒又触发一次」死循环的来源。
     * 视频音量条也带 progressbar，但都带 aria-valuenow，已排除。 */
    const bars = [...document.querySelectorAll('[role="progressbar"]:not([aria-valuenow])')];
    return bars.some((b) => {
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;          // 隐藏/占位
      if (r.bottom < 0 || r.top > innerHeight) return false;  // 滚出视口
      return true;
    });
  }

  async function waitContent(minCount = 1, timeoutMs = 25000, label = "页面", sel = SEL.article) {
    // 等转圈消失 + 内容出现且数量稳定（连续两次轮询不变）——渲染完成的近似信号
    const end = Date.now() + timeoutMs;
    let last = -1, stable = 0, warned = false;
    while (Date.now() < end) {
      const n = document.querySelectorAll(sel).length;
      if (!pageLoading() && n >= minCount && n === last) { stable++; if (stable >= 2) return true; }
      else stable = 0;
      last = n;
      if (!warned && Date.now() > end - timeoutMs + 8000) {
        warned = true;
        await logAct(`${label}加载较慢，继续等待渲染…（当前 ${n} 条）`);
      }
      await sleep(900);
    }
    await logAct(`${label}等待超时（${timeoutMs / 1000}s），按当前状态继续`);
    return false;
  }

  async function waitTimelineChange(beforeSig, timeoutMs = 15000, label = "页面", sel = SEL.article) {
    // 等内容真的变了（条数或首条文本变化）——切 tab / 导航后用
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (timelineSig(sel) !== beforeSig && !pageLoading()) { await sleep(rnd(500, 1000) * SPD); return true; }
      await sleep(800);
    }
    return false;   // 没变化不一定是错（同页重进），调用方自行判断
  }

  async function waitMoreArticles(prevCount, timeoutMs = 15000) {
    // 滚动后等新帖子追加（慢网时滚动会触发分页请求，DOM 要过几秒才变）
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (document.querySelectorAll(SEL.article).length > prevCount) return true;
      await sleep(900);
    }
    return false;
  }

  /* 遇到重复/旧帖子时的处理（用户明确的三级顺序）：
   *   1) 一直往下滑，直到滑出新帖子
   *   2) 滑不出来 → 点主页横幅下方的「Show N posts」/「新帖」按钮刷新
   *   3) 还不行 → 点左侧栏「主页」重新进首页，回主流程再走一遍
   * 返回 "scrolled" | "posts" | "home" | "timeout"。 */
  async function refreshOrTop(reason) {
    /* 【用户明确要求】没有帖子时 = 双击左侧栏「主页」刷新。
     *
     * 顺序调整为：
     *   ① 双击主页（首选，最接近真人操作：没内容了就双击主页签重载）
     *   ② 点「Show N posts」/「新帖」按钮
     *   ③ 往下滑（老内容还可能没翻完）
     * 以前是先死命往下滑 8 次才回头看按钮，用户看到的就是"卡住不动"。 */
    const before = timelineSig();

    // ---- 1) 双击主页（首选）----
    await logAct(`${reason} → 双击左侧栏「主页」刷新`, "nav");
    if (await doubleClickNav(SEL.navHome, "首页")) {
      if (timelineSig() !== before) return "home";
    }

    // ---- 2) 点横幅「Show N posts」/「新帖」按钮 ----
    const pill = findNewPostsPill();
    if (pill && await clickEl(pill, { settle: [1500, 2600] })) {
      const label = (pill.innerText || "").trim().slice(0, 24) || "新帖";
      await logAct(`${reason} → 点「${label}」刷新`, "nav");
      await sleep(rnd(1200, 2200) * SPD);
      if (await waitTimelineChange(before, 15000, "点按钮刷新")) return "posts";
    }
    const arrow = q(SEL.newPostsBtn);
    if (arrow && await clickEl(arrow, { settle: [1500, 2600] })) {
      await logAct(`${reason} → 点顶部「新帖」箭头刷新`, "nav");
      await sleep(rnd(1200, 2200) * SPD);
      if (await waitTimelineChange(before, 15000, "顶部刷新")) return "posts";
    }

    // ---- 3) 往下滑（老内容可能还没翻完）----
    let lastCount = document.querySelectorAll(SEL.article).length;
    for (let i = 0; i < 8; i++) {
      await scrollBy(ri(2, 4));
      const grown = await waitMoreArticles(lastCount, 6000);
      if (grown) {
        lastCount = document.querySelectorAll(SEL.article).length;
        if (timelineSig() !== before) {
          await logAct(`${reason} → 继续往下滑，滑出了新内容`, "nav");
          return "scrolled";
        }
        continue;
      }
      await sleep(rnd(800, 1600) * SPD);
    }
    return "timeout";
  }

  /* 双击导航按钮 = 刷新时间线（用户明确要求）。
   * 单击只是"回到顶部"，只有双击才会重新加载。
   * 关键：两次点击之间**不能移动鼠标**，否则浏览器当成两次独立单击。
   * 所以不在 content 里连调两次 clickEl，走 background 的 dblclick 原语。
   * 落点用 elementFromPoint 校验（不用 _off，理由同 clickNavExact：
   * 偏移会把「主页」点成下面的「探索」）。 */
  async function doubleClickNav(sel, label) {
    const el = q(sel);
    if (!el) { await logAct(`找不到「${label}」按钮`, "wait"); return false; }
    checkAbort();
    const r = await stableRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hitTarget = (x, y) => {
      const t = document.elementFromPoint(x, y);
      if (!t) return false;
      return el === t || el.contains(t) || t.contains(el);
    };
    const cand = [[0, 0]];
    for (const d of [3, 6, 10]) cand.push([0, -d], [0, d], [-d, 0], [d, 0]);
    for (const [dx, dy] of cand) {
      const x = Math.min(r.right - 2, Math.max(r.left + 2, cx + dx));
      const y = Math.min(r.bottom - 2, Math.max(r.top + 2, cy + dy));
      if (!hitTarget(x, y)) continue;
      await send({ t: "input", op: "dblclick", x, y, speed: SPD });
      await sleep(rnd(1500, 2600) * SPD);
      return true;
    }
    await logAct(`「${label}」双击落点校验失败：那个位置不是它，跳过`, "wait");
    return false;
  }

  /* 全文读取：时间线卡片里长文默认折叠（Show more）。
   * 展开链接点一次即全文渲染，读完后点回去收起，保持页面原样。
   * 返回全文文本；展开失败就回退为卡片内可见文本。 */
  async function fullTextOf(article, timeoutMs = 12000) {
    const tx = article.querySelector(SEL.tweetText);
    if (!tx) return "";
    const visible = norm(tx.innerText);
    const link = article.querySelector(SEL.showMore);
    if (!link) return visible;
    if (!(await clickEl(link, { settle: [500, 900] }))) return visible;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const t = norm(tx.innerText);
      // 展开成功信号：文本变长且不再含「显示更多」提示
      if (t.length > visible.length && !/显示更多|Show more/i.test(t)) return t;
      await sleep(500);
    }
    // 展开失败回退：点回收起（找不到就不动），用可见文本
    const back = article.querySelector(SEL.showMore);
    if (back && back.isConnected) { try { back.click(); } catch (e) {} }
    return visible;
  }

  async function typeInto(el, text, beh) {
    if (!el) return false;
    if (!(await clickEl(el, { settle: [350, 700] }))) return false;
    await send({ t: "input", op: "hotkey", keys: ["ctrl", "a"] });
    await send({ t: "input", op: "hotkey", keys: ["backspace"] });
    await sleep(rnd(200, 400) * SPD);
    const res = await send({ t: "input", op: "type", text,
                             perCharMs: beh.typing_ms || 130 });
    await sleep(rnd(300, 600) * SPD);
    return !!(res && res.ok);
  }

  const editorText = () => {
    const el = q(SEL.editor);
    return el ? norm(el.innerText) : "";
  };

  async function discardDrafts() {
    const el = q(SEL.editor);
    if (el && norm(el.innerText)) {
      await clickSel(SEL.appClose);
      for (const t of DISCARD_TEXTS) {
        const btn = [...document.querySelectorAll('[role="button"]')]
          .find((b) => (b.innerText || "").includes(t));
        if (btn) { await clickEl(btn); break; }
      }
      await sleep(rnd(400, 800) * SPD);
    }
  }

  /* 通用「精确点击」：不用 _off 偏移，用 elementFromPoint 校验落点。
   * 适用于侧栏项、栏目 tab 这类**彼此紧挨着**的目标——
   * 偏移一旦积累，主页会点到探索、为你推荐会点到创业公司。 */
  async function clickExact(el, label = "", settle = [1200, 2200]) {
    if (!el) return false;
    checkAbort();
    const r = await stableRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hitTarget = (x, y) => {
      const t = document.elementFromPoint(x, y);
      if (!t) return false;
      return el === t || el.contains(t) || t.contains(el);
    };
    const cand = [[0, 0]];
    for (const d of [3, 6, 10]) cand.push([0, -d], [0, d], [-d, 0], [d, 0]);
    for (const [dx, dy] of cand) {
      const x = Math.min(r.right - 2, Math.max(r.left + 2, cx + dx));
      const y = Math.min(r.bottom - 2, Math.max(r.top + 2, cy + dy));
      if (!hitTarget(x, y)) continue;
      await send({ t: "input", op: "press", x, y, speed: SPD });
      await sleep(rnd(settle[0] * SPD, settle[1] * SPD));
      return true;
    }
    await logAct(`「${label || (el.innerText || "").trim().slice(0, 12)}」落点校验失败：那个位置不是它，跳过`, "wait");
    return false;
  }

  async function clickNav(sel, label = "页面", waitSel = SEL.article) {
    await discardDrafts();
    const before = timelineSig(waitSel);
    if (!(await clickNavExact(sel, label))) return false;
    // 慢网适配：SPA 换页后必须等新内容渲染完再动手
    await waitContent(1, 25000, label, waitSel);
    await waitTimelineChange(before, 15000, label, waitSel);
    return true;
  }

  /* ---------- 侧栏导航精确点击 ----------
   *
   * 事故：点「主页」经常点成「探索」。
   * 原因：侧栏各项上下相邻（主页/探索只隔约 48px），而通用 clickEl 会带上
   *       全局累积偏移 _off.dy；一旦 :hover 校验失效（标签页不可见时 :hover
   *       永远不亮 → 退回直点模式），这个偏移就把落点整体下移，正好压到「探索」。
   *
   * 现在导航点击完全不用 _off，改用**几何命中校验**：
   *   document.elementFromPoint(x,y) 必须落在这个导航元素（或它的子孙）上才点。
   * 这个校验不依赖 :hover 渲染，标签页在后台也准确。 */
  async function clickNavExact(sel, label = "") {
    const el = q(sel);
    if (!el) { await logAct(`找不到「${label || sel}」按钮`, "wait"); return false; }
    return await clickExact(el, label || sel, [1200, 2200]);
  }
  /* 回首页。优先点导航栏（人类行为）；点不到就直接改地址兜底。
   * 发现页加载失败时导航栏可能也是空的，只靠点击会卡在原地。 */
  async function goHome() {
    const ok = await clickNav(SEL.navHome, "首页");
    if (ok && onHome()) return true;
    if (onHome()) return true;
    await logAct("导航栏回不到首页 → 直接跳转 /home", "nav");
    location.assign("/home");
    await sleep(rnd(2500, 4000) * SPD);
    return onHome();
  }
  const gotoNotifications = () => clickNav(SEL.navNotif, "通知页", SEL.cell);
  const onHome = () => location.pathname === "/home";
  const onNotif = () => location.pathname === "/notifications";

  async function ensureHome() {
    if (onHome()) return true;
    await goHome();
    return onHome();
  }

  /* 顶部 Feed 栏目：**必须同时认中英文**。
   * X 的界面语言跟着账号走 —— 正式号是中文界面（「为你推荐 / 正在关注」），
   * 旧代码写死 /For you/ 就必然找不到按钮。 */
  const FEED_LABELS = {
    for_you:   { re: /^(For you|为你推荐|为你|推荐)$/i,        cn: "为你推荐" },
    following: { re: /^(Following|正在关注|关注)$/i,            cn: "正在关注" },
  };

  /* 切栏目的全局锁：栏目守卫和主流程可能同时想切，串行化避免连点。 */
  let feedSwitching = false;

  async function switchFeedTab(kind) {
    if (feedSwitching) {
      await logAct("已有栏目切换正在进行，这次跳过", "wait");
      return false;
    }
    const spec = FEED_LABELS[kind] || FEED_LABELS.for_you;
    /* 【只能点这两个栏目，别的都不许碰】
     * 顶部那一排还有「AI」「创业公司」「商业」「加密」「股票」等用户自建栏目，
     * 以前的「包含匹配」兜底会误选中它们——用户明确说不看创业公司。
     * 现在只认精确文案，找不到就放弃切换，绝不点别的栏目。 */
    const tabs = [...document.querySelectorAll(SEL.tab)];
    const tab = tabs.find((t) => spec.re.test(norm(t.innerText)));
    let target = tab;
    if (!target) {
      // 退一步：文本里含目标词，且长度很短（排除「创业公司」这类多字栏目）
      target = tabs.find((t) => {
        const tx = norm(t.innerText);
        if (tx.length > 6) return false;
        return kind === "following" ? /following|正在关注/i.test(tx) : /for you|为你推荐/i.test(tx);
      });
      if (!target) {
        await logAct(`顶部没有「${spec.cn}」栏目 → 留在当前栏目继续，不去点别的栏目`, "wait");
        return false;
      }
    }
    feedSwitching = true;
    try {
      return await clickFeedTab(target, spec, kind);
    } finally {
      feedSwitching = false;
    }
  }

  async function clickFeedTab(tab, spec, kind) {
    if (tab.getAttribute("aria-selected") === "true") {
      await logAct(`已在「${spec.cn}」栏目，无需切换`);
      return true;
    }
    /* 点栏目之前先确认它确实是我们要的那个文案。
     * 坐标点错栏目是最扎眼的错误（用户看到机器人点「创业公司」弹菜单），
     * 点之前把将要点的目标文字记进日志，出问题能立刻定位。 */
    const tx = norm(tab.innerText);
    if (!spec.re.test(tx)) {
      await logAct(`拒绝点击：目标栏目是「${tx}」，不是「${spec.cn}」`, "skip");
      return false;
    }
    const before = timelineSig();
    const label = spec.cn;
    await logAct(`切栏目：点击「${tx}」`, "nav");
    /* 栏目 tab 也是紧挨着的（为你推荐/正在关注/AI/创业公司…），
     * 用精确点击避免横向偏移点到隔壁栏目。 */
    if (!(await clickExact(tab, `栏目「${tx}」`, [1500, 2600]))) return false;
    // 慢网：切栏目后时间线要重新拉取，等内容真的换一批再开始读
    await waitContent(1, 25000, label + " 栏目");
    const changed = await waitTimelineChange(before, 15000, label + " 栏目");
    /* 点完必须核实：目标栏目是否真的被选中。
     * 如果还是别的栏目（例如点歪到「创业公司」），要明确报出来，
     * 否则后面的栏目守卫会一直以为没切成功、反复重试。 */
    const nowSel = visibleSelectedTab();
    const nowTx = nowSel ? norm(nowSel.innerText) : "";
    if (nowTx && !spec.re.test(nowTx)) {
      await logAct(`✗ 切栏目失败：点完仍然停在「${nowTx}」`, "fail");
      return false;
    }
    await logAct(`已切到「${label}」栏目${changed ? "（内容已更新）" : "（内容未见变化，继续）"}`);
    return true;
  }

  async function goBack(label = "上一页") {
    // 返回只能点界面箭头（纪律：不用 history.back / 输网址）
    const btn = q(SEL.back);
    if (!btn) { await goHome(); return false; }
    if (!(await clickEl(btn, { settle: [1200, 2200] }))) { await goHome(); return false; }
    await waitContent(1, 20000, label);
    return true;
  }

  // 写操作间隔（评论之间）：面板可调秒数区间，随机取，再乘速度系数
  function writeGap(beh) {
    const lo = Math.max(5, beh.write_gap_min ?? 30);
    const hi = Math.max(lo, beh.write_gap_max ?? 90);
    return rnd(lo, hi) * 1000 * SPD;
  }

  // ---------------- 读取 ----------------

  /* 读一屏帖子。
   * 【自动存档】读到的帖子顺手写进本地 seenTweets —— 这样时间线、发现页、
   * 作者主页、通知页读到的全部会留档，不用在每个调用点各写一遍。
   * 写入是异步后台动作（不 await），不拖慢刷帖节奏。
   * 定时任务里若没有 id（从发现页直接进主页那种）就不存。 */
  function readTweets(n = 12) {
    const arts = [...document.querySelectorAll(SEL.article)];
    const seen = new Set();
    const out = [];
    for (const a of arts) {
      if (out.length >= n) break;
      const tx = a.querySelector(SEL.tweetText);
      const link = a.querySelector('a[href*="/status/"]');
      const href = link ? link.getAttribute("href") : "";
      if (!href) continue;
      const id = (href.match(/\/status\/(\d+)/) || [])[1] || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const ub = a.querySelector('[data-testid="User-Name"]');
      const handleLinks = [...a.querySelectorAll(SEL.userNameLink)]
        .map((x) => x.getAttribute("href") || "")
        .filter((h) => h.startsWith("/") && !h.slice(1).includes("/"));
      const tm = a.querySelector("time");
      out.push({
        id, href: href.split("?")[0].replace(/\/photo\/\d+$/, ""),
        author: norm(ub && ub.innerText).slice(0, 90),
        handle: (handleLinks[0] || "").replace("/", ""),
        text: norm(tx && tx.innerText),        // 全文（长文折叠由 expandFullText 展开）
        at: tm ? tm.getAttribute("datetime") : "",
        social: norm((a.querySelector('[data-testid="socialContext"]') || {}).innerText).slice(0, 40),
      });
    }
    if (out.length) saveSeenTweets(out);       // 自动存档
    return out;
  }

  /* 读通知列表，分成三类（用户策略）：
   *   reply  别人回复了我的帖子     → 点进去回复（要结合我的原帖 + 他的回复）
   *   follow 别人关注了我           → 点进去，未关注的进主页看帖点赞后关注
   *   like   别人点赞了我的帖子     → 不管
   * 其他（提及、转发等）暂时也归到 reply 类，值得回就回。
   */
  function readNotifications(n = 20, me) {
    const cells = [...document.querySelectorAll(SEL.cell)];
    const low = (me || "").toLowerCase();
    const out = [];
    for (const c of cells) {
      if (out.length >= n) break;
      const text = norm(c.innerText);
      if (!text) continue;
      const tl = text.toLowerCase();

      // 作者：通知里第一个用户链接
      const nameLink = c.querySelector(SEL.userNameLink);
      const handle = ((nameLink && nameLink.getAttribute("href")) || "").replace(/^\//, "").split("/")[0];
      if (!handle) continue;
      if (low && handle.toLowerCase() === low) continue;      // 自己触发的不算

      let kind = "";
      // —— 关注类：「xxx followed you」「关注了你」，且没有帖子链接
      if (/(followed you|关注了你|开始关注你)/i.test(text)) kind = "follow";
      // —— 点赞类：「xxx liked your post」「喜欢了你的帖子」
      else if (/(liked your (post|reply|comment)|喜欢了你的|赞了你)/i.test(text)) kind = "like";
      // —— 回复/提及类
      else if (/(repl(i|y)(ing|ed)?\s*to|回复了|回复你|mentioned you|提到了你|@[\w]+\s*回复)/i.test(text)) kind = "reply";
      else continue;      // 其它通知类型一律忽略

      const link = c.querySelector('a[href*="/status/"]');
      const id = link ? (link.getAttribute("href").match(/\/status\/(\d+)/) || [])[1] || "" : "";
      // 关注类没有帖子 id，用 handle 当键
      const key = kind === "follow" ? `follow:${handle.toLowerCase()}` : id;
      if (!key) continue;

      // 回复类：把「他回复的内容」摘出来（通知卡片里 @我 之后那句）
      let replyText = text;
      const m = text.match(new RegExp(`@${me}\\s*([\\s\\S]+)`, "i"));
      if (m && m[1]) replyText = norm(m[1]);
      else {
        // 去掉「Replying to @xxx」和作者名那几行
        replyText = norm(text.split(/\n/).filter((l) => !/Replying to|@\w+|·\s*\d+[hdm]|回复/.test(l)).join(" "));
      }

      out.push({ kind, key, id, handle, href: link ? link.getAttribute("href") : `/${handle}`,
                 text: replyText.slice(0, 200), raw: text.slice(0, 300) });
    }
    return out;
  }

  /* 读出「当前登录的是谁」——这是「不碰自己帖子」的唯一依据，必须尽量稳。
   * 多路兜底（X 改版可能改掉其中任何一个）：
   *   ① 左侧栏「个人资料」链接  AppTabBar_Profile_Link
   *   ② 左侧栏底部账号切换区    SideNav_AccountSwitcher_Button
   *   ③ 页面里指向 /{handle} 且带 verified/badge 的自身入口
   * 结果缓存 30 秒，避免每贴都查一遍 DOM。 */
  let _meCache = { at: 0, v: "" };
  function whoami() {
    if (Date.now() - _meCache.at < 30000 && _meCache.v) return _meCache.v;

    const fromHref = (el) => {
      const href = (el && el.getAttribute && (el.getAttribute("href") || "")) || "";
      const m = href.match(/^\/([A-Za-z0-9_]+)/);
      const h = m ? m[1] : "";
      // 排除功能页
      if (!h || /^(home|explore|notifications|messages|settings|i|search|compose|bookmarks|jobs)$/i.test(h)) return "";
      return h;
    };

    const tries = [
      '[data-testid="AppTabBar_Profile_Link"]',
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      'a[aria-label="Profile"]',
      'a[aria-label="个人资料"]',
      '[data-testid="DashButton_ProfileIcon_Link"]',
    ];
    for (const sel of tries) {
      const el = q(sel);
      const h = fromHref(el) || fromHref(el && el.querySelector && el.querySelector("a[href]"));
      if (h) { _meCache = { at: Date.now(), v: h }; return h; }
    }

    // 最后兜底：从账号切换按钮的文字里找 @handle
    const sw = q('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (sw) {
      const m = (sw.innerText || "").match(/@([A-Za-z0-9_]{2,})/);
      if (m) { _meCache = { at: Date.now(), v: m[1] }; return m[1]; }
    }
    return "";
  }

  function postAvailable() {
    const T = document.body.innerText || "";
    const bad = /此帖子不可用|This post is unavailable|内容不可用|帖子已被删除|This Post was deleted|Hmm\.\.\.this page doesn|此页面不存在|无法查看此帖子/i;
    const m = T.match(bad);
    if (m) return [false, `unavailable: ${m[0].slice(0, 30)}`];
    if (!q(SEL.tweetText) && !q(SEL.editor)) return [false, "no-content"];
    return [true, ""];
  }

  /* 关注按钮的状态：必须限定在主栏里查。
   * 全局查会把右侧「Who to follow」别人的 Follow 按钮当成作者的按钮（会关错人）。 */
  function followStateIn(root) {
    const scope = root || q('[data-testid="primaryColumn"]') || document;
    const u = scope.querySelector(SEL.unfollow);
    if (u) return { state: "following", btn: u };
    const f = scope.querySelector(SEL.follow);
    if (f) return { state: "follow", btn: f };
    return { state: "none", btn: null };
  }
  const followState = () => followStateIn().state;

  /* 详情页右侧 Relevant People / Who to follow 里的作者行：
   * 用户实测——帖子详情页右边会显示发帖人，没关注是 Follow，已关注是 Following。
   * 所以判断关注状态不必点进主页，直接读侧栏那一行就够。
   * 返回 "follow" | "following" | ""（侧栏没有这个人）。 */
  function sidebarFollowState(handle) {
    const want = (handle || "").toLowerCase();
    if (!want) return "";
    const cells = [...document.querySelectorAll(SEL.userCell)];
    for (const c of cells) {
      const links = [...c.querySelectorAll('a[href^="/"]')]
        .map((a) => (a.getAttribute("href") || "").replace(/^\//, "").split("/")[0].toLowerCase())
        .filter(Boolean);
      if (!links.includes(want)) continue;
      if (c.querySelector(SEL.unfollow)) return "following";
      if (c.querySelector(SEL.follow)) return "follow";
      // 有的版本按钮在 cell 外一层的卡片里，向上再找一层
      const box = c.closest('[data-testid="cellInnerDiv"]') || c.parentElement;
      if (box) {
        if (box.querySelector(SEL.unfollow)) return "following";
        if (box.querySelector(SEL.follow)) return "follow";
      }
    }
    return "";
  }

  // ---------------- 提交与证据 ----------------

  async function submitEditor(beh) {
    const text = editorText();
    if (!text) return { ok: false, error: "编辑器是空的" };
    const probe = text.slice(0, 24);
    if (!(await clickSel(SEL.submit, { settle: [800, 1500] }))) {
      await send({ t: "input", op: "hotkey", keys: ["ctrl", "enter"] });
    }
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (!editorText()) return { ok: true, cleared: true };
      if ((document.body.innerText || "").includes(probe)) return { ok: true, on_page: true };
      await sleep(500);
    }
    // 最后再用 Ctrl+Enter 兜一次
    await send({ t: "input", op: "hotkey", keys: ["ctrl", "enter"] });
    await sleep(rnd(1500, 2500) * SPD);
    if (!editorText() || (document.body.innerText || "").includes(probe))
      return { ok: true, via: "ctrl-enter" };
    return { ok: false, error: "两次提交都没有成功证据" };
  }

  async function replyCurrent(text, beh) {
    const ed = q(SEL.editor);
    if (!ed) return { ok: false, error: "没有回复框（可能受限）" };
    if (!(await typeInto(ed, text, beh))) return { ok: false, error: "输入失败" };
    const got = editorText();
    if (got.replace(/\s/g, "") !== text.replace(/\s/g, ""))
      return { ok: false, error: `回复框与预期不一致：${got.slice(0, 20)}` };
    return submitEditor(beh);
  }

  // ---------------- 持久层（chrome.storage.local）----------------

  async function storeGet() {
    const d = await chrome.storage.local.get(["xa_state"]);
    return d.xa_state || { replied: {}, liked: {}, followed: {}, events: [], records: [], activity: [] };
  }
  async function storeSet(s) { await chrome.storage.local.set({ xa_state: s }); }
  // 读-改-写必须串行：否则 logAct 与 recordTweet 交错会互相覆盖丢数据
  let _storeLock = Promise.resolve();
  function withStore(fn) {
    const run = _storeLock.then(async () => {
      const s = await storeGet();
      await fn(s);
      await storeSet(s);
    });
    _storeLock = run.catch(() => {});
    return run;
  }
  /* 活动日志：msg 给人看，kind 给 UI 上色/分类用。
   * kind: read 读到帖子 / judge 判定 / like 赞成功 / cmt 评论成功 / bm 收藏 /
   *       follow 关注 / skip 滑过 / fail 失败 / nav 导航切换 / wait 等待加载 / info 一般 */
  async function logAct(msg, kind) {
    await withStore((s) => {
      s.activity.push({ at: new Date().toLocaleTimeString(), msg, kind: kind || guessKind(msg) });
      s.activity = s.activity.slice(-300);
    });
    send({ t: "ui-ping" }).catch(() => {});
  }

  // 没显式传 kind 时按文案猜（老调用点不用全改）
  function guessKind(m) {
    const t = String(m || "");
    if (t.startsWith("✓")) {
      if (t.includes("评论")) return "cmt";
      if (t.includes("赞")) return "like";
      if (t.includes("关注")) return "follow";
      return "ok";
    }
    if (t.startsWith("✗") || t.startsWith("⚠")) return "fail";
    if (t.startsWith("滑过") || t.includes("跳过")) return "skip";
    if (t.startsWith("读到")) return "read";
    if (t.startsWith("判定")) return "judge";
    if (/^(展开|收藏)/.test(t)) return "info";
    if (/返回|首页|详情|主页|发现页|回顶|刷新|滚回|点顶部/.test(t)) return "nav";
    if (/等待|加载|没出新帖|慢/.test(t)) return "wait";
    return "info";
  }

  async function countToday(kind) {
    const s = await storeGet();
    const today = new Date().toISOString().slice(0, 10);
    return s.events.filter((e) => e.kind === kind && (e.at || "").startsWith(today)).length;
  }
  async function addEvent(kind) {
    await withStore((s) => {
      s.events.push({ kind, at: new Date().toISOString() });
      s.events = s.events.slice(-3000);
    });
  }
  async function budgetLeft(kind, cap) { return Math.max(0, cap - (await countToday(kind))); }

  /* ---------- 关注限流（防封号，用户明确要求）----------
   * 新号短时间大量关注是最容易被平台抓的行为之一，X 官方也有 follow limit
   * （新号约每天 400 上限，但触发 rate limit 的门槛远低于此）。
   * 三层限制，任一不满足就不关注：
   *   1) 两次关注之间的最小间隔（默认 60~180 秒随机）
   *   2) 每小时上限（默认 8）
   *   3) 每天上限（沿用面板 max_follow，默认 25）
   * 另外整轮会话还有 follow_per_session（默认 5）。
   */
  async function followAllowed(beh) {
    const s = await storeGet();
    const now = Date.now();
    const ev = (s.events || []).filter((e) => e.kind === "follow" && e.at);
    const ts = ev.map((e) => Date.parse(e.at)).filter((n) => !isNaN(n)).sort((a, b) => b - a);

    // ① 距上次关注的最小间隔
    const gapMin = beh.follow_gap_min ?? 60;
    const gapMax = Math.max(gapMin, beh.follow_gap_max ?? 180);
    if (ts.length) {
      const since = (now - ts[0]) / 1000;
      const need = gapMin + Math.random() * (gapMax - gapMin);   // 每次随机一个目标间隔
      if (since < need) {
        return { ok: false, why: `距上次关注才 ${Math.round(since)} 秒，本次需 ≥${Math.round(need)} 秒`,
                 waitMs: Math.ceil((need - since) * 1000), need };
      }
    }

    // ② 每小时上限
    const hourCap = beh.follow_per_hour ?? 8;
    const lastHour = ts.filter((t) => now - t < 3600e3).length;
    if (lastHour >= hourCap) {
      const oldestThisHour = ts.filter((t) => now - t < 3600e3).sort((a, b) => a - b)[0];
      const waitMs = Math.max(60e3, oldestThisHour + 3600e3 - now);
      return { ok: false, why: `本小时已关注 ${lastHour}/${hourCap}，需等约 ${Math.round(waitMs / 60000)} 分钟`,
               waitMs };
    }

    // ③ 每日上限
    const dayCap = beh.limits.follow ?? 25;
    const today = new Date().toISOString().slice(0, 10);
    const todayCount2 = ev.filter((e) => (e.at || "").startsWith(today)).length;
    if (todayCount2 >= dayCap) return { ok: false, why: `今日关注已达上限 ${dayCap}` };

    return { ok: true, today: todayCount2, hour: lastHour };
  }

  // 记录一次关注（统一入口，保证所有路径都计入限流）
  async function noteFollow(handle, reason) {
    await addEvent("follow");
    await withStore((s) => {
      s.followed[handle] = { at: new Date().toISOString(), reason: reason || "" };
    });
  }

  async function recordTweet(tw, actions) {
    if (!tw || !tw.id) return;            // 从发现页直接进主页时没有帖子 id，不留档
    await withStore((s) => {
      s.records.push({ at: new Date().toLocaleString(), id: tw.id, href: tw.href,
                       handle: tw.handle, author: tw.author, text: (tw.text || ""), actions });
      s.records = s.records.slice(-2000);
    });
  }

  /* 把一屏读到的帖子批量存本地。
   * 和 recordTweet 的区别：
   *   recordTweet 记的是「这条我做了什么」（可能覆盖同一条），
   *   这里记的是「我读到了什么」，按 id 去重，已存在就不重复写。
   * 目的是积累素材：评论提示词效果测试、场景分类样本都靠这些真实帖子。 */
  const SAVED_MAX = 3000;
  function saveSeenTweets(list) {
    const good = list.filter((t) => t && t.id &&
      String(t.text || "").trim().length >= 10);
    if (!good.length) return;
    // 不 await：存档是后台动作，不能拖慢刷帖节奏
    withStore((s) => {
      s.seenTweets = s.seenTweets || {};
      for (const t of good) {
        const prev = s.seenTweets[t.id];
        s.seenTweets[t.id] = {
          at: prev ? prev.at : new Date().toLocaleString(),   // 首次读到的时间
          seenAt: new Date().toLocaleString(),                // 最近一次读到
          count: (prev ? prev.count || 1 : 0) + 1,            // 读到几次
          id: t.id, href: t.href, handle: t.handle, author: t.author,
          text: String(t.text || ""),
        };
      }
      // 超过上限按最后读到时间淘汰最旧的
      const keys = Object.keys(s.seenTweets);
      if (keys.length > SAVED_MAX) {
        keys.sort((a, b) => String(s.seenTweets[a].seenAt).localeCompare(String(s.seenTweets[b].seenAt)));
        for (const k of keys.slice(0, keys.length - SAVED_MAX)) delete s.seenTweets[k];
      }
    }).catch(() => {});
  }

  // ---------------- 会话状态机 ----------------

  const CTX_KEY = "xa_ctx";
  const loadCtx = () => { try { return JSON.parse(sessionStorage.getItem(CTX_KEY)); } catch { return null; } };
  function saveCtx(c) {
    if (!c || !c.run) { sessionStorage.removeItem(CTX_KEY); return; }
    sessionStorage.setItem(CTX_KEY, JSON.stringify(c));
    // 镜像统计 + 当前正在处理的帖子到 storage，控制台窗口实时展示
    const cur = c.current ? {
      handle: c.current.handle || "", phase: c.phase,
      text: norm(c.current.text).slice(0, 120),
      cat: SOP.focusHit(c.current.text || ""),
    } : { phase: c.phase };
    withStore((s) => { s.stats = c.stats; s.phase = c.phase; s.now = cur; }).catch(() => {});
  }

  let ctx = null;
  let busy = false;

  /* 【用户要求 4】会话统计实时更新：
   * 以前只在阶段切换时 saveCtx，一轮里读十几篇期间控制台数字是冻住的。
   * 现在加一个 1.5 秒的轻量同步，只写 stats/phase/now（不碰其它字段）。 */
  let statsTimer = null;
  function startStatsSync() {
    stopStatsSync();                  // 先清掉可能存在的旧定时器，避免重复创建
    statsTimer = setInterval(() => {
      if (!ctx || !ctx.run) return;
      checkFeedTab();                 // 顺带核对栏目（每 1.5 秒，很便宜）
      const cur = ctx.current ? {
        handle: ctx.current.handle || "", phase: ctx.phase,
        text: norm(ctx.current.text).slice(0, 120),
        cat: SOP.focusHit(ctx.current.text || ""),
      } : { phase: ctx.phase };
      const snapshot = { ...ctx.stats };   // 快照，避免写入过程中被改
      withStore((s) => { s.stats = snapshot; s.phase = ctx.phase; s.now = cur; }).catch(() => {});
    }, 1500);
  }
  function stopStatsSync() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  /* ---------- 栏目守卫（定时检测） ----------
   *
   * 背景：X 顶部除了「为你推荐」「正在关注」，用户自己还加了「AI」「创业公司」
   * 「商业」「加密」「股票」等栏目。用户明确说不看这些。
   * 做法：定期检查当前选中的栏目文字，不在白名单就拉回「为你推荐」。
   *
   * 【2026-11-24 修死循环】以前这里每 1.5 秒调一次 switchFeedTab，
   * 但 switchFeedTab 内部要等 25 秒内容渲染，**不等它结束就再来一次**，
   * 于是每隔 1-2 秒就并发点一次栏目，日志刷屏：
   *   ⚠ 当前停在「创业公司」→ 拉回「为你推荐」→ 切栏目：点击「为你推荐」→ 又 ⚠ …
   * 时间线一直在重新加载，永远读不到帖子。
   *
   * 现在加三道约束：
   *   ① 防重入：上一次纠偏没结束，这次直接跳过
   *   ② 冷却：两次纠偏至少间隔 8 秒
   *   ③ 放弃：连续 3 次纠不回来 → 停 2 分钟，绝不无限循环
   */
  let feedFixTries = 0;
  let feedFixBusy = false;
  let feedFixLastAt = 0;
  let feedGiveUpUntil = 0;

  /* 只认「可见并且确实选中」的那个栏目。
   * X 会保留一些不可见的旧节点，直接取第一个 aria-selected=true
   * 可能读到已卸载的「创业公司」，造成误判。 */
  function visibleSelectedTab() {
    const tabs = [...document.querySelectorAll(SEL.tab)].filter((t) => {
      if (t.getAttribute("aria-selected") !== "true") return false;
      const r = t.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;         // 隐藏节点
      if (r.bottom < 0 || r.top > innerHeight) return false; // 不在视口
      return true;
    });
    if (!tabs.length) return null;
    // 多个候选时优先能识别出白名单文案的那个
    return tabs.find((t) => {
      const x = norm(t.innerText);
      return FEED_LABELS.for_you.re.test(x) || FEED_LABELS.following.re.test(x);
    }) || tabs[0];
  }

  function checkFeedTab() {
    if (!ctx || !ctx.run || !onHome()) { feedFixTries = 0; return; }
    if (feedFixBusy) return;                        // ① 防重入
    if (Date.now() < feedGiveUpUntil) return;       // ③ 已进入放弃期
    const curTab = visibleSelectedTab();
    if (!curTab) return;
    const tx = norm(curTab.innerText);
    if (!tx) return;
    // 白名单：只有这两个栏目算「我们在的」
    const ok = FEED_LABELS.for_you.re.test(tx) || FEED_LABELS.following.re.test(tx);
    if (ok) { feedFixTries = 0; return; }
    // ② 冷却：别每 1.5 秒就点一次
    if (Date.now() - feedFixLastAt < 8000) return;
    feedFixLastAt = Date.now();
    feedFixTries++;
    if (feedFixTries === 1) {
      logAct(`⚠ 当前停在「${tx}」栏目（不在允许范围）→ 拉回「为你推荐」`, "warn").catch(() => {});
    }
    if (feedFixTries > 3) {
      feedFixTries = 0;
      feedGiveUpUntil = Date.now() + 60e3;
      /* 纠不回来就别在这里耗着，更不能继续读「创业公司」的内容。
       * 直接硬导航到 /home —— X 打开 /home 默认就是「为你推荐」。 */
      logAct("连续 3 次没拉回白名单栏目 → 重新打开 /home 归位", "fail").catch(() => {});
      location.assign("/home");
      return;
    }
    feedFixBusy = true;
    switchFeedTab("for_you")
      .catch(() => {})
      .finally(() => { feedFixBusy = false; });
  }

  async function getBeh() {
    const d = await chrome.storage.local.get(["xa_settings", "xa_llm"]);
    const s = d.xa_settings || {};
    const L = d.xa_llm || {};        // API 配置独立存放，优先于旧字段
    SPD = Math.max(0.5, Math.min(3, s.speed ?? 1.5));   // 全局速度系数生效点
    return {
      typing_ms: s.typing_ms ?? 130, session_minutes: s.session_minutes ?? 30,
      // 会话时长随机区间（本轮跑多久也在区间里抽，避免每轮时长一模一样）
      session_min_min: s.session_min_min ?? 18,
      session_max_min: s.session_max_min ?? 45,
      session_jitter: s.session_jitter !== false,
      // 评论审核（不及格就跳过不发）
      review_enabled: s.review_enabled === true,   // 默认关闭（用户要求先暂停审核）
      review_threshold: s.review_threshold ?? 60,
      review_banned: s.review_banned || "",
      // 审核词表（评论规则窗口里改的，null = 用代码出厂值）
      review_rules: s.review_rules || null,
      like_prob: s.like_prob ?? 0.85, comment_prob: s.comment_prob ?? 0.85,
      expand_prob: s.expand_prob ?? 0.9, bookmark_prob: s.bookmark_prob ?? 0.3,
      explore_prob: s.explore_prob ?? 0.5,
      // 评论规则：默认走用户规则（mine）；sop = 原来的严格规则
      comment_rule: s.comment_rule || "mine",
      comment_target_len: s.comment_target_len ?? 13,
      // 高级 SOP 参数
      like_prob_cap: s.like_prob_cap ?? 0.9,
      comment_prob_cap: s.comment_prob_cap ?? 1,
      expand_char_min: s.expand_char_min ?? 220,
      write_gap_min: s.write_gap_min ?? 30,
      write_gap_max: s.write_gap_max ?? 90,
      // 至少读够多少篇才允许回顶刷新（防止反复刷同几条，看起来像脚本）
      min_read_before_refresh: s.min_read_before_refresh ?? 12,
      dedup_comment: s.dedup_comment !== false,
      focus_keywords: s.focus_keywords || "",
      // 三道基础检查：默认**全关**（用户要求"暂时不用所有审核，生成什么就发什么"）。
      // 存的是 guard_* 字段（新名字），旧的 check_* 值一律不认，保证默认关。
      check_validate: s.guard_validate === true,
      check_echo: s.guard_echo === true,
      check_opinion: s.guard_opinion === true,
      // 我的账号名（测试号/正式号都填，逗号分隔）——用于「不碰自己帖子」判定
      my_handles: s.my_handles || "",
      follow_per_session: s.follow_per_session ?? 5,
      // 关注限流：两次关注的最小/最大间隔（秒）、每小时上限
      follow_gap_min: s.follow_gap_min ?? 60,
      follow_gap_max: s.follow_gap_max ?? 180,
      follow_per_hour: s.follow_per_hour ?? 8,
      speed: s.speed ?? 1.5, feed: s.feed || "for_you",
      // 栏目轮换：为你推荐占比（0.7 = 7:3），每读满 feed_batch 篇掷一次
      feed_ratio: s.feed_ratio ?? 0.7,
      feed_batch: s.feed_batch ?? 7,
      tone: s.tone || "friendly", style: s.style || "normal",
      limits: { like: s.max_like ?? 60, reply: s.max_reply ?? 20, follow: s.max_follow ?? 25 },
      llm: { apiKey: L.apiKey || s.llm_key || "",
             baseUrl: L.baseUrl || s.llm_base || "https://api.deepseek.com/v1",
             model: L.model || s.llm_model || "deepseek-flash" },
      // 评论提示词与模板（评论规则窗口里可改）
      comment_prompt: L.comment_prompt || s.comment_prompt || "",
      comment_templates: L.comment_templates || s.comment_templates || "",
      comment_ban_words: L.comment_ban_words || s.comment_ban_words || "",
      notif_enabled: !!s.notif_enabled,
    };
  }

  /* 「这是不是我自己的账号」判定 —— 全项目唯一入口。
   * 依据 = 当前登录账号（whoami 多路兜底）+ 面板配置的 my_handles（测试号/正式号都填）。
   * 两个号来回切的时候，即使 whoami 一时读不到，配置里的名字也能兜住。 */
  function isMyHandle(handle, beh) {
    const k = (handle || "").toLowerCase();
    if (!k) return false;
    const list = String((beh && beh.my_handles) || "")
      .split(/[,，\s@]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const me = (whoami() || "").toLowerCase();
    if (me && !list.includes(me)) list.push(me);
    return list.includes(k);
  }

  /* 给生成器准备「我以前说过什么」：
   *   - 全局历史：最近发过的 100 条评论（换角度，别复读）
   *   - 同作者历史：给这个人发过的所有评论（在别人主页最容易复读，重点防它）
   * 返回 { myReplies, replies } 补到 post 上，再交给 COMMENT_GEN.generate。 */
  async function withAntiRepeat(post) {
    const s = await storeGet();
    const all = Object.values(s.replied || {}).map((r) => r && r.text).filter(Boolean);
    COMMENT_GEN.setHistory(all);
    const handle = (post.handle || "").toLowerCase();
    const sameAuthor = (s.records || [])
      .filter((r) => (r.handle || "").toLowerCase() === handle && r.actions && r.actions.comment)
      .map((r) => r.actions.comment)
      .filter(Boolean);
    return { ...post,
             myReplies: [...sameAuthor, ...all.slice(-40)],
             replies: (post.replies || []) };
  }

  // 发成功后把这条记进历史，供后续去重
  function noteComment(text) { COMMENT_GEN.pushHistory(text); }

  /* 评论来源标记：模型 / 模板。
   * 之前日志不写来源，评论雷同时看不出是模型在说套话还是退回了固定池，
   * 排查全靠猜。现在每条都标出来，一眼能看出比例。 */
  function srcTag(gen) {
    if (!gen) return "来源未知";
    if (gen.source === "llm")
      return (`模型 ${gen.model || ""}`).trim() + (gen.attempts > 1 ? `（第 ${gen.attempts} 次才过）` : "");
    if (gen.source === "llm_failed") return "模型 3 次不合格";
    if (gen.source === "llm_error") return "模型接口报错";
    if (gen.source === "no_api") return "未配 API Key";
    if (gen.source === "template") return "⚠ 模板（已停用，不该出现）";
    return gen.source || "来源未知";
  }

  async function startSession() {
    aborted = false;                       // 清掉上次停止留下的中断标志
    stopLoop();                            // 清掉可能残留的旧定时器
    const beh = await getBeh();
    SOP.setExtraKeywords(beh.focus_keywords);   // 面板自定义的重点关键词生效
    /* 审核词表：评论规则窗口里改过的（增删改）灌进审核引擎。
     * 没改过的话 beh.review_rules 是 null → setRules 保持出厂默认。 */
    if (typeof COMMENT_REVIEW !== "undefined" && COMMENT_REVIEW.setRules && beh.review_rules) {
      COMMENT_REVIEW.setRules(beh.review_rules);
      await logAct(`已加载审核词表（规则窗口里自定义过的部分：${Object.keys(beh.review_rules).filter((k) => beh.review_rules[k]).join("、") || "无"}）`, "judge");
    }

    /* 会话时长也随机：固定跑 30 分钟整，在平台侧看就是脚本
     * （每次在线时长方差为 0，人做不到）。所以在 [min, max] 里抽一个值。
     * session_minutes 作为中点/兜底，随机开关关闭时就用它。 */
    const smin = Math.max(3, Math.round(beh.session_min_min || beh.session_minutes || 30));
    const smax = Math.max(smin, Math.round(beh.session_max_min || beh.session_minutes || 30));
    const dur = beh.session_jitter !== false && smax > smin
      ? smin + Math.floor(Math.random() * (smax - smin + 1))
      : Math.round(beh.session_minutes || 30);

    ctx = { run: true, phase: beh.notif_enabled ? "notif" : "home",
            feed: beh.feed,                     // 会话默认进的栏目（面板设置）
            feedNow: beh.feed,                  // 当前实际所在栏目（会随刷新失败切换）
            batchReads: 0,                       // 本块已读篇数（到量后重新抽栏目）
            quota: null,                         // {target, n} 当前这块在哪个栏目、打算看几篇
            feedCount: {},                       // 各栏目去过几次（日志/排查用）
            deadline: Date.now() + dur * 60000,
            durMin: dur,
            started: Date.now(), seen: [], stats: { read: 0, expanded: 0, liked: 0,
            commented: 0, bookmarked: 0, followed: 0, skipped: 0 },
            notifTodo: [], current: null, plan: null };
    saveCtx(ctx);
    await logAct(`会话开始：本轮随机时长 ${dur} 分钟（区间 ${smin}~${smax}） · 速度系数 ${SPD}（1=原速，越大越慢）`);
    // 明确告知用的是哪套提示词：自定义的可能是旧模板，评论雷同时先查这里
    {
      const u = beh.comment_prompt && beh.comment_prompt.trim();
      const pv = u ? u.slice(0, 40).replace(/\s+/g, " ") : "";
      await logAct(u
        ? `评论提示词：⚠ 用的是设置里存的自定义提示词（"${pv}…"）`
        : `评论提示词：内置默认（反雷同版）`, u ? "warn" : "judge");
      if (u && (/即时通讯|聊天软件|回复助手|附和/.test(u)))
        await logAct(`⚠ 检测到旧版聊天助手模板，会导致评论结构高度雷同 → 去「评论规则」窗口换成默认提示词或新的正式号提示词`, "fail");
    }
    if (!_off.calibrated) await calibrateOffset();
    startStatsSync();       // 会话统计实时同步到控制台
    // 【用户要求 1】任务开始先刷新一次时间线，保证拿到的是最新的帖子
    if (!onHome()) await goHome();
    else {
      await logAct("开始前先刷新时间线，拉最新一批帖子", "nav");
      await hardRefreshTimeline();
    }
    loop();
  }

  /* 强制刷新时间线：
   * 优先点「Show N posts」/「新帖」按钮；没有就滚到顶再点一次首页 tab（UI 内重载）。 */
  async function hardRefreshTimeline() {
    const before = timelineSig();
    const pill = findNewPostsPill();
    if (pill && await clickEl(pill, { settle: [1500, 2600] })) {
      if (await waitTimelineChange(before, 15000, "开始刷新")) return true;
    }
    // 滚到顶部后点一下当前 tab（For You），触发重新拉取
    for (let i = 0; i < 6; i++) { await scrollBy(-3); await sleep(rnd(300, 600) * SPD); }
    // 用精确点击：通用点击带偏移，会把「主页」点到下面的「探索」
    if (await clickNavExact(SEL.navHome, "首页")) {
      return await waitTimelineChange(before, 15000, "首页刷新");
    }
    return false;
  }

  // 找顶部横幅下方的刷新按钮（按可见文案，X 会改版、界面语言会变）
  // 中文是「已发布」（截图为证），英文是「Show N posts」「New posts」
  function findNewPostsPill() {
    /* 文案白名单（中英文都要覆盖）：
     *   显示 35 帖子 / 显示 12 条 / 显示 175 个帖子
     *   查看新帖子 / 新帖子 / 已发布 / 已推送
     *   Show 175 posts / 175 posts / New posts
     * 注意「显示 35 帖子」在 X 上是**发帖框下面、第一条帖子上面**那一行。 */
    const RES = [
      /^\s*显示\s*\d+\s*(条|个)?\s*帖子?\s*$/i,
      /^\s*显示\s*\d+\s*条\s*$/i,
      /查看新帖子|新帖子|已发布|已推送/i,
      /Show\s+\d+\s+posts?/i,
      /^\s*\d+\s*posts?\s*$/i,
      /new\s+posts?/i,
    ];
    const matchText = (t) => !!t && t.length <= 40 && RES.some((re) => re.test(t));
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      if (r.bottom < 0 || r.top > innerHeight) return false;
      return true;
    };

    // ① 先找天然可点击的元素
    const clickables = [...document.querySelectorAll(
      'button, [role="button"], a[role="button"], div[role="button"]'
    )];
    for (const el of clickables) {
      if (matchText((el.innerText || "").trim()) && vis(el)) return el;
    }
    // ② 退一步：任意元素的文本匹配，然后向上找可点击祖先
    //    （「显示 35 帖子」很可能是个普通 div/span，靠父层接点击）
    const any = [...document.querySelectorAll("div, span, p")];
    for (const el of any) {
      const t = (el.innerText || "").trim();
      if (!matchText(t) || !vis(el)) continue;
      let p = el;
      for (let i = 0; i < 6 && p; i++) {
        if (p.tagName === "BUTTON" || p.getAttribute("role") === "button" ||
            p.getAttribute("tabindex") !== null) return p;
        p = p.parentElement;
      }
      return el;                 // 找不到可点击祖先就用它本身
    }
    return null;
  }

  /* 滚到时间线最上面。用户要求：遇到看过的帖子要先拉到顶部，看有没有「显示 N 帖子」。 */
  async function scrollToTop(maxTries = 12) {
    for (let i = 0; i < maxTries; i++) {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      if (y <= 4) return true;
      await scrollBy(-Math.max(3, Math.ceil(y / 600)));   // 一次滚回大半
      await sleep(rnd(500, 900) * SPD);
    }
    return (window.scrollY || 0) <= 4;
  }

  /* 有「显示 N 帖子 / 查看新帖子」就点它拉新帖。
   * 返回 true = 点完后**真的出现了没读过的新帖**（用帖子 id 判断，不看 DOM 签名）。
   *
   * 为什么不能只看签名：点一下按钮 X 会重渲染整列，签名必然变，
   * 但内容还是那几条——以前就因此每隔两秒点一次，永远读不到新帖。
   * 另外加 45 秒冷却，同一颗按钮不反复点。 */
  async function clickNewPostsPillIfAny(where = "") {
    const pill = findNewPostsPill();
    if (!pill) return false;
    if (ctx && ctx.pillLastAt && Date.now() - ctx.pillLastAt < 45e3) return false;
    const label = ((pill.innerText || "").trim()).slice(0, 20);
    const beforeIds = new Set(readTweets(12).map((t) => t.id));
    if (!(await clickEl(pill, { settle: [1500, 2600] }))) return false;
    if (ctx) ctx.pillLastAt = Date.now();
    await logAct(`${where ? where + " → " : ""}发现顶部「${label}」，点它拉新帖`, "nav");
    // 等它把新帖插进来，再用「有没有没读过的 id」判断成功
    for (let i = 0; i < 6; i++) {
      await sleep(rnd(600, 1000) * SPD);
      const now = readTweets(12);
      const freshOnes = now.filter((t) => !beforeIds.has(t.id) && !(ctx && ctx.seen.includes(t.id)));
      if (freshOnes.length) {
        await logAct(`「${label}」生效：拉到 ${freshOnes.length} 条没读过的新帖`, "judge");
        return true;
      }
    }
    await logAct(`点了「${label}」但没有新内容（可能确实没有新帖）`, "wait");
    return false;
  }

  /* 停止信号：停止时不仅设 ctx.run=false，还要让**正在执行的步骤立即中断**。
   * 以前只设标志位，当前 stepXxx 已经在 await 里，会继续跑完整个步骤
   * （可能几十秒，长的时候连带打开发帖框、评论全走完），用户看到的就是
   * 「点了停止还在动」。
   * 做法：全局 aborted 标志 + 可中断的 sleep()，步骤里任何等待点都会抛 AbortError。 */
  class AbortError extends Error {
    constructor() { super("stopped"); this.name = "AbortError"; }
  }
  // aborted 已在文件顶部声明（sleep 需要它），这里不再重复声明

  function checkAbort() {
    if (aborted) throw new AbortError();
  }

  function stopSession(reason) {
    aborted = true;                        // 先置中断标志，让进行中的步骤立刻停
    stopLoop();                            // 停掉主循环定时器，不再空转
    if (ctx) { ctx.run = false; saveCtx(ctx); }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    stopStatsSync();
    logAct(`会话结束：${reason || "手动停止"}`);
    send({ t: "round-done" }).catch(() => {});
  }

  // ---- 各阶段一步 ----

  async function stepHome(beh) {
    if (!onHome()) { await goHome(); return; }
    /* 【用户要求】进入/回到时间线（为你推荐、正在关注）时，
     * 先看顶部有没有「显示 N 帖子」，有就先点它拉最新一批。
     * 限流：最多 3 分钟查一次，否则每次循环都滚到顶部会一直打断阅读。 */
    if (!ctx.pillCheckedAt || Date.now() - ctx.pillCheckedAt > 3 * 60e3) {
      ctx.pillCheckedAt = Date.now();
      await scrollToTop();
      if (await clickNewPostsPillIfAny("时间线顶部")) {
        await logAct("已拉到最新一批帖子", "judge");
      }
    }
    /* 栏目策略（用户要求）：
     * 「为你推荐」和「正在关注」按比例轮换，默认 7:3。
     * 以前是"刷不动才换"，结果几乎全在为你推荐，正在关注基本没去过。
     * 现在每读满一批（默认 7 篇）就按比例决定下一批去哪个栏目。
     * feedRatio 是为你推荐的占比（0.7 = 推荐 7 成、关注 3 成）。 */
    if (!ctx.tabDone) {
      const want = ctx.feedNow || ctx.feed || "for_you";
      // 只在当前栏目确实不对时才切（切栏目会触发时间线重载，能省则省）
      const spec = FEED_LABELS[want] || FEED_LABELS.for_you;
      const curTab = [...document.querySelectorAll(SEL.tab)]
        .find((t) => t.getAttribute("aria-selected") === "true");
      const curTx = curTab ? norm(curTab.innerText) : "";
      if (!spec.re.test(curTx)) await switchFeedTab(want);
      ctx.feedNow = want;
      ctx.tabDone = true;
      /* 刚切完栏目，时间线是重新加载的，再查一次顶部「显示 N 帖子」 */
      await sleep(rnd(1200, 2200) * SPD);
      await clickNewPostsPillIfAny("切换栏目后");
    }

    /* 【按比例换栏目】用「配额制」而不是「每次掷骰子」。
     *
     * 为什么不用掷骰子：只有两个栏目时，每次独立掷骰子会让切换序列变成
     * 关推关推关推——因为"不进这个就进那个"，看着像完美交替，反而更假。
     *
     * 配额制：每轮先按比例抽一个「本轮去哪待着」，并给一个随机的停留篇数。
     * 推荐占 7 成 → 长期 7:3 正确，但单次停留 4~11 篇不等，
     * 序列是「推推推推推推推 关关关 推推推推推推推推推 关关关关」这种块状，
     * 像人真的在一个栏目里翻一会儿再换。 */
    const quota = ctx.quota;
    if (quota && (ctx.batchReads || 0) >= quota.n) {
      // 这一块读完了 → 重新抽下一次去哪、待多久
      ctx.batchReads = 0;
      ctx.quota = null;
    }
    if (!ctx.quota) {
      const ratio = Math.max(0.05, Math.min(0.95, beh.feed_ratio ?? 0.7));
      const base = Math.max(3, Math.round(beh.feed_batch || 7));
      const goForYou = Math.random() < ratio;
      const target = goForYou ? "for_you" : "following";
      // 停留篇数：基准 ±50% 抖动，推荐块和关注块都成块出现
      // 上限 12：模拟里出现过单块 51 篇，那是状态恢复后 quota 没被消耗导致停留过久
      const n = Math.min(12, Math.max(2, Math.round(base * (0.5 + Math.random()))));
      ctx.quota = { target, n };
      const cur = ctx.feedNow || ctx.feed || "for_you";
      if (target !== cur) {
        const ok = await switchFeedTab(target);
        if (ok) {
          ctx.feedNow = target;
          ctx.feedCount = ctx.feedCount || {};
          ctx.feedCount[target] = (ctx.feedCount[target] || 0) + 1;
          ctx.seen = [];                 // 换栏目后内容不同，重新记「读过」
          await logAct(`换到「${FEED_LABELS[target].cn}」，这块打算看 ${n} 篇`, "nav");
          saveCtx(ctx);
          return;
        }
        ctx.quota = null;                // 切失败就下轮重抽
      }
    }
    // 每读 5 篇去发现页找一次可关注的人（用户策略：涨关注、涨时间线）
    /* 但发现页经常是一条帖子都没有（默认是趋势/体育组件），
     * 一旦失败过就 20 分钟内不再去，避免 "进发现页 → 空等 → 回主页" 死循环。 */
    const exploreCooled = !!(ctx.exploreBlocked && Date.now() - ctx.exploreBlocked < 20 * 60000);
    if ((ctx.homeReads || 0) >= 5 && (await budgetLeft("follow", beh.limits.follow)) > 0 && !exploreCooled) {
      ctx.homeReads = 0;
      ctx.phase = "explore"; saveCtx(ctx); return;
    }
    /* 正处于发现页冷却期：把这 5 篇的计数清掉，继续在主页刷，
     * 否则 homeReads 会一直 ≥5、每次循环都判一次。 */
    if (exploreCooled && (ctx.homeReads || 0) >= 5) ctx.homeReads = 0;
    const tweets = readTweets(12);   // readTweets 内部已自动存档到本地
    const fresh = tweets.filter((t) => !ctx.seen.includes(t.id));
    if (!fresh.length) {
      /* 【用户要求】这一屏没有新帖时，最终手段就是**双击左侧栏「主页」刷新**。
       * 处理顺序（从轻到重）：
       *   ① 往下滚一屏 —— 很多情况只是分页慢
       *   ② 点横幅上的「Show N posts」—— 最不打扰
       *   ③ 双击主页 —— 真正重新拉时间线
       * 以前③排在第 8 次滚动之后，还夹着 min_read 门槛，看起来就是"卡住不刷新"。 */
      /* 【用户要求】遇到看过的帖子时，先**拉到最上面**看有没有「显示 N 帖子」。
       * 因为新帖是插在时间线顶部的，往下滚只会越走越旧。 */
      await scrollToTop();
      if (await clickNewPostsPillIfAny("遇到看过的帖子")) {
        ctx.oldSince = 0; ctx.scrollTries = 0; return;
      }

      const before = document.querySelectorAll(SEL.article).length;
      await scrollBy(ri(2, 4));
      if (await waitMoreArticles(before, 10000)) { ctx.scrollTries = 0; return; }

      // ② 再试一次横幅按钮（滚动后位置可能变了，动作也可能刚出现）
      if (await clickNewPostsPillIfAny("")) {
        ctx.oldSince = 0; ctx.scrollTries = 0; return;
      }

      // ③ 双击主页刷新（用户明确要求的方式）
      ctx.scrollTries = (ctx.scrollTries || 0) + 1;
      const readThisRun = ctx.homeReads || 0;
      const MIN_READ = beh.min_read_before_refresh ?? 12;
      if (readThisRun < MIN_READ && ctx.scrollTries < 2) {
        await logAct(`读到 ${readThisRun}/${MIN_READ} 篇，再翻一屏看看`, "wait");
        await sleep(rnd(2500, 5000) * SPD);
        return;
      }
      /* 双击刷新也限流：60 秒内只刷一次，否则会变成"刷-读-没有-刷"高频循环，
       * 平台侧看就是异常刷新行为。 */
      if (ctx.dblLastAt && Date.now() - ctx.dblLastAt < 60e3) {
        await sleep(rnd(5000, 9000) * SPD);
        return;
      }
      ctx.dblLastAt = Date.now();
      await logAct("连续没有新帖 → 双击左侧栏「主页」刷新时间线", "nav");
      const refreshed = await doubleClickNav(SEL.navHome, "首页");
      ctx.homeReads = 0; ctx.oldSince = 0; ctx.scrollTries = 0; ctx.noNewRounds = 0;
      if (refreshed) {
        await waitContent(1, 20000, "主页");
        ctx.tabDone = false;       // 回流程开头重新走
      } else {
        await sleep(rnd(6000, 12000) * SPD);
      }
      return;
    }
    ctx.oldSince = 0;   // 出了新帖就清空「旧帖计时」
    ctx.noNewRounds = 0;
    // 选帖策略：按质量加权（重点领域 > 互动帖 > 内容质量），不是无脑第一条
    fresh.forEach((t) => ctx.seen.push(t.id));
    // 批次计数：读满 feed_batch 篇后按 7:3 比例决定是否换栏目
    ctx.batchReads = (ctx.batchReads || 0) + fresh.length;

    // 【硬规则】自己的帖子和自己发的回复一律不碰：
    // 不点进去、不赞、不评。以前漏了这一步 → 在自己的回复下面回复自己，
    // 一个号自己跟自己对话，平台最容易判定为刷量。
    const me = (whoami() || "").toLowerCase();
    if (!me && !ctx.warnedNoMe) {
      ctx.warnedNoMe = true;
      await logAct("⚠ 读不到自己的账号名（左侧头像链接没找到）——「跳过自己的帖子」这道保护暂时失效，建议刷新 x.com", "fail");
    }
    const mine = fresh.filter((t) => isMyHandle(t.handle, beh));
    const others = fresh.filter((t) => !isMyHandle(t.handle, beh));
    if (mine.length && !others.length) {
      ctx.stats.skipped += mine.length;
      await logAct(`跳过我自己的 ${mine.length} 条帖/回复（不读不赞不评）`, "skip");
      // 关键：不往下滚，否则会永远停在同一屏自己的帖子上打转
      const beforeMine = document.querySelectorAll(SEL.article).length;
      ctx.mineSkips = (ctx.mineSkips || 0) + 1;
      await scrollBy(ri(1, 2));
      await waitMoreArticles(beforeMine, 12000);
      if (ctx.mineSkips >= 4) {          // 连续几屏都是自己的 → 刷新换一批
        ctx.mineSkips = 0;
        await logAct("连续几屏都是自己的帖子 → 刷新换一批", "nav");
        const r = await refreshOrTop("整屏都是自己的帖子");
        if (r === "home") ctx.tabDone = false;
        ctx.homeReads = 0;
      }
      saveCtx(ctx); return;
    }
    ctx.mineSkips = 0;
    const tw = others.reduce((a, b) => (SOP.qualityScore(b) > SOP.qualityScore(a) ? b : a));
    ctx.stats.read += 1;
    ctx.homeReads = (ctx.homeReads || 0) + 1;

    // 全文：卡片里长文被折叠（Show more）时，先展开再判定，留档也记全文
    const artFull = [...document.querySelectorAll(SEL.article)]
      .find((a) => (a.querySelector('a[href*="/status/"]') || { getAttribute: () => "" })
        .getAttribute("href").includes(tw.id));
    if (artFull) {
      const full = await fullTextOf(artFull);
      if (full && full.length > (tw.text || "").length) {
        if (full.length > (tw.text || "").length + 200)
          await logAct(`展开长文：${tw.text.length} → ${full.length} 字（记录全文）`);
        tw.text = full;
      }
    }

    // 实时展示：这一屏读到什么、为什么选它
    const cat = SOP.focusHit(tw.text);
    const inter = SOP.isInteraction(tw) ? " · 互动帖" : "";
    await logAct(`读到 @${tw.handle || "?"}${cat ? " · " + cat : ""}${inter}：` +
      `"${norm(tw.text).slice(0, 60) || "（无文字内容）"}"（全文 ${tw.text.length} 字）`);
    await sleep(rnd(1200, 5000) * SPD);        // 真人扫读停顿

    const [skip, why] = SOP.shouldSkip(tw, beh);
    if (skip) { ctx.stats.skipped++; await logAct(`滑过：${why}`, "skip"); await recordTweet(tw, { skip: why }); saveCtx(ctx); return; }

    // 评论去重（面板可关）：同一帖只回一次，避免重复刷同一帖
    let doCmtGate = true, whyDedup = "";
    if (SOP.isMineMode(beh) && beh.dedup_comment) {
      const st0 = await storeGet();
      if (st0.replied[tw.id]) { doCmtGate = false; whyDedup = "这帖已经回过（去重）"; }
    }

    const expand = SOP.shouldExpand(tw, beh);
    const [doLike, whyLike] = SOP.shouldLike(tw, beh);
    let [doCmt, whyCmt] = SOP.shouldComment(tw, beh);
    if (!doCmtGate) { doCmt = false; whyCmt = whyDedup; }
    const [doBm] = SOP.shouldBookmark(tw, beh);
    // 要评论就必须点开（回复框在详情页里）；看到的所有帖子都按概率摇赞/评
    const open = expand || doCmt;
    ctx.plan = { expand: open, doLike, whyLike, doCmt, doBm };
    ctx.current = tw;
    await logAct(`判定：${doLike ? "赞" : "不赞（" + whyLike + "）"} · ${doCmt ? "评" : "不评（" + whyCmt + "）"}${doBm ? " · 藏" : ""}${open ? " · 点开细看" : ""}`, "judge");

    if (!open) {
      let liked = false;
      if (doLike && (await budgetLeft("like", beh.limits.like)) > 0) {
        const ok = await likeInTimeline(tw.id);
        if (ok) {
          liked = true;
          ctx.stats.liked++; await addEvent("like");
          await withStore((s) => { s.liked[tw.id] = { at: new Date().toISOString() }; });
          await logAct(`✓ 赞（时间线）@${tw.handle}（按钮已变已赞态）`, "like");
        } else if (ok === false) {
          await logAct(`✗ 赞（时间线）@${tw.handle}：按钮状态没翻转，没点到`);
        }
      }
      await recordTweet(tw, liked ? { like: true }
                                   : { skip: doLike ? "想赞但没点到" : whyLike });
    } else {
      const art = [...document.querySelectorAll(SEL.article)]
        .find((a) => (a.querySelector('a[href*="/status/"]') || { getAttribute: () => "" })
          .getAttribute("href").includes(tw.id));
      const target = (art && art.querySelector(SEL.tweetText)) || art;
      if (!target || !(await clickEl(target, { settle: [1500, 2600] }))) {
        await logAct("详情打不开，跳过"); ctx.stats.skipped++; saveCtx(ctx); return;
      }
      // 慢网：详情页数据是二次拉取的，等正文真的渲染出来再进下一步
      const end = Date.now() + 20000;
      let loaded = false;
      while (Date.now() < end) {
        if (q(SEL.tweetText) && !pageLoading()) { loaded = true; break; }
        await sleep(800);
      }
      if (!loaded) await logAct("详情页 20s 没渲染出正文，下一步会重新判断");
      ctx.phase = "detail";
    }
    saveCtx(ctx);
  }

  async function likeInTimeline(id) {
    // 时间线点赞 + 状态验证：点完必须看到 like→unlike 翻转才算成功
    const art = [...document.querySelectorAll(SEL.article)]
      .find((a) => (a.querySelector('a[href*="/status/"]') || {}).getAttribute &&
        a.querySelector('a[href*="/status/"]').getAttribute("href").includes(id));
    const btn = art && art.querySelector(SEL.like);
    if (!btn) return null;
    if (!(await clickEl(btn, { settle: [600, 1200] }))) return false;
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (art.querySelector(SEL.unlike)) return true;
      await sleep(500);
    }
    return false;
  }

  async function stepDetail(beh) {
    const tw = ctx.current || {};
    await waitContent(1, 15000, "详情页");
    const [avail, whyNo] = postAvailable();
    if (!avail) {
      await logAct(`跳过：帖子不可用（${whyNo}）`);
      ctx.phase = "home"; ctx.tabDone = false; await goHome(); saveCtx(ctx); return;
    }
    ctx.stats.expanded++;
    await scrollBy(-ri(3, 6));               // 向上滑动读上下文（SOP：先读再动）
    await sleep(rnd(800, 1800) * SPD);
    const detail = readTweets(3);
    const post = detail[0] || tw;
    post.handle = post.handle || tw.handle;

    // 【兜底】进来才发现是自己的帖/回复 → 立刻退出，不做任何动作
    if (isMyHandle(post.handle, beh)) {
      ctx.stats.skipped++;
      await logAct(`跳过：这是我自己的帖子/回复（@${post.handle}），不互动`, "skip");
      await recordTweet(post, { skip: "自己的帖子" });
      ctx.phase = "home"; ctx.tabDone = false; await goHome(); saveCtx(ctx); return;
    }

    const acts = {};
    let likedDetail = false;
    if (ctx.plan.doLike && (await budgetLeft("like", beh.limits.like)) > 0) {
      const btn = q(SEL.like);
      if (btn && await clickEl(btn, { settle: [600, 1200] })) {
        // 验证：按钮必须翻成 unlike 态才算点赞成功
        const end = Date.now() + 6000; let on = false;
        while (Date.now() < end) { if (q(SEL.unlike)) { on = true; break; } await sleep(500); }
        if (on) {
          likedDetail = true;
          ctx.stats.liked++; await addEvent("like");
          await withStore((s) => { s.liked[tw.id] = { at: new Date().toISOString() }; });
          await logAct(`✓ 赞 @${post.handle}（详情页，按钮已变已赞态）`, "like");
        } else await logAct(`✗ 赞 @${post.handle}：按钮状态没翻转，没点到`);
      }
    }

    if (likedDetail) acts.like = true;

    if (ctx.plan.doCmt && (await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(await withAntiRepeat(post), beh, beh.llm);
      const text = (gen.text || "").trim();
      /* 【发送前审核】用户要求：不合格就跳过，绝不发出去。
       * 之前只有 validateComment 那几道粗筛，挡不住「只有态度没观点」「和帖子不搭」
       * 这类质量问题。这里用 review.js 打总分，不过阈值就整条跳过。 */
      const rev = text && beh.review_enabled === true ? COMMENT_REVIEW.reviewComment(text, { text: post.text, ctxReply: post.ctxReply, myReplies: post.myReplies, scene: COMMENT_GEN.classifyPost(post.text || "") }, beh) : null;
      if (text && rev && !rev.pass) {
        await logAct(`评论不通过审核（${rev.score} 分 · ${rev.fatal}）→ 跳过这条，不发`, "skip");
        for (const line of rev.reasons.slice(0, 3)) await logAct(`  · ${line}`, "skip");
      } else if (text) {
        if (rev && rev.score < 85) {
          await logAct(`评论审核 ${rev.score} 分（${rev.grade}）→ 放行：${text}`, "judge");
        }
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[tw.id] = { at: new Date().toISOString(), text: text.slice(0, 120) };
          });
          acts.comment = text.slice(0, 120);
          noteComment(text);
          await logAct(`✓ 评论 @${post.handle}：${text}（${text.length} 字${rev ? ` · 审核 ${rev.score} 分` : ""} · ${srcTag(gen)}）`, "cmt");
          await sleep(writeGap(beh));   // 写操作间隔：真人不会连发
        } else {
          await logAct(`✗ 评论失败：${r.error}`);
        }
      } else {
        /* 模型没给出合格句子（或没配 API Key）→ 这条不评论。
         * 模板兜底已取消，宁可少发也不发重复模板句。 */
        await logAct(`⏭ 评论跳过：${gen.error || "没有合格文案"}`, "skip");
      }
    }

    if (ctx.plan.doBm) {
      const btn = q(SEL.bookmark);
      if (btn && await clickEl(btn, { settle: [600, 1200] })) {
        ctx.stats.bookmarked++; acts.bookmark = true;
        await logAct(`收藏 @${post.handle}`);
      }
    }

    // 关注：详情页右侧 Relevant People 就能看出有没有关注，不必为「查看」而进主页。
    // 未关注 → 进主页随便看几篇、点赞/评论互动一下，再直接关注（不判断方向）。
    const cap = beh.follow_per_session;
    if ((ctx.stats.followed || 0) < cap && (await budgetLeft("follow", beh.limits.follow)) > 0) {
      const handle = post.handle || "";
      if (handle && !isMyHandle(handle, beh)) {
        const sb = sidebarFollowState(handle);
        const known = (await storeGet()).followed[handle];
        if (sb === "following" || (known && known.state !== "follow")) {
          if (!known) await withStore((s) => {
            s.followed[handle] = { at: new Date().toISOString(), state: "already" };
          });
          await logAct(`@${handle} 侧栏显示已关注，跳过`);
        } else {
          await logAct(`@${handle} ${sb === "follow" ? "侧栏显示未关注" : "侧栏没这个人"} → 进主页看几篇再关注`);
          const link = q(SEL.userNameLink);
          if (link && await clickEl(link, { settle: [1500, 2600] })) {
            ctx.pendingActs = acts;
            ctx.phase = "profile"; saveCtx(ctx); return;
          }
        }
      }
    }
    await recordTweet(post, acts);
    ctx.phase = "home";
    // 优先点界面返回箭头（保住时间线位置、少一次重载）；没有就回 Home
    ctx.tabDone = await goBack("首页");
    saveCtx(ctx);
  }

  // 会话节奏：评论后停 30~90 秒（每日额度由 limits 控制）

  /* 作者主页：用户策略是「先认真翻一遍再关注」，且不再判断方向/质量。
   * 1) 浏览 10 条帖子（不够就滚动加载），逐条读全文
   * 2) 随机抽 3~5 篇，每篇随机点赞或评论
   * 3) 最后直接点关注 —— 用户明确：不需要看方向，涨互动、涨时间线
   */
  async function stepProfile(beh) {
    await waitContent(1, 20000, "作者主页");
    const handle = ctx.current ? (ctx.current.handle || "") : "";
    if (handle && isMyHandle(handle, beh)) {
      await logAct("这是自己的主页，返回");
      ctx.phase = "home"; ctx.tabDone = false; await goHome(); saveCtx(ctx); return;
    }

    const acts = ctx.pendingActs || {};
    delete ctx.pendingActs;

    // 1) 浏览 10 条：不够就滚动加载（最多试 4 次）
    const want = 10;
    let pool = readTweets(want);
    for (let i = 0; i < 4 && pool.length < want; i++) {
      const before = document.querySelectorAll(SEL.article).length;
      await scrollBy(ri(2, 4));
      if (!(await waitMoreArticles(before, 12000))) break;
      pool = readTweets(want);
    }
    pool = pool.slice(0, want);
    await logAct(`@${handle} 主页开始翻：共 ${pool.length} 条${pool.length < want ? "（到不了 10 条，按现有来）" : ""}`);
    for (const t of pool) {
      await sleep(rnd(1200, 3000) * SPD);
      let full = t.text;
      const art = [...document.querySelectorAll(SEL.article)]
        .find((a) => (a.querySelector('a[href*="/status/"]') || { getAttribute: () => "" })
          .getAttribute("href").includes(t.id));
      if (art) { const f = await fullTextOf(art); if (f) full = f; }
      t.text = full;
      await logAct(`主页翻到：${norm(full).slice(0, 60) || "（无文字）"}（${full.length} 字）`);
    }

    // 2) 随机抽 3~5 篇，每篇随机赞或评
    const n = Math.min(ri(3, 5), pool.length);
    const picked = pool.slice().sort(() => Math.random() - 0.5).slice(0, n);
    await logAct(`@${handle} 主页互动：抽 ${picked.length} 篇（随机赞/评）`);
    let likedHere = 0, cmtHere = 0;
    for (const t of picked) {
      await sleep(rnd(1000, 2500) * SPD);
      const canCmt = (await budgetLeft("reply", beh.limits.reply)) > 0 && SOP.shouldComment(t, beh)[0];
      const canLike = (await budgetLeft("like", beh.limits.like)) > 0 && !SOP.shouldSkip(t, beh)[0];
      const wantCmt = canCmt && (!canLike || Math.random() < 0.5);   // 两边都行时五五开
      if (wantCmt) {
        // 主页是重复评论的高发区：同一作者的多条帖子连着评，必须带同作者历史去重
        const gen = await COMMENT_GEN.generate(await withAntiRepeat(t), beh, beh.llm);
        const text = (gen.text || "").trim();
        // 【发送前审核】不过关就跳过这篇，继续下一篇
        const rev = text && beh.review_enabled === true ? COMMENT_REVIEW.reviewComment(text,
          { text: t.text, myReplies: t.myReplies, scene: COMMENT_GEN.classifyPost(t.text || "") }, beh) : null;
        if (text && rev && !rev.pass) {
          await logAct(`主页互动：评论不通过审核（${rev.score} 分 · ${rev.fatal}）→ 跳过`, "skip");
        } else if (text) {
          const art = [...document.querySelectorAll(SEL.article)]
            .find((a) => (a.querySelector('a[href*="/status/"]') || { getAttribute: () => "" })
              .getAttribute("href").includes(t.id));
          const target = art && (art.querySelector(SEL.tweetText) || art);
          if (target && await clickEl(target, { settle: [1500, 2600] })) {
            await waitContent(1, 15000, "帖子详情");
            const r = await replyCurrent(text, beh);
            if (r.ok) {
              cmtHere++;
              ctx.stats.commented++; await addEvent("reply");
              await withStore((s) => {
                s.replied[t.id] = { at: new Date().toISOString(), text: text.slice(0, 120) };
              });
              noteComment(text);
              await recordTweet(t, { comment: text.slice(0, 120) });
              await logAct(`✓ 主页互动：评论 @${handle}：${text.slice(0, 40)}（${srcTag(gen)}）`);
              await sleep(writeGap(beh));
            } else {
              await logAct(`✗ 主页互动评论失败：${r.error}`);
            }
            await goBack("作者主页");
            await waitContent(1, 15000, "作者主页");
          }
          continue;
        } else {
          // 模型没给出合格句子（模板兜底已取消）→ 这篇不评论，但仍可能点赞
          await logAct(`⏭ 主页互动：跳过评论（${gen.error || "没有合格文案"}）`, "skip");
        }
      }
      if (canLike) {
        const ok = await likeInTimeline(t.id);
        if (ok === true) {
          likedHere++;
          ctx.stats.liked++; await addEvent("like");
          await withStore((s) => { s.liked[t.id] = { at: new Date().toISOString() }; });
          await recordTweet(t, { like: true });
          await logAct(`✓ 主页互动：赞 @${handle} 的一篇（${norm(t.text).slice(0, 30)}）`);
          await sleep(rnd(1200, 3000) * SPD);
        }
      } else {
        await logAct(`主页互动：这一篇跳过（额度或内容不合适）`);
      }
    }

    // 关注：不再判断方向/内容质量，直接点（用户策略：先把关注量做起来）
    // 但必须过限流：间隔 / 每小时 / 每天 三道闸
    let followAct = false;
    const fr = await followAllowed(beh);
    if (!fr.ok) {
      await logAct(`暂不关注 @${handle}：${fr.why}`, "wait");
    } else if ((await budgetLeft("follow", beh.limits.follow)) > 0) {
      const { state: st, btn: followBtn } = followStateIn();
      if (st === "following") {
        await withStore((s) => { s.followed[handle] = { at: new Date().toISOString(), state: "already" }; });
        await logAct(`@${handle} 已经关注过了`);
      } else if (st === "follow" && followBtn) {
        if (await clickEl(followBtn, { settle: [900, 1600] })) {
          let on = false;
          const end = Date.now() + 8000;
          while (Date.now() < end) {
            if (followState() === "following") { on = true; break; }
            await sleep(600);
          }
          if (on) {
            followAct = true;
            ctx.stats.followed++;
            await noteFollow(handle, "主页看过再关注");
            await logAct(`✓ 关注 @${handle}（翻了 ${pool.length} 篇 + 赞 ${likedHere} 评 ${cmtHere} 后关注）`, "follow");
          } else {
            await logAct(`✗ @${handle} 关注未生效（按钮没翻转）`, "fail");
          }
        }
      } else {
        await logAct(`@${handle} 主页上没找到关注按钮，跳过`);
      }
    } else {
      await logAct(`关注今日额度已满，暂时不关注 @${handle}`);
    }

    if (followAct) acts.follow = true;
    await recordTweet({ ...(ctx.current || {}), handle }, acts);

    // 从通知页的新粉丝点进来的 → 回通知页继续处理下一条；否则回首页
    if (ctx.fromNotif) {
      delete ctx.fromNotif;
      ctx.phase = "notif"; ctx.tabDone = false;
      await gotoNotifications(); saveCtx(ctx); return;
    }
    ctx.phase = "home"; ctx.tabDone = false;
    await goHome(); saveCtx(ctx);
  }

  /* 发现页（用户策略）：从主页点进发现页，遇到可关注用户时按概率点进主页查看。
   * 概率由面板「发现页概率」控制（默认 0.5），每次会话/每轮都按它摇。
   * 命中 → 进主页（浏览 10 条 + 随机互动 3~5 篇 + 直接关注）；不命中 → 回首页继续。 */
  async function stepExplore(beh) {
    if (location.pathname !== "/explore") {
      const ok = await clickNav(SEL.navExplore, "发现页", SEL.article);
      if (!ok || location.pathname !== "/explore") {
        await logAct("发现页入口没找到，先回首页继续刷");
        ctx.phase = "home"; await goHome(); saveCtx(ctx); return;
      }
    }
    /* 等发现页内容。**发现页默认显示的是趋势/新闻/体育比分这类组件，
     * 很多时候一条帖子都没有**，等 25 秒纯属白等（用户截图里就是这样：
     * 停在「体育」组件上，当前 0 条，反复超时）。
     * 所以：只等 9 秒，没帖子就判定发现页不可用 →
     *   ① 标记 exploreBlocked，20 分钟内不再进来（避免无谓循环）
     *   ② 双击主页刷新时间线（用户明确要求：没帖就双击主页） */
    const loaded = await waitContent(1, 9000, "发现页");
    if (!loaded) {
      ctx.exploreBlocked = Date.now();
      await logAct("发现页没有帖子（默认显示趋势/体育组件）→ 双击主页刷新，20 分钟内不再进发现页", "nav");
      ctx.phase = "home";
      await doubleClickNav(SEL.navHome, "首页");
      await waitContent(1, 20000, "主页");
      saveCtx(ctx);
      return;
    }
    const me = (whoami() || "").toLowerCase();
    const s = await storeGet();

    // 候选用户：发现页里的帖子作者 + 侧栏推荐人
    const cands = [];
    const pushHandle = (h) => {
      const k = (h || "").toLowerCase();
      if (!k || k === me || s.followed[k] || cands.includes(k)) return;
      cands.push(k);
    };
    for (const t of readTweets(12)) pushHandle(t.handle);
    for (const c of document.querySelectorAll(SEL.userCell)) {
      const links = [...c.querySelectorAll('a[href^="/"]')]
        .map((a) => (a.getAttribute("href") || "").replace(/^\//, "").split("/")[0])
        .filter((x) => x && !/^(explore|home|notifications|search|settings|i)$/.test(x));
      links.forEach(pushHandle);
    }
    if (!cands.length) {
      await logAct("发现页没看到可关注的新用户，回首页继续刷");
      ctx.phase = "home"; await goHome(); saveCtx(ctx); return;
    }

    const p = beh.explore_prob ?? 0.5;
    /* 用户要求 3：这个概率 = 「未关注的用户里，有多大概率点进主页浏览再关注」。
     * 没命中的不是跳过，而是**直接在侧边栏那一行点关注**（不必进主页）。
     * 命中的才点进主页走「翻 10 条 + 随机互动 + 关注」。 */
    let inlineFollowed = 0;
    for (const h of cands.slice(0, 6)) {
      const cell = [...document.querySelectorAll(SEL.article), ...document.querySelectorAll(SEL.userCell)]
        .find((el) => [...el.querySelectorAll('a[href^="/"]')]
          .some((a) => (a.getAttribute("href") || "").toLowerCase() === "/" + h));
      if (!cell) continue;

      if (Math.random() <= p) {
        // 命中 → 点进主页
        const link = cell.querySelector(SEL.userNameLink) || cell.querySelector('a[href="/' + h + '"]');
        if (!link) continue;
        if (!(await clickEl(link, { settle: [1500, 2600] }))) continue;
        ctx.current = { handle: h, text: "", id: "", href: "" };
        ctx.pendingActs = {};
        ctx.phase = "profile";
        await logAct(`发现页 命中 ${(p * 100) | 0}% → 点进 @${h} 主页浏览后关注`, "nav");
        saveCtx(ctx);
        return;
      }

      // 未命中 → 就地关注（侧边栏/发现页那一行的 Follow 按钮），不进主页
      const frInline = await followAllowed(beh);
      if (!frInline.ok) {
        await logAct(`发现页 @${h}：暂不关注 —— ${frInline.why}`, "wait");
        // 小时/日上限已满 → 本轮不再尝试；只是间隔不够 → 等够了再继续下一条
        if (!frInline.waitMs || frInline.waitMs > 15 * 60e3) break;
        continue;
      }
      if ((await budgetLeft("follow", beh.limits.follow)) <= 0) {
        await logAct(`发现页 @${h}：概率外（${(p * 100) | 0}%），但关注额度满了，跳过`, "skip");
        continue;
      }
      const box = cell.closest('[data-testid="cellInnerDiv"]') || cell;
      const btn = box.querySelector(SEL.follow);
      if (!btn) { await logAct(`发现页 @${h}：概率外且这一行没有关注按钮，跳过`, "skip"); continue; }
      if (!(await clickEl(btn, { settle: [900, 1600] }))) continue;
      // 验证：按钮翻成 unfollow 才算成功
      let on = false;
      const end = Date.now() + 6000;
      while (Date.now() < end) {
        if (box.querySelector(SEL.unfollow)) { on = true; break; }
        await sleep(500);
      }
      if (on) {
        inlineFollowed++;
        ctx.stats.followed++;
        await noteFollow(h, "发现页未命中概率，就地关注");
        await logAct(`✓ 发现页 @${h}：概率外（${(p * 100) | 0}%）→ 直接就地关注（不进主页）`, "follow");
        await sleep(rnd(2000, 5000) * SPD);
      } else {
        await logAct(`✗ 发现页 @${h}：就地关注没生效（按钮没翻转）`, "fail");
      }
    }
    if (inlineFollowed) await logAct(`发现页本轮就地关注了 ${inlineFollowed} 个`, "follow");
    await logAct("发现页这一轮处理完，回首页继续刷");
    ctx.phase = "home"; await goHome(); saveCtx(ctx);
  }

  /* 通知页先滚几屏把列表加载出来。
   * 通知是虚拟列表，一屏只有 5~6 条；新粉丝常常在下面，不滚就漏。 */
  async function scrollNotificationsToLoad() {
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const n = document.querySelectorAll(SEL.cell).length;
      if (n > last) {
        last = n;
        await scrollBy(ri(2, 3));
        await sleep(rnd(1200, 2200) * SPD);
      } else if (i > 0) {
        break;        // 连续两次没新增 → 到头
      }
    }
    // 滚回顶部，后续点卡片时坐标才对
    for (let i = 0; i < 6; i++) { await scrollBy(-3); await sleep(rnd(250, 500) * SPD); }
    await sleep(rnd(600, 1200) * SPD);
  }

  async function stepNotif(beh) {
    if (!onNotif()) { await gotoNotifications(); return; }
    if (!ctx.notifTodo.length && !ctx.notifLoaded) {
      const me = whoami();
      // 【修】通知列表一屏放不下，先滚动加载几屏再收集，否则底部的新粉丝会被漏掉
      await scrollNotificationsToLoad();
      const items = readNotifications(40, me);
      const s = await storeGet();
      // 分类处理（用户策略）：回复类要回；关注类要去看主页；点赞类不管
      const replyables = [];
      const follows = [];
      let likes = 0;
      for (const it of items) {
        if (it.kind === "like") { likes++; continue; }
        if (it.kind === "follow") {
          // 已经关注过的、或这批已经安排过的不再重复
          if (!s.followed[it.handle.toLowerCase()]) follows.push(it);
          continue;
        }
        // reply / mention：没回过、且值得回
        if (s.replied[it.id]) continue;
        if (!SOP.notificationNeedsReply(it.text)[0]) continue;
        replyables.push(it);
      }
      ctx.notifTodo = [...replyables, ...follows];
      ctx.notifLoaded = true;
      await logAct(`通知：${items.length} 条 · 待回复 ${replyables.length} · 待看新粉丝 ${follows.length} · 点赞类 ${likes} 条（忽略）`);
    }
    if (!ctx.notifTodo.length) {
      ctx.phase = "home"; ctx.tabDone = false;   // feed 保持会话开始时的设置
      await goHome(); saveCtx(ctx); return;
    }
    /* 时间配额：通知阶段总共占会话前 20%，但**回复类和关注类分开算**。
     * 以前用同一个 20% 闸，回复一多就把时间吃光，新粉丝永远轮不到。
     * 现在：回复类用 20% 配额；关注类额外给到 40%（关注是要进主页翻帖的，本来就慢）。 */
    const it = ctx.notifTodo.shift();
    const isFollowTask = it.kind === "follow";
    const share = ctx.deadline - ctx.started;
    const limitPct = isFollowTask ? 0.4 : 0.2;
    if (Date.now() > ctx.started + share * limitPct) {
      await logAct(isFollowTask
        ? `通知回关时间配额用完（${Math.round(limitPct * 100)}%），回首页`
        : `通知回复时间配额用完（${Math.round(limitPct * 100)}%），回首页`, "wait");
      ctx.phase = "home"; ctx.tabDone = false;
      await goHome(); saveCtx(ctx); return;
    }

    // 找这条通知在页面上的卡片
    const findCell = () => [...document.querySelectorAll(SEL.cell)].find((c) => {
      if (it.kind === "follow") {
        // 关注类卡片：文案含 followed you/关注了你，且卡片里能找到这个人的链接
        const txt = c.innerText || "";
        if (!/(followed you|关注了你|开始关注你)/i.test(txt)) return false;
        // 聚合卡片（"A and 5 others followed you"）里有多个头像，逐个比对
        const links = [...c.querySelectorAll('a[href^="/"]')]
          .map((a) => (a.getAttribute("href") || "").replace(/^\//, "").split("/")[0].toLowerCase());
        return links.includes(it.handle.toLowerCase());
      }
      return !!c.querySelector(`a[href*="/status/${it.id}"]`);
    });

    let cell = findCell();
    // 卡片还没渲染出来（虚拟列表）→ 往下滚找一找
    if (!cell) {
      for (let i = 0; i < 5 && !cell; i++) {
        await scrollBy(ri(2, 3));
        await sleep(rnd(1200, 2000) * SPD);
        cell = findCell();
      }
    }

    if (it.kind === "follow") {
      if (!cell) {
        await logAct(`新粉丝 @${it.handle}：通知页没找到他的卡片，跳过`, "skip");
        saveCtx(ctx); return;
      }
      /* 别人关注了我 → 点进他的主页（看帖点赞后关注）。
       * 聚合卡片（"A and 5 others followed you"）里有多个头像，必须点**这个人自己的**
       * 那个链接，不能点第一个 —— 否则会跑到别人主页去关注错人。 */
      const cands = [...cell.querySelectorAll('a[href^="/"]')].filter((a) => {
        const h = (a.getAttribute("href") || "").replace(/^\//, "").split("/")[0].toLowerCase();
        return h === it.handle.toLowerCase();
      });
      const link = cands[0];
      if (!link) {
        await logAct(`新粉丝 @${it.handle}：卡片里找不到他的头像链接，跳过`, "skip");
        saveCtx(ctx); return;
      }
      if (!(await clickEl(link, { settle: [1500, 2600] }))) {
        await logAct(`新粉丝 @${it.handle}：点头像进主页失败，跳过`, "fail");
        saveCtx(ctx); return;
      }
      // 确认真的到了他的主页（慢网/点偏都可能停在通知页）
      await waitContent(1, 15000, "作者主页");
      const onProfile = (() => {
        const cur = location.pathname.replace(/^\//, "").split("/")[0].toLowerCase();
        return cur === it.handle.toLowerCase();
      })();
      if (!onProfile) {
        await logAct(`新粉丝 @${it.handle}：没进到他的主页（当前 ${location.pathname}），跳过`, "skip");
        ctx.phase = "notif"; await gotoNotifications(); saveCtx(ctx); return;
      }
      ctx.current = { handle: it.handle, text: "", id: "", href: `/${it.handle}` };
      ctx.pendingActs = {};
      ctx.fromNotif = true;          // 处理完回通知页，而不是首页
      ctx.phase = "profile";
      await logAct(`新粉丝 @${it.handle} → 已进入主页，开始浏览帖子再关注`, "nav");
      saveCtx(ctx);
      return;
    }

    // 回复类
    const link = cell && cell.querySelector('a[href*="/status/"]');
    if (!link) { saveCtx(ctx); return; }
    if (!(await clickEl(link, { settle: [1500, 2600] }))) { saveCtx(ctx); return; }
    ctx.current = { id: it.id, href: it.href, handle: it.handle, text: it.text, author: it.handle,
                    notifText: it.text };     // 他回复我的那句话，回复时要结合上下文
    ctx.plan = { expand: true, doLike: false, doCmt: true, doBm: false };
    ctx.phase = "notif_reply";
    saveCtx(ctx);
  }

  async function stepNotifReply(beh) {
    await waitContent(1, 15000, "详情页");
    const [avail, whyNo] = postAvailable();
    if (!avail) { await logAct(`跳过：帖子不可用（${whyNo}）`); ctx.phase = "notif"; await gotoNotifications(); saveCtx(ctx); return; }
    await scrollBy(-ri(3, 6));               // 先看上文（SOP：先读再动）
    await sleep(rnd(800, 1600) * SPD);

    /* 【关键】这是「别人回复我的帖子」，页面上的第一条通常是大叔的回复，
     * 而我自己的原帖在它下面（被回复的那条）。回复时必须两者都读：
     *   - 我原帖说了什么（上下文）
     *   - 他具体回了什么（要接住他的话）
     * 所以这里读多条帖子，自己那条当作「我的原帖」，别人那条当作「他的回复」。
     */
    const all = readTweets(6);
    const minePost = all.find((t) => isMyHandle(t.handle, beh) && (t.text || "").length > 4);
    const hisReply = all.find((t) => !isMyHandle(t.handle, beh) && (t.text || "").length > 2)
                  || all.find((t) => !isMyHandle(t.handle, beh));

    // 找不到别人说的话 → 说明没落到回复页，回通知页重试
    if (!hisReply) {
      await logAct("通知详情里没找到对方的回复，回通知页", "skip");
      ctx.phase = "notif"; await gotoNotifications(); saveCtx(ctx); return;
    }

    // 组装给生成器的「帖子」对象：正文 = 他的回复，附上我的原帖作为上下文
    const post = {
      ...hisReply,
      handle: hisReply.handle,
      text: hisReply.text,
      // 我的原帖正文（兜底用通知卡片里摘到的那句）
      ctxMyPost: (minePost && minePost.text) || ctx.current?.notifText || "",
      ctxReply: hisReply.text,
    };
    await logAct(`回复 @${post.handle}：他回「${norm(post.ctxReply).slice(0, 40)}」` +
      (post.ctxMyPost ? ` · 我的原帖「${norm(post.ctxMyPost).slice(0, 30)}」` : ""), "judge");

    if ((await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(
        { ...(await withAntiRepeat(post)), ctxMyPost: post.ctxMyPost, ctxReply: post.ctxReply },
        beh, beh.llm);
      const text = (gen.text || "").trim();
      // 通知回复也是公开发言，同样要过审核
      const rev = text && beh.review_enabled === true ? COMMENT_REVIEW.reviewComment(text,
        { text: post.ctxReply, ctxReply: post.ctxReply, myReplies: post.myReplies, scene: COMMENT_GEN.classifyPost(post.ctxReply || "") }, beh) : null;
      if (text && rev && !rev.pass) {
        await logAct(`回复不通过审核（${rev.score} 分 · ${rev.fatal}）→ 跳过`, "skip");
      } else if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[ctx.current.id] = { at: new Date().toISOString(), text: text.slice(0, 120), via: "notification" };
          });
          noteComment(text);
          await recordTweet(post, { comment: text.slice(0, 120), via: "notification" });
          await logAct(`✓ 回复 @${post.handle || ctx.current.handle}：${text}（${text.length} 字${rev ? ` · 审核 ${rev.score} 分` : ""} · ${srcTag(gen)}）`, "cmt");
        } else {
          await logAct(`✗ 回复失败：${r.error}`, "fail");
        }
      } else {
        await logAct(`跳过：没有合格回应（${gen.error || "空"}）`, "skip");
      }
    }
    ctx.phase = "notif";
    await gotoNotifications(); saveCtx(ctx);
  }

  // ---- 驱动 ----

  function stopLoop() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function loop() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!ctx || !ctx.run || aborted || busy) return;
      busy = true;
      try {
        if (Date.now() >= ctx.deadline) {
          const st = ctx.stats;
          await logAct(`结束：读 ${st.read} 展开 ${st.expanded} 赞 ${st.liked} 评 ${st.commented} 藏 ${st.bookmarked} 关注 ${st.followed} 滑过 ${st.skipped}`);
          stopSession(`本轮 ${ctx.durMin || "?"} 分钟跑满`);
          return;
        }
        const beh = await getBeh();
        checkAbort();
        // 恢复导航后的阶段：按当前 URL 校正
        if (ctx.phase === "home" && !onHome()) await goHome();
        checkAbort();
        switch (ctx.phase) {
          case "home": await stepHome(beh); break;
          case "explore": await stepExplore(beh); break;
          case "detail": await stepDetail(beh); break;
          case "profile": await stepProfile(beh); break;
          case "notif": await stepNotif(beh); break;
          case "notif_reply": await stepNotifReply(beh); break;
        }
        saveCtx(ctx);
      } catch (e) {
        if (e && e.name === "AbortError") {
          // 正常停止，不当作异常
        } else {
          await logAct(`步骤异常：${e && e.message}`);
        }
      } finally {
        busy = false;
      }
    }, 800);
  }

  // ---------------- 入口 ----------------

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    (async () => {
      if (m.t === "cmd") {
        if (m.op === "start") { await startSession(); reply({ ok: true }); }
        else if (m.op === "stop") { stopSession("手动停止"); reply({ ok: true }); }
        else if (m.op === "ping") reply({ ok: true, running: !!(ctx && ctx.run),
                                          phase: ctx && ctx.phase,
                                          me: whoami() || "",          // 当前登录的账号名
                                          stats: (ctx && ctx.stats) || null });
      }
    })();
    return true;
  });

  // 导航后恢复：新页面的 content 检查 sessionStorage 续跑
  (async () => {
    const saved = loadCtx();
    if (saved && saved.run) {
      ctx = saved;
      await sleep(1500);
      loop();
    }
  })();
})();
