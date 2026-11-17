/* sop.js —— 《X 新人浏览互动 SOP》判定层（Python 版 xauto/sop.py 的 JS 移植）
 *
 * 设计原则（SOP 第 0 节）：
 *   · 先理解再动作：没读懂就不赞不评
 *   · 阅读/点赞/评论/收藏/关注 各自独立判断，不搞链条
 *   · 没有可做的动作就跳过；不追求数量、比、固定间隔
 *   · 禁止：批量同义短评、承诺互关互赞、编造亲历
 *
 * 这里只放「判断」，不碰 DOM。content.js 负责采集和动作。
 */

const SOP = (() => {
  const SKIP_PATTERNS = [
    "互关", "互粉", "回关", "求关注", "关注我", "点个赞", "点赞回",
    "抽奖", "关注抽", "转发抽", "评论区留言", "评论区扣", "扣1", "滴滴我",
    "想要的扣", "留言发你", "私信我", "加群", "进群", "扫码", "看主页",
    "立刻验证", "连接钱包", "授权钱包", "空投领取", "助记词", "私钥",
    "骂战", "撕起来", "战队",
  ];
  const QUALITY_SIGNALS = [
    "因为", "但是", "不过", "限制", "前提", "适用", "不适合", "适合谁",
    "我的做法", "实测", "踩过", "遇到过", "具体来说", "举个例子", "例如",
    "数据", "来源", "文档", "版本", "成本", "坑",
  ];
  const BANNED_COMMENT = [
    "说得很好", "受益匪浅", "值得深思", "非常深刻", "感谢分享", "学习了",
    "很有启发", "干货", "点赞", "求关注", "互关", "回关", "互赞", "求带",
    "太强了", "牛啊", "支持一下", "前排", "沙发",
  ];
  const FABRICATION = [
    "我刚测过", "我昨天试了", "我上周刚", "我用了一周", "我朋友在做",
    "我们团队实测", "我刚买", "我刚部署",
  ];
  const INTEREST_KEYWORDS = [
    "AI", "Agent", "智能体", "大模型", "LLM", "prompt", "提示词", "RAG",
    "自动化", "效率", "产品", "创业", "独立开发", "写作", "读书", "思考",
    "赚钱", "搞钱", "副业", "运营", "增长", "出海", "代码", "编程", "开源",
  ];
  const GENERIC_TOKENS = new Set([
    "工具", "时间", "内容", "帖子", "这个", "那个", "真的", "就是", "可以",
    "东西", "问题", "方法", "感觉", "应该", "需要", "觉得", "还是", "不是",
  ]);

  const rand = () => Math.random();

  /* ---------- 阅读分层 ---------- */

  function shouldSkip(tw) {
    const text = (tw.text || "").trim();
    if (!text) return [true, "无正文（纯图/纯链接）"];
    const low = text.toLowerCase();
    for (const p of SKIP_PATTERNS) if (text.includes(p)) return [true, `命中跳过项：${p}`];
    if (text.length < 8 && !/[a-zA-Z]{4,}/.test(text)) return [true, "正文过短且无可读信息"];
    if (low.includes("http") && text.length < 40) return [true, "疑似纯链接"];
    return [false, ""];
  }

  function qualityScore(tw) {
    const text = tw.text || "";
    let s = 0;
    for (const sig of QUALITY_SIGNALS) if (text.includes(sig)) s += 1.0;
    s += Math.min(text.length, 400) / 400.0 * 1.5;
    if (/\d/.test(text)) s += 0.6;
    if (INTEREST_KEYWORDS.some((k) => text.toLowerCase().includes(k.toLowerCase()))) s += 1.0;
    return s;
  }

  function shouldExpand(tw, beh) {
    const text = tw.text || "";
    if (text.length >= 220) return true;
    if (tw.social) return true;
    if (/(回复|replied|Replying to)/i.test(text.slice(0, 80))) return true;
    return rand() < (beh.expand_prob ?? 0.25);
  }

  /* ---------- 点赞（第 3 节）---------- */

  function shouldLike(tw, beh) {
    if (shouldSkip(tw)[0]) return [false, "扫读阶段就跳过了"];
    const q = qualityScore(tw);
    const base = beh.like_prob ?? 0.35;
    const p = Math.min(0.9, base * (0.6 + q / 6.0));
    if (rand() > p) return [false, `概率外（${(p * 100) | 0}%）`];
    return [true, `质量分 ${q.toFixed(1)}，点赞概率 ${(p * 100) | 0}%`];
  }

  /* ---------- 评论（第 4 节）---------- */

  function shouldComment(tw, beh) {
    if (shouldSkip(tw)[0]) return [false, "扫读阶段就跳过了"];
    const text = tw.text || "";
    if (text.length < 15) return [false, "内容太薄，没有可接的具体点"];
    if (qualityScore(tw) < 1.2) return [false, "看不出具体点（都是泛泛而谈）"];
    const p = beh.comment_prob ?? 0.2;
    if (rand() > p) return [false, `概率外（${(p * 100) | 0}%）`];
    return [true, `评论概率 ${(p * 100) | 0}%`];
  }

  function specificOverlap(comment, postText) {
    const post = postText || "";
    let hits = 0;
    for (const run of (comment || "").match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (let i = 0; i < run.length - 1; i++) {
        const g = run.slice(i, i + 2);
        if (GENERIC_TOKENS.has(g)) continue;
        if (post.includes(g)) hits += 1;
      }
    }
    const low = post.toLowerCase();
    for (const w of (comment || "").match(/[A-Za-z0-9]{3,}/g) || []) {
      if (low.includes(w.toLowerCase())) hits += 1;
    }
    return hits;
  }

  function validateComment(comment, tw) {
    const c = (comment || "").trim();
    if (!c) return [false, "空评论"];
    if (c.length > 200) return [false, "过长（SOP 不要求长，长容易注水）"];
    for (const bad of BANNED_COMMENT) if (c.includes(bad)) return [false, `含禁用表达：${bad}`];
    for (const bad of FABRICATION) if (c.includes(bad)) return [false, `疑似编造亲历：${bad}`];
    if (["互关", "回关", "互赞", "关注我"].some((k) => c.includes(k)))
      return [false, "涉及互动交换（SOP 明令禁止）"];
    if (/^[\s\W_]+$/.test(c)) return [false, "纯表情/纯符号"];
    if (specificOverlap(c, tw.text || "") < 1)
      return [false, "没有接住原帖的具体点（换个帖也能用 → 不合格）"];
    return [true, "通过"];
  }

  /* ---------- 收藏（第 6 节）---------- */

  function shouldBookmark(tw, beh) {
    if (shouldSkip(tw)[0]) return [false, "扫读阶段就跳过了"];
    const text = tw.text || "";
    const useful = ["工具", "方法", "流程", "教程", "清单", "对比",
                    "限制", "价格", "文档", "实测", "踩坑"].some((k) => text.includes(k));
    if (!useful) return [false, "看不出以后会用到"];
    const p = beh.bookmark_prob ?? 0.05;
    if (rand() > p) return [false, `概率外（${(p * 100) | 0}%）`];
    return [true, "有复用价值"];
  }

  /* ---------- 关注（第 5 节）---------- */

  function shouldFollow(profile, recentTweets, why) {
    const bio = (profile.bio || "").trim();
    if (bio.length < 6) return [false, "简介看不出方向"];
    if (!recentTweets.length) return [false, "看不到近期原帖"];
    const good = recentTweets.filter((t) => qualityScore(t) >= 1.5 && !shouldSkip(t)[0]).length;
    if (good < Math.max(1, Math.floor(recentTweets.length / 3)))
      return [false, `近期 ${recentTweets.length} 条里只有 ${good} 条像认真内容`];
    if (!(why || "").trim()) return [false, "说不出关注理由"];
    return [true, `${good}/${recentTweets.length} 条符合，理由：${why.slice(0, 40)}`];
  }

  /* ---------- 通知（4.8 节）---------- */

  function notificationNeedsReply(text) {
    const t = (text || "").trim();
    if (!t) return [false, "空通知"];
    const parts = t.split(/(replied to you|回复了你|mentioned you|提到了你)/i);
    let body = (parts.length >= 2 ? parts[parts.length - 1] : t).trim(" ·:：-\n");
    body = body.replace(/·\s*\d+\s*[mhd]$/, "").trim();
    if (!body) return [false, "只有提示没有正文"];
    if (/^[\s\W_]+$/.test(body)) return [false, "纯表情/纯符号"];
    if (body.length < 4) return [false, "内容太短，无需追问"];
    return [true, "有实质内容"];
  }

  return {
    shouldSkip, qualityScore, shouldExpand, shouldLike, shouldComment,
    validateComment, specificOverlap, shouldBookmark, shouldFollow,
    notificationNeedsReply, INTEREST_KEYWORDS,
  };
})();
