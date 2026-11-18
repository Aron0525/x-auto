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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ri = (a, b) => Math.floor(rnd(a, b + 1));
  const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
  const send = (m) => chrome.runtime.sendMessage(m);

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
    showMore: '[data-testid="tweet-text-show-more-link"], [aria-label="Show more"]',
    newPostsBtn: '[aria-label="New posts"], [data-testid="floatingButton"], [data-testid="scrollToTopButton"]',
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

  async function calibrateOffset() {
    // 会话开始时用导航锚点学一次系统性偏移
    for (const sel of [SEL.navHome, SEL.navNotif, '[data-testid="SideNav_NewTweet_Button"]']) {
      const el = q(sel);
      if (!el) continue;
      const r = await stableRect(el);
      if (r.width <= 0) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (await hoverHits(el, cx + _off.dx, cy + _off.dy)) { _off.calibrated = true; return true; }
      const hit = await scanForHit(el, cx, cy, 36, 12);
      if (hit) {
        _off.dx += hit.dx; _off.dy += hit.dy; _off.calibrated = true;
        await logAct(`落点已标定：偏移 dx=${_off.dx} dy=${_off.dy}`);
        return true;
      }
    }
    await logAct("落点标定失败：将逐次校验，点不中就跳过");
    return false;
  }

  async function clickEl(el, opts = {}) {
    if (!el) return false;
    const r = await stableRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let x = cx + _off.dx, y = cy + _off.dy;
    if (!(await hoverHits(el, x, y))) {
      // 局部重扫：元素可能被时间线自动滚动挪走，或偏移变了
      const hit = await scanForHit(el, cx, cy, 24, 8);
      if (hit) { x = hit.x; y = hit.y; _off.dx += hit.dx; _off.dy += hit.dy; }
      else { await logAct("落点校验失败：鼠标移不到目标上，跳过这次点击"); return false; }
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
    // X 的加载转圈；视频音量条也是 progressbar 但带 aria-valuenow，排除
    return !!document.querySelector('[role="progressbar"]:not([aria-valuenow])');
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

  /* 时间线刷新与回顶（用户策略：帖子是无限流，新帖在上方，往下滑可能滑到旧帖）
   * 两种情况：
   *   a) 滚不出新帖（加载停滞）：等更久 → 触发刷新（重新拉取）→ 再等
   *   b) 滑到旧帖区：优先点顶部蓝色「新帖」箭头回顶；没有就滚回顶部
   * 返回 "refreshed" | "topped" | "timeout" 便于日志。 */
  async function refreshOrTop(reason) {
    const before = timelineSig();
    // 优先点顶部蓝色「新帖」箭头：回顶 + 触发刷新，最贴近真人操作
    const arrow = q(SEL.newPostsBtn);
    if (arrow && await clickEl(arrow, { settle: [1500, 2600] })) {
      await logAct(`${reason} → 点顶部「新帖」箭头回顶刷新`);
      await sleep(rnd(1200, 2200) * SPD);
      if (await waitTimelineChange(before, 15000, "顶部刷新")) return "refreshed";
      await sleep(rnd(4000, 8000) * SPD);
      return "topped";
    }
    // 没有箭头 → 滚回时间线顶部等新批次
    for (let i = 0; i < 8; i++) {
      await scrollBy(-2);
      await sleep(rnd(400, 800) * SPD);
      const top = q(SEL.article);
      if (!top || top.getBoundingClientRect().top < 80) break;
    }
    await logAct(`${reason} → 滚回时间线顶部等新帖`);
    if (await waitTimelineChange(before, 15000, "顶部刷新")) return "topped";
    return "timeout";
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

  async function clickNav(sel, label = "页面", waitSel = SEL.article) {
    await discardDrafts();
    const before = timelineSig(waitSel);
    if (!(await clickSel(sel, { settle: [1200, 2200] }))) return false;
    // 慢网适配：SPA 换页后必须等新内容渲染完再动手
    await waitContent(1, 25000, label, waitSel);
    await waitTimelineChange(before, 15000, label, waitSel);
    return true;
  }
  const goHome = () => clickNav(SEL.navHome, "首页");
  const gotoNotifications = () => clickNav(SEL.navNotif, "通知页", SEL.cell);
  const onHome = () => location.pathname === "/home";
  const onNotif = () => location.pathname === "/notifications";

  async function ensureHome() {
    if (onHome()) return true;
    await goHome();
    return onHome();
  }

  async function switchFeedTab(kind) {
    const re = kind === "following" ? /Following/i : /For you/i;
    const tab = [...document.querySelectorAll(SEL.tab)].find((t) => re.test(t.innerText || ""));
    if (!tab) { await logAct("没找到顶部栏目按钮（For You / Following），按当前栏目继续"); return false; }
    if (tab.getAttribute("aria-selected") === "true") {
      await logAct(`已在 ${kind === "following" ? "Following" : "For You"} 栏目，无需切换`);
      return true;
    }
    const before = timelineSig();
    const label = kind === "following" ? "Following" : "For You";
    if (!(await clickEl(tab, { settle: [1500, 2600] }))) return false;
    // 慢网：切栏目后时间线要重新拉取，等内容真的换一批再开始读
    await waitContent(1, 25000, label + " 栏目");
    const changed = await waitTimelineChange(before, 15000, label + " 栏目");
    await logAct(`已切到 ${label} 栏目${changed ? "（内容已更新）" : "（内容未见变化，继续）"}`);
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
    return out;
  }

  function readNotifications(n = 20, me) {
    const cells = [...document.querySelectorAll(SEL.cell)];
    const out = [];
    for (const c of cells) {
      if (out.length >= n) break;
      const link = c.querySelector('a[href*="/status/"]');
      const id = link ? (link.getAttribute("href").match(/\/status\/(\d+)/) || [])[1] : "";
      if (!id) continue;
      const text = norm(c.innerText).slice(0, 300);
      const low = text.toLowerCase();
      const mine = me && (low.includes(`回复 @${me.toLowerCase()}`) ||
                          low.includes(`replied to @${me.toLowerCase()}`) ||
                          low.includes(`提到 @${me.toLowerCase()}`) ||
                          low.includes("回复了你") || low.includes("mentioned you"));
      if (!mine) continue;
      const handle = ((c.querySelector(SEL.userNameLink) || {}).getAttribute
        ? (c.querySelector(SEL.userNameLink).getAttribute("href") || "").replace("/", "") : "");
      out.push({ id, handle, href: link.getAttribute("href"), text });
    }
    return out;
  }

  function whoami() {
    const a = q('[data-testid="AppTabBar_Profile_Link"]');
    const href = a ? a.getAttribute("href") || "" : "";
    return (href.match(/^\/([A-Za-z0-9_]+)/) || [])[1] || "";
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
  async function logAct(msg) {
    await withStore((s) => {
      s.activity.push({ at: new Date().toLocaleTimeString(), msg });
      s.activity = s.activity.slice(-300);
    });
    send({ t: "ui-ping" }).catch(() => {});
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

  async function recordTweet(tw, actions) {
    if (!tw || !tw.id) return;            // 从发现页直接进主页时没有帖子 id，不留档
    await withStore((s) => {
      s.records.push({ at: new Date().toLocaleString(), id: tw.id, href: tw.href,
                       handle: tw.handle, author: tw.author, text: (tw.text || ""), actions });
      s.records = s.records.slice(-2000);
    });
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

  async function getBeh() {
    const d = await chrome.storage.local.get(["xa_settings"]);
    const s = d.xa_settings || {};
    SPD = Math.max(0.5, Math.min(3, s.speed ?? 1.5));   // 全局速度系数生效点
    return {
      typing_ms: s.typing_ms ?? 130, session_minutes: s.session_minutes ?? 30,
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
      dedup_comment: s.dedup_comment !== false,
      focus_keywords: s.focus_keywords || "",
      follow_per_session: s.follow_per_session ?? 5,
      speed: s.speed ?? 1.5, feed: s.feed || "for_you",
      tone: s.tone || "friendly", style: s.style || "normal",
      limits: { like: s.max_like ?? 60, reply: s.max_reply ?? 20, follow: s.max_follow ?? 25 },
      llm: { apiKey: s.llm_key || "", baseUrl: s.llm_base || "https://api.deepseek.com/v1",
             model: s.llm_model || "deepseek-flash" },
      notif_enabled: !!s.notif_enabled,
    };
  }

  async function startSession() {
    const beh = await getBeh();
    SOP.setExtraKeywords(beh.focus_keywords);   // 面板自定义的重点关键词生效
    ctx = { run: true, phase: beh.notif_enabled ? "notif" : "home",
            feed: beh.feed, deadline: Date.now() + beh.session_minutes * 60000,
            started: Date.now(), seen: [], stats: { read: 0, expanded: 0, liked: 0,
            commented: 0, bookmarked: 0, followed: 0, skipped: 0 },
            notifTodo: [], current: null, plan: null };
    saveCtx(ctx);
    await logAct(`会话开始：时间盒 ${beh.session_minutes} 分钟 · 速度系数 ${SPD}（1=原速，越大越慢）`);
    if (!_off.calibrated) await calibrateOffset();
    loop();
  }

  function stopSession(reason) {
    if (ctx) { ctx.run = false; saveCtx(ctx); }
    logAct(`会话结束：${reason || "手动停止"}`);
    send({ t: "round-done" }).catch(() => {});
  }

  // ---- 各阶段一步 ----

  async function stepHome(beh) {
    if (!onHome()) { await goHome(); return; }
    if (ctx.feed && !ctx.tabDone) { await switchFeedTab(ctx.feed); ctx.tabDone = true; }
    // 每读 5 篇去发现页找一次可关注的人（用户策略：涨关注、涨时间线）
    if ((ctx.homeReads || 0) >= 5 && (await budgetLeft("follow", beh.limits.follow)) > 0) {
      ctx.homeReads = 0;
      ctx.phase = "explore"; saveCtx(ctx); return;
    }
    const tweets = readTweets(12);
    const fresh = tweets.filter((t) => !ctx.seen.includes(t.id));
    if (!fresh.length) {
      // 这一屏全是读过的帖子 = 要么滑进了旧帖区（新帖在上方），要么加载停滞。
      // 两种情况的解法一样：先等一会儿（慢网分页晚到），还不行就回顶/刷新。
      const before = document.querySelectorAll(SEL.article).length;
      await scrollBy(ri(2, 4));
      if (await waitMoreArticles(before, 20000)) { ctx.scrollTries = 0; return; }
      ctx.scrollTries = (ctx.scrollTries || 0) + 1;
      if (ctx.scrollTries >= 2) {
        await logAct("连续滚动都是读过的帖子（滑到旧帖区或加载停滞）→ 回顶部找新帖");
        await refreshOrTop("滑到旧帖区/加载停滞");
        ctx.scrollTries = 0;
        await sleep(rnd(8000, 15000) * SPD);
      }
      return;
    }
    // 选帖策略：按质量加权（重点领域 > 互动帖 > 内容质量），不是无脑第一条
    fresh.forEach((t) => ctx.seen.push(t.id));
    const tw = fresh.reduce((a, b) => (SOP.qualityScore(b) > SOP.qualityScore(a) ? b : a));
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
    if (skip) { ctx.stats.skipped++; await logAct(`滑过：${why}`); await recordTweet(tw, { skip: why }); saveCtx(ctx); return; }

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
    await logAct(`判定：${doLike ? "赞" : "不赞（" + whyLike + "）"} · ${doCmt ? "评" : "不评（" + whyCmt + "）"}${doBm ? " · 藏" : ""}${open ? " · 点开细看" : ""}`);

    if (!open) {
      let liked = false;
      if (doLike && (await budgetLeft("like", beh.limits.like)) > 0) {
        const ok = await likeInTimeline(tw.id);
        if (ok) {
          liked = true;
          ctx.stats.liked++; await addEvent("like");
          await withStore((s) => { s.liked[tw.id] = { at: new Date().toISOString() }; });
          await logAct(`✓ 赞（时间线）@${tw.handle}（按钮已变已赞态）`);
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
          await logAct(`✓ 赞 @${post.handle}（详情页，按钮已变已赞态）`);
        } else await logAct(`✗ 赞 @${post.handle}：按钮状态没翻转，没点到`);
      }
    }

    if (likedDetail) acts.like = true;

    if (ctx.plan.doCmt && (await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(post, beh, beh.llm);
      const text = (gen.text || "").trim();
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[tw.id] = { at: new Date().toISOString(), text: text.slice(0, 120) };
          });
          acts.comment = text.slice(0, 120);
          await logAct(`✓ 评论 @${post.handle}：${text}（${text.length} 字）`);
          await sleep(writeGap(beh));   // 写操作间隔：真人不会连发
        } else {
          await logAct(`✗ 评论失败：${r.error}`);
        }
      } else {
        await logAct(`评论跳过：${gen.error || "没有合格文案"}`);
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
      const mine = (whoami() || "").toLowerCase();
      if (handle && handle.toLowerCase() !== mine) {
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
    const mine = (whoami() || "").toLowerCase();
    if (handle && handle.toLowerCase() === mine) {
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
        const gen = await COMMENT_GEN.generate(t, beh, beh.llm);
        const text = (gen.text || "").trim();
        if (text) {
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
              await recordTweet(t, { comment: text.slice(0, 120) });
              await logAct(`✓ 主页互动：评论 @${handle}：${text.slice(0, 40)}`);
              await sleep(writeGap(beh));
            } else {
              await logAct(`✗ 主页互动评论失败：${r.error}`);
            }
            await goBack("作者主页");
            await waitContent(1, 15000, "作者主页");
          }
          continue;
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
    let followAct = false;
    if ((await budgetLeft("follow", beh.limits.follow)) > 0) {
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
            ctx.stats.followed++; await addEvent("follow");
            await withStore((s) => {
              s.followed[handle] = { at: new Date().toISOString(), reason: "主页看过再关注" };
            });
            await logAct(`✓ 关注 @${handle}（翻了 ${pool.length} 篇 + 赞 ${likedHere} 评 ${cmtHere} 后关注）`);
          } else {
            await logAct(`✗ @${handle} 关注未生效（按钮没翻转）`);
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
    await waitContent(1, 25000, "发现页");
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
    // 逐个摇概率，命中第一个就进主页
    for (const h of cands.slice(0, 5)) {
      if (Math.random() > p) {
        await logAct(`发现页 @${h}：概率外（${(p * 100) | 0}%），不点进去`);
        continue;
      }
      const cell = [...document.querySelectorAll(SEL.article), ...document.querySelectorAll(SEL.userCell)]
        .find((el) => [...el.querySelectorAll('a[href^="/"]')]
          .some((a) => (a.getAttribute("href") || "").toLowerCase() === "/" + h));
      const link = cell && (cell.querySelector(SEL.userNameLink) || cell.querySelector('a[href="/' + h + '"]'));
      if (!link) continue;
      if (!(await clickEl(link, { settle: [1500, 2600] }))) continue;
      ctx.current = { handle: h, text: "", id: "", href: "" };
      ctx.pendingActs = {};
      ctx.phase = "profile";
      await logAct(`发现页 命中 ${(p * 100) | 0}% 概率 → 点进 @${h} 主页查看`);
      saveCtx(ctx);
      return;
    }
    await logAct("发现页这一轮没命中概率，回首页继续刷");
    ctx.phase = "home"; await goHome(); saveCtx(ctx);
  }

  async function stepNotif(beh) {
    if (!onNotif()) { await gotoNotifications(); return; }
    if (!ctx.notifTodo.length && !ctx.notifLoaded) {
      const me = whoami();
      const items = readNotifications(20, me);
      const s = await storeGet();
      ctx.notifTodo = items.filter((it) =>
        SOP.notificationNeedsReply(it.text)[0] && !s.replied[it.id]);
      ctx.notifLoaded = true;
      await logAct(`通知：${items.length} 条与我相关，${ctx.notifTodo.length} 条值得回`);
    }
    if (!ctx.notifTodo.length) {
      ctx.phase = "home"; ctx.tabDone = false;   // feed 保持会话开始时的设置
      await goHome(); saveCtx(ctx); return;
    }
    if (Date.now() > ctx.started + (ctx.deadline - ctx.started) * 0.2) {
      // 通知只占前 20% 时间（SOP 11）
      ctx.phase = "home"; ctx.tabDone = false;
      await goHome(); saveCtx(ctx); return;
    }
    const it = ctx.notifTodo.shift();
    const cell = [...document.querySelectorAll(SEL.cell)]
      .find((c) => [...c.querySelectorAll(`a[href*="/status/${it.id}"]`)].length);
    const link = cell && cell.querySelector('a[href*="/status/"]');
    if (!link) { saveCtx(ctx); return; }
    if (!(await clickEl(link, { settle: [1500, 2600] }))) { saveCtx(ctx); return; }
    ctx.current = { id: it.id, href: it.href, handle: it.handle, text: it.text, author: it.handle };
    ctx.plan = { expand: true, doLike: false, doCmt: true, doBm: false };
    ctx.phase = "notif_reply";
    saveCtx(ctx);
  }

  async function stepNotifReply(beh) {
    await waitContent(1, 15000, "详情页");
    const [avail, whyNo] = postAvailable();
    if (!avail) { await logAct(`跳过：帖子不可用（${whyNo}）`); ctx.phase = "notif"; await gotoNotifications(); saveCtx(ctx); return; }
    await scrollBy(-ri(3, 6));               // 先看上文
    await sleep(rnd(800, 1600) * SPD);
    const detail = readTweets(3);
    const post = detail[0] || ctx.current;
    if ((await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(post, beh, beh.llm);
      const text = (gen.text || "").trim();
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[ctx.current.id] = { at: new Date().toISOString(), text: text.slice(0, 120), via: "notification" };
          });
          await recordTweet(post, { comment: text.slice(0, 120), via: "notification" });
          await logAct(`✓ 回复 @${post.handle || ctx.current.handle}：${text.slice(0, 40)}`);
        } else {
          await logAct(`✗ 回复失败：${r.error}`);
        }
      } else {
        await logAct(`跳过：没有合格回应（${gen.error || "空"}）`);
      }
    }
    ctx.phase = "notif";
    await gotoNotifications(); saveCtx(ctx);
  }

  // ---- 驱动 ----

  let timer = null;
  function loop() {
    if (timer) return;
    timer = setInterval(async () => {
      if (!ctx || !ctx.run || busy) return;
      busy = true;
      try {
        if (Date.now() >= ctx.deadline) {
          const st = ctx.stats;
          await logAct(`结束：读 ${st.read} 展开 ${st.expanded} 赞 ${st.liked} 评 ${st.commented} 藏 ${st.bookmarked} 关注 ${st.followed} 滑过 ${st.skipped}`);
          stopSession("时间盒到点");
          return;
        }
        const beh = await getBeh();
        // 恢复导航后的阶段：按当前 URL 校正
        if (ctx.phase === "home" && !onHome()) await goHome();
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
        await logAct(`步骤异常：${e && e.message}`);
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
        else if (m.op === "ping") reply({ ok: true, running: !!(ctx && ctx.run), phase: ctx && ctx.phase });
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
