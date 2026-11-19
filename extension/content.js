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
    newPostsBtn: '[data-testid="newTweetsPill"], [data-testid="floatingButton"], [data-testid="scrollToTopButton"], [aria-label="New posts"], [aria-label="新帖子"]',
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
    checkAbort();                    // 停止后不再发起新的点击
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

  /* 时间线刷新与回顶（用户策略：帖子是无限流，新帖在上方，往下滑会滑到旧帖）
   * 优先级（越靠前越像真人）：
   *   1) 点顶部蓝色「新帖」箭头 / 「Show N posts」按钮 —— 用户明确要求用这个
   *   2) 滚回时间线顶部
   *   3) 都动不了就等
   * 返回 "posts" | "topped" | "timeout"。 */
  async function refreshOrTop(reason) {
    const before = timelineSig();

    // 1) 「Show N posts」/「新帖」按钮（按可见文案找，选择器会随 X 改版变）
    const pill = findNewPostsPill();
    if (pill) {
      const label = (pill.innerText || "").trim().slice(0, 24);
      if (await clickEl(pill, { settle: [1500, 2600] })) {
        await logAct(`${reason} → 点「${label}」拉新帖`, "nav");
        await sleep(rnd(1200, 2200) * SPD);
        if (await waitTimelineChange(before, 15000, "拉取新帖")) return "posts";
        await sleep(rnd(4000, 8000) * SPD);
        return "topped";
      }
    }
    const arrow = q(SEL.newPostsBtn);
    if (arrow && await clickEl(arrow, { settle: [1500, 2600] })) {
      await logAct(`${reason} → 点顶部「新帖」箭头回顶刷新`, "nav");
      await sleep(rnd(1200, 2200) * SPD);
      if (await waitTimelineChange(before, 15000, "顶部刷新")) return "posts";
      await sleep(rnd(4000, 8000) * SPD);
      return "topped";
    }

    // 2) 没有按钮 → 滚回时间线顶部等新批次
    for (let i = 0; i < 8; i++) {
      await scrollBy(-2);
      await sleep(rnd(400, 800) * SPD);
      const top = q(SEL.article);
      if (!top || top.getBoundingClientRect().top < 80) break;
    }
    await logAct(`${reason} → 滚回时间线顶部等新帖`, "nav");
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

  /* 顶部 Feed 栏目：**必须同时认中英文**。
   * X 的界面语言跟着账号走 —— 正式号是中文界面（「为你推荐 / 正在关注」），
   * 旧代码写死 /For you/ 就必然找不到按钮。 */
  const FEED_LABELS = {
    for_you:   { re: /^(For you|为你推荐|为你|推荐)$/i,        cn: "为你推荐" },
    following: { re: /^(Following|正在关注|关注)$/i,            cn: "正在关注" },
  };

  async function switchFeedTab(kind) {
    const spec = FEED_LABELS[kind] || FEED_LABELS.for_you;
    // 先按精确文案匹配，匹配不到再退化成「包含」匹配（栏目标签可能带角标/省略）
    const tabs = [...document.querySelectorAll(SEL.tab)];
    let tab = tabs.find((t) => spec.re.test(norm(t.innerText)));
    if (!tab) {
      tab = tabs.find((t) => {
        const tx = norm(t.innerText);
        return tx.length <= 12 && (/for you|为你推荐/i.test(tx) === (kind !== "following"));
      });
    }
    if (!tab) {
      await logAct(`没找到顶部栏目按钮（${spec.cn}），按当前栏目继续`, "wait");
      return false;
    }
    if (tab.getAttribute("aria-selected") === "true") {
      await logAct(`已在「${spec.cn}」栏目，无需切换`);
      return true;
    }
    const before = timelineSig();
    const label = spec.cn;
    if (!(await clickEl(tab, { settle: [1500, 2600] }))) return false;
    // 慢网：切栏目后时间线要重新拉取，等内容真的换一批再开始读
    await waitContent(1, 25000, label + " 栏目");
    const changed = await waitTimelineChange(before, 15000, label + " 栏目");
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

  async function getBeh() {
    const d = await chrome.storage.local.get(["xa_settings", "xa_llm"]);
    const s = d.xa_settings || {};
    const L = d.xa_llm || {};        // API 配置独立存放，优先于旧字段
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
      // 至少读够多少篇才允许回顶刷新（防止反复刷同几条，看起来像脚本）
      min_read_before_refresh: s.min_read_before_refresh ?? 12,
      dedup_comment: s.dedup_comment !== false,
      focus_keywords: s.focus_keywords || "",
      // 我的账号名（测试号/正式号都填，逗号分隔）——用于「不碰自己帖子」判定
      my_handles: s.my_handles || "",
      follow_per_session: s.follow_per_session ?? 5,
      // 关注限流：两次关注的最小/最大间隔（秒）、每小时上限
      follow_gap_min: s.follow_gap_min ?? 60,
      follow_gap_max: s.follow_gap_max ?? 180,
      follow_per_hour: s.follow_per_hour ?? 8,
      speed: s.speed ?? 1.5, feed: s.feed || "for_you",
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

  async function startSession() {
    aborted = false;                       // 清掉上次停止留下的中断标志
    stopLoop();                            // 清掉可能残留的旧定时器
    const beh = await getBeh();
    SOP.setExtraKeywords(beh.focus_keywords);   // 面板自定义的重点关键词生效
    ctx = { run: true, phase: beh.notif_enabled ? "notif" : "home",
            feed: beh.feed,                     // 会话默认进的栏目（面板设置）
            feedNow: beh.feed,                  // 当前实际所在栏目（会随刷新失败切换）
            deadline: Date.now() + beh.session_minutes * 60000,
            started: Date.now(), seen: [], stats: { read: 0, expanded: 0, liked: 0,
            commented: 0, bookmarked: 0, followed: 0, skipped: 0 },
            notifTodo: [], current: null, plan: null };
    saveCtx(ctx);
    await logAct(`会话开始：时间盒 ${beh.session_minutes} 分钟 · 速度系数 ${SPD}（1=原速，越大越慢）`);
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
    if (await clickSel(SEL.navHome, { settle: [1500, 2600] })) {
      return await waitTimelineChange(before, 15000, "首页刷新");
    }
    return false;
  }

  // 找「Show N posts」/「新帖」按钮（按可见文案，X 会改版）
  function findNewPostsPill() {
    return [...document.querySelectorAll("button, div[role='button']")].find((el) => {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 40) return false;
      if (!/Show\s+\d+\s+posts?|显示\s*\d+\s*条|\d+\s*posts?|新帖子|新帖子?显示|new\s+posts?/i.test(t)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) || null;
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
    /* 栏目策略（用户说明）：主页时间线主要在「为你推荐」看；
     * 那里没帖子了再去「正在关注」。ctx.feedNow 记录当前实际所在栏目，
     * 换栏目由「刷新也没新帖」那段逻辑驱动。 */
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
    }
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
        // 【用户要求 6】如果 1 分钟内反复出现已看过的帖子 → 立刻点「Show N posts」拉新；
        // 超过 1 分钟还这样，说明刷新也没用，强制再刷一次。
        const now = Date.now();
        ctx.oldSince = ctx.oldSince || now;
        const stuckMs = now - ctx.oldSince;

        // 先试着点那颗「Show N posts」按钮（用户明确说就是这个）
        const pill = findNewPostsPill();
        if (pill && stuckMs < 60000) {
          const beforeSig = timelineSig();
          if (await clickEl(pill, { settle: [1500, 2600] })) {
            await logAct(`又出现看过的帖子 → 点「${(pill.innerText || "").trim().slice(0, 20)}」拉新帖`, "nav");
            if (await waitTimelineChange(beforeSig, 15000, "拉新帖")) {
              ctx.oldSince = 0; ctx.scrollTries = 0; return;
            }
          }
        }

        const readThisRun = ctx.homeReads || 0;
        const MIN_READ = beh.min_read_before_refresh ?? 12;
        if (readThisRun < MIN_READ && stuckMs < 60000) {
          await logAct(`读到的都是旧帖，但本轮才读 ${readThisRun}/${MIN_READ} 篇 —— 继续往下翻，先不刷新`, "wait");
          ctx.scrollTries = 0;
          await sleep(rnd(3000, 6000) * SPD);
          return;
        }

        await logAct(stuckMs >= 60000
          ? "连续 1 分钟以上都是看过的旧帖 → 强制刷新"
          : "连续滚动都是读过的帖子（滑到旧帖区或加载停滞）→ 回顶部拉新帖", "wait");
        const r = await refreshOrTop("旧帖卡住");
        ctx.homeReads = 0;
        ctx.oldSince = 0;
        ctx.scrollTries = 0;

        // 【用户策略】刷新也没用 → 换栏目看看。
        // 为你推荐刷不动了就切「正在关注」，正在关注也没了就切回「为你推荐」，来回换。
        // 两个栏目都没有新帖时才真正等待（这时是真的没内容）。
        if (r === "timeout" || r === "topped") {
          ctx.noNewRounds = (ctx.noNewRounds || 0) + 1;
          if (ctx.noNewRounds >= 2) {
            const cur = ctx.feedNow || ctx.feed || "for_you";
            const next = cur === "following" ? "for_you" : "following";
            ctx.noNewRounds = 0;
            await logAct(`「${FEED_LABELS[cur]?.cn || cur}」拉不出新帖了 → 换到「${FEED_LABELS[next].cn}」看看`, "nav");
            if (await switchFeedTab(next)) {
              ctx.feedNow = next;
              ctx.seen = [];              // 换栏目后内容不同，重新从零开始记「读过」
              ctx.homeReads = 0;
              await sleep(rnd(3000, 6000) * SPD);
              return;
            }
          }
        } else {
          ctx.noNewRounds = 0;
        }
        await sleep(rnd(8000, 15000) * SPD);
      }
      return;
    }
    ctx.oldSince = 0;   // 出了新帖就清空「旧帖计时」
    ctx.noNewRounds = 0;
    // 选帖策略：按质量加权（重点领域 > 互动帖 > 内容质量），不是无脑第一条
    fresh.forEach((t) => ctx.seen.push(t.id));

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
      if (ctx.mineSkips >= 4) {          // 连续几屏都是自己的 → 回顶部换一批
        ctx.mineSkips = 0;
        await logAct("连续几屏都是自己的帖子 → 回顶部拉新一批", "nav");
        await refreshOrTop("整屏都是自己的帖子");
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
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[tw.id] = { at: new Date().toISOString(), text: text.slice(0, 120) };
          });
          acts.comment = text.slice(0, 120);
          noteComment(text);
          await logAct(`✓ 评论 @${post.handle}：${text}（${text.length} 字）`, "cmt");
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
              noteComment(text);
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
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          await withStore((s) => {
            s.replied[ctx.current.id] = { at: new Date().toISOString(), text: text.slice(0, 120), via: "notification" };
          });
          noteComment(text);
          await recordTweet(post, { comment: text.slice(0, 120), via: "notification" });
          await logAct(`✓ 回复 @${post.handle || ctx.current.handle}：${text}（${text.length} 字）`, "cmt");
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
          stopSession("时间盒到点");
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
