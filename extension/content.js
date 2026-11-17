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
  };

  const DISCARD_TEXTS = ["不保存", "放弃", "丢弃", "Discard", "Don't save"];

  // ---------------- 基础动作 ----------------

  async function stableRect(el) {
    // 滚到视口中部并等滚动稳定（Python 版踩过的坑：滚动中读坐标是过渡值）
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(450);
    let r = el.getBoundingClientRect();
    for (let i = 0; i < 5; i++) {
      await sleep(250);
      const r2 = el.getBoundingClientRect();
      if (Math.abs(r2.x - r.x) < 1 && Math.abs(r2.y - r.y) < 1) { r = r2; break; }
      r = r2;
    }
    return r;
  }

  async function clickEl(el, opts = {}) {
    if (!el) return false;
    const r = await stableRect(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const res = await send({ t: "input", op: "click",
                             x: r.left + r.width / 2, y: r.top + r.height / 2 });
    await sleep(opts.settle ? rnd(...opts.settle) : rnd(500, 1100));
    return !!(res && res.ok);
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
                 notches: -notches });
    await sleep(rnd(500, 1000));
  }

  async function typeInto(el, text, beh) {
    if (!el) return false;
    if (!(await clickEl(el, { settle: [350, 700] }))) return false;
    await send({ t: "input", op: "hotkey", keys: ["ctrl", "a"] });
    await send({ t: "input", op: "hotkey", keys: ["backspace"] });
    await sleep(rnd(200, 400));
    const res = await send({ t: "input", op: "type", text,
                             perCharMs: beh.typing_ms || 130 });
    await sleep(rnd(300, 600));
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
      await sleep(rnd(400, 800));
    }
  }

  async function clickNav(sel) { await discardDrafts(); return clickSel(sel, { settle: [1200, 2200] }); }
  const goHome = () => clickNav(SEL.navHome);
  const gotoNotifications = () => clickNav(SEL.navNotif);
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
    if (tab) { await clickEl(tab, { settle: [1200, 2000] }); return true; }
    return false;
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
        text: norm(tx && tx.innerText).slice(0, 400),
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

  const followState = () =>
    q(SEL.unfollow) ? "following" : q(SEL.follow) ? "follow" : "none";

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
    await sleep(rnd(1500, 2500));
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
  async function logAct(msg) {
    const s = await storeGet();
    s.activity.push({ at: new Date().toLocaleTimeString(), msg });
    s.activity = s.activity.slice(-300);
    await storeSet(s);
    send({ t: "ui-ping" }).catch(() => {});
  }
  async function countToday(kind) {
    const s = await storeGet();
    const today = new Date().toISOString().slice(0, 10);
    return s.events.filter((e) => e.kind === kind && (e.at || "").startsWith(today)).length;
  }
  async function addEvent(kind) {
    const s = await storeGet();
    s.events.push({ kind, at: new Date().toISOString() });
    s.events = s.events.slice(-3000);
    await storeSet(s);
  }
  async function budgetLeft(kind, cap) { return Math.max(0, cap - (await countToday(kind))); }

  async function recordTweet(tw, actions) {
    const s = await storeGet();
    s.records.push({ at: new Date().toLocaleString(), id: tw.id, href: tw.href,
                     handle: tw.handle, author: tw.author, text: (tw.text || "").slice(0, 400), actions });
    s.records = s.records.slice(-2000);
    await storeSet(s);
  }

  // ---------------- 会话状态机 ----------------

  const CTX_KEY = "xa_ctx";
  const loadCtx = () => { try { return JSON.parse(sessionStorage.getItem(CTX_KEY)); } catch { return null; } };
  const saveCtx = (c) => c && c.run ? sessionStorage.setItem(CTX_KEY, JSON.stringify(c)) : sessionStorage.removeItem(CTX_KEY);

  let ctx = null;
  let busy = false;

  async function getBeh() {
    const d = await chrome.storage.local.get(["xa_settings"]);
    const s = d.xa_settings || {};
    return {
      typing_ms: s.typing_ms ?? 130, session_minutes: s.session_minutes ?? 30,
      like_prob: s.like_prob ?? 0.85, comment_prob: s.comment_prob ?? 0.8,
      expand_prob: s.expand_prob ?? 0.9, bookmark_prob: s.bookmark_prob ?? 0.3,
      follow_per_session: s.follow_per_session ?? 3,
      tone: s.tone || "friendly", style: s.style || "normal",
      limits: { like: s.max_like ?? 60, reply: s.max_reply ?? 20, follow: s.max_follow ?? 25 },
      llm: { apiKey: s.llm_key || "", baseUrl: s.llm_base || "https://api.deepseek.com/v1",
             model: s.llm_model || "deepseek-flash" },
      notif_enabled: !!s.notif_enabled,
    };
  }

  async function startSession() {
    const beh = await getBeh();
    ctx = { run: true, phase: beh.notif_enabled ? "notif" : "home",
            feed: "following", deadline: Date.now() + beh.session_minutes * 60000,
            started: Date.now(), seen: [], stats: { read: 0, expanded: 0, liked: 0,
            commented: 0, bookmarked: 0, followed: 0, skipped: 0 },
            notifTodo: [], current: null, plan: null };
    saveCtx(ctx);
    await logAct(`会话开始：时间盒 ${beh.session_minutes} 分钟`);
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
    const tweets = readTweets(12);
    const fresh = tweets.filter((t) => !ctx.seen.includes(t.id));
    if (!fresh.length) { await scrollBy(ri(2, 4)); return; }
    // 选帖策略：按质量加权（interest），不是无脑第一条
    fresh.forEach((t) => ctx.seen.push(t.id));
    const tw = fresh.reduce((a, b) => (SOP.qualityScore(b) > SOP.qualityScore(a) ? b : a));
    ctx.stats.read += 1;
    await sleep(rnd(1200, 5000));            // 真人扫读停顿

    const [skip, why] = SOP.shouldSkip(tw);
    if (skip) { ctx.stats.skipped++; await logAct(`滑过：${why}`); saveCtx(ctx); return; }

    const expand = SOP.shouldExpand(tw, beh);
    const [doLike, whyLike] = SOP.shouldLike(tw, beh);
    const [doCmt] = SOP.shouldComment(tw, beh);
    const [doBm] = SOP.shouldBookmark(tw, beh);
    ctx.plan = { expand, doLike, whyLike, doCmt, doBm };
    ctx.current = tw;

    if (!expand) {
      if (doLike && (await budgetLeft("like", beh.limits.like)) > 0) {
        const art = [...document.querySelectorAll(SEL.article)]
          .find((a) => (a.querySelector('a[href*="/status/"]') || {}).getAttribute &&
            a.querySelector('a[href*="/status/"]').getAttribute("href").includes(tw.id));
        const btn = art && art.querySelector(SEL.like);
        if (btn && await clickEl(btn, { settle: [600, 1200] })) {
          ctx.stats.liked++; await addEvent("like");
          const s = await storeGet(); s.liked[tw.id] = { at: new Date().toISOString() }; await storeSet(s);
          await logAct(`赞（时间线）@${tw.handle}`);
        }
      }
      await recordTweet(tw, doLike ? { like: true } : { skip: whyLike });
    } else {
      const art = [...document.querySelectorAll(SEL.article)]
        .find((a) => (a.querySelector('a[href*="/status/"]') || { getAttribute: () => "" })
          .getAttribute("href").includes(tw.id));
      const target = (art && art.querySelector(SEL.tweetText)) || art;
      if (!target || !(await clickEl(target, { settle: [1500, 2600] }))) {
        await logAct("详情打不开，跳过"); ctx.stats.skipped++; saveCtx(ctx); return;
      }
      ctx.phase = "detail";
    }
    saveCtx(ctx);
  }

  async function stepDetail(beh) {
    const tw = ctx.current || {};
    const [avail, whyNo] = postAvailable();
    if (!avail) {
      await logAct(`跳过：帖子不可用（${whyNo}）`);
      ctx.phase = "home"; ctx.tabDone = false; await goHome(); saveCtx(ctx); return;
    }
    ctx.stats.expanded++;
    await scrollBy(-ri(3, 6));               // 向上滑动读上下文（SOP：先读再动）
    await sleep(rnd(800, 1800));
    const detail = readTweets(3);
    const post = detail[0] || tw;
    post.handle = post.handle || tw.handle;

    if (ctx.plan.doLike && (await budgetLeft("like", beh.limits.like)) > 0) {
      const btn = q(SEL.like) || q(SEL.liked);
      if (btn === q(SEL.like) && await clickEl(btn, { settle: [600, 1200] })) {
        ctx.stats.liked++; await addEvent("like");
        const s = await storeGet(); s.liked[tw.id] = { at: new Date().toISOString() }; await storeSet(s);
        await logAct(`赞 @${post.handle}`);
      }
    }

    const acts = {};
    if (ctx.plan.doLike) acts.like = true;

    if (ctx.plan.doCmt && (await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(post, beh, beh.llm);
      const text = (gen.text || "").trim();
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          const s = await storeGet();
          s.replied[tw.id] = { at: new Date().toISOString(), text: text.slice(0, 120) };
          await storeSet(s);
          acts.comment = text.slice(0, 120);
          await logAct(`✓ 评论 @${post.handle}：${text.slice(0, 40)}`);
          await sleep(rnd(30000, 90000));   // 写操作间隔：真人不会连发
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

    // 关注：质量分够 + 本会话没超上限 + 今日有额度 → 点进主页看再决定
    const cap = beh.follow_per_session;
    if ((ctx.stats.followed || 0) < cap && (await budgetLeft("follow", beh.limits.follow)) > 0) {
      const s = await storeGet();
      const handle = post.handle || "";
      if (handle && !s.followed[handle] && SOP.qualityScore(post) >= 2.0) {
        const link = q(SEL.userNameLink);
        if (link && await clickEl(link, { settle: [1500, 2600] })) {
          ctx.pendingActs = acts;
          ctx.phase = "profile"; saveCtx(ctx); return;
        }
      }
    }
    await recordTweet(post, acts);
    ctx.phase = "home"; ctx.tabDone = false;
    await goHome(); saveCtx(ctx);
  }

  // 会话节奏：评论后停 30~90 秒（每日额度由 limits 控制）

  async function stepProfile(beh) {
    const bio = (q(SEL.bio) || {}).innerText || "";
    const recent = readTweets(5);
    const handle = ctx.current ? (ctx.current.handle || "") : "";
    const [ok, reason] = SOP.shouldFollow({ bio }, recent, "浏览时质量分已达标");
    const state = followState();
    if (state === "following") {
      const s = await storeGet(); s.followed[handle] = { at: new Date().toISOString(), state: "already" };
      await storeSet(s);
    } else if (ok && state === "follow" && (await budgetLeft("follow", beh.limits.follow)) > 0) {
      if (await clickSel(SEL.follow, { settle: [900, 1600] }) && followState() === "following") {
        ctx.stats.followed++; await addEvent("follow");
        const s = await storeGet(); s.followed[handle] = { at: new Date().toISOString(), reason: reason.slice(0, 60) };
        await storeSet(s);
        await logAct(`✓ 关注 @${handle}（${reason.slice(0, 40)}）`);
      } else {
        await logAct(`✗ @${handle} 关注未生效`);
      }
    } else if (!ok) {
      await logAct(`不关注 @${handle}：${reason}`);
    }
    const acts = ctx.pendingActs || {};
    delete ctx.pendingActs;
    await recordTweet({ ...(ctx.current || {}), handle }, acts);
    ctx.phase = "home"; ctx.tabDone = false;
    await goHome(); saveCtx(ctx);
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
      ctx.phase = "home"; ctx.feed = "following"; ctx.tabDone = false;
      await goHome(); saveCtx(ctx); return;
    }
    if (Date.now() > ctx.deadline * 0 + (ctx.started + (ctx.deadline - ctx.started) * 0.2)) {
      // 通知只占前 20% 时间（SOP 11）
      ctx.phase = "home"; await goHome(); saveCtx(ctx); return;
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
    const [avail, whyNo] = postAvailable();
    if (!avail) { await logAct(`跳过：帖子不可用（${whyNo}）`); ctx.phase = "notif"; await gotoNotifications(); saveCtx(ctx); return; }
    await scrollBy(-ri(3, 6));               // 先看上文
    await sleep(rnd(800, 1600));
    const detail = readTweets(3);
    const post = detail[0] || ctx.current;
    if ((await budgetLeft("reply", beh.limits.reply)) > 0) {
      const gen = await COMMENT_GEN.generate(post, beh, beh.llm);
      const text = (gen.text || "").trim();
      if (text) {
        const r = await replyCurrent(text, beh);
        if (r.ok) {
          ctx.stats.commented++; await addEvent("reply");
          const s = await storeGet();
          s.replied[ctx.current.id] = { at: new Date().toISOString(), text: text.slice(0, 120), via: "notification" };
          await storeSet(s);
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
