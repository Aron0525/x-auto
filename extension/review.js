/* review.js —— 评论质量审核（发送前的最后一道闸）
 *
 * 设计原则：
 *   1. **不通过就跳过，绝不发**。宁可少评一条，也不发一句不像人说的话。
 *   2. **每一分都要能解释**。日志里写清扣了什么分、为什么，用户能看懂、能调。
 *   3. **规则可配**。禁用词、阈值都在设置里，不改代码。
 *
 * 评分维度（满分 100）：
 *   ① 禁用词/格式    有就直接 0 分，一票否决
 *   ② 观点强度       有没有判断、因果、条件、取舍；纯情绪纯态度 = 低分
 *   ③ 与帖相关度     是否指向帖子里的具体内容，而不是放之四海皆准
 *   ④ 复述检查       把作者的话照搬回来 = 身份错位，重罚
 *   ⑤ 人味           模板腔、书面语、AI 味用语（"综上所述""值得注意的是"）
 *   ⑥ 长度与完整度   太短没信息，太长像论文；句子是否讲完整
 *   ⑦ 重复度         和已发过的评论、同帖已有回复是否撞车
 */

(function () {
  "use strict";

  // ---------- 一票否决：出现这些直接不发 ----------
  // 用户要求「评论不能出现「」」——中文直角引号会把原帖短语包起来，
  // 一眼就能看出是机器抓取的，所以默认禁用。
  const DEFAULT_BANNED = [
    "「", "」",              // 直角引号包裹原帖短语 ← 用户明确不要
    "综上所述", "总的来说", "值得注意的是", "需要指出的是",
    "首先", "其次", "最后一点",   // 议论文腔
    "作为一个AI", "作为 AI", "语言模型",
    "互关", "回关", "互赞", "求关注", "关注我",   // 刷量特征
    "点击链接", "私信我", "加我微信", "加V",
    "#", "@",               // 话题标签与@（平台会判定引流）
  ];

  // 编造亲历：说了自己没做过的事
  const FABRICATION = [
    "我测过", "我试过", "我用过", "我做过", "我朋友", "我同事",
    "我公司", "我团队", "亲身经历", "亲测",
  ];

  // AI 味 / 模板腔：出现就扣分（不是一票否决，可能只是用词稍微书面）
  const AI_FLAVOR = [
    "总的来说", "总体而言", "不难发现", "由此可见", "众所周知",
    "值得一提的是", "不可否认", "毋庸置疑", "综上所述",
    "在这个", "随着", "背景下", "维度", "层面", "赋能", "抓手",
    "闭环", "对齐", "颗粒度", "沉淀", "复盘一下",
  ];

  // 观点词：有判断、有因果、有条件、有取舍
  const OPINION_WORDS = [
    // 判断
    "我觉得", "我认为", "说实话", "老实说", "其实", "确实", "未必",
    "不一定", "恐怕", "估计", "看起来", "感觉", "说明", "意味着", "证明",
    // 因果/条件
    "因为", "所以", "因此", "导致", "结果", "前提", "取决于", "如果",
    "除非", "只要", "一旦", "否则", "靠", "取决于",
    // 转折/对比
    "但", "不过", "然而", "反而", "倒是", "相比", "比起", "而不是", "不是",
    // 取舍/成本
    "代价", "成本", "风险", "收益", "值得", "划算", "不划算", "负担",
    "难的是", "最难", "关键是", "重点是", "问题在于", "缺一不可",
    // 具体判断词
    "短期", "长期", "可持续", "执行", "落地", "节奏", "方向", "持续",
    "位置", "资源", "投入", "坚持", "复利", "分水岭", "坑", "爆款",
    "最终", "最后", "拼的", "本质", "核心", "重点", "前提",
  ];

  // 纯情绪/纯态度：只有这些 = 没观点
  const PURE_ATTITUDE = [
    "收藏了", "学到了", "受教了", "说得好", "有道理", "赞同",
    "支持", "加油", "厉害", "牛", "赞", "同感", "真实",
    "太对了", "说透了", "一针见血", "深有同感",
  ];

  // 口语/人味标志：像真人随手打的
  const HUMAN_MARKERS = [
    "啊", "吧", "呢", "嘛", "呗", "哈", "唉", "哎", "挺",
    "真的", "其实", "反正", "干脆", "说白了", "讲真", "老实讲",
    "这", "那", "就", "才", "都",
  ];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uniq = (arr) => [...new Set(arr)];

  /* 与帖子内容的关联度：评论里有多少「只有看过这条帖子才说得出」的成分。
   * 做法：从原帖抽出实词片段（2~4 字的连续中文），看评论命中多少。
   * 命中越多越说明接住了具体内容。 */
  function relevanceScore(comment, postText) {
    const c = String(comment || "");
    const src = String(postText || "");
    if (!c || !src) return 0;

    /* 双路匹配，因为只靠 2 字滑窗会漏掉「订阅」这种关键实词：
     *   ① 2 字滑窗：抓具体短语重合（「定投」「回撤」）
     *   ② 关键词：抓话题实词单独出现（订阅、付费、亏损…）
     * 任一路命中都算相关。 */

    // ① 2 字滑窗
    const norm = src.replace(/[\s，。！？、；：""''（）()《》【】\-—…·「」]/g, "");
    const STOP = new Set(["这个", "那个", "什么", "怎么", "可以", "就是", "不是",
                          "我们", "他们", "你们", "自己", "一个", "没有", "已经",
                          "因为", "所以", "但是", "如果", "还是", "这些", "那些",
                          "时候", "东西", "事情", "问题"]);
    const grams = uniq(
      Array.from({ length: Math.max(0, norm.length - 1) }, (_, i) => norm.slice(i, i + 2))
        .filter((g) => g.length === 2 && !STOP.has(g) && /^[\u4e00-\u9fa5]{2}$/.test(g))
    );
    let hit = 0;
    for (const g of grams) if (c.includes(g)) hit++;

    // ② 话题实词：帖子里出现、评论里也出现的双字以上实词
    const TOPIC_WORDS = ["订阅", "付费", "用户", "收入", "营收", "亏损", "回撤", "定投",
                         "仓位", "裁员", "简历", "面试", "求职", "副业", "兼职",
                         "推广", "分发", "产品", "开发", "创业", "招人", "招聘",
                         "团队", "员工", "内容", "选题", "写作", "读者", "更新",
                         "成本", "收益", "风险", "价格", "客户", "流量", "平台",
                         "方案", "方法", "流程", "工具", "效率", "时间"];
    let topicHit = 0;
    for (const w of TOPIC_WORDS) if (src.includes(w) && c.includes(w)) topicHit++;

    const score = Math.min(1, hit === 0 ? 0 : hit === 1 ? 0.5 : hit === 2 ? 0.8 : 1);
    const topicScore = Math.min(1, topicHit * 0.6);
    return Math.max(score, topicScore);
  }

  /* 主审核函数。
   * 返回：
   *   { pass: boolean, score: 0~100, grade: "优/良/合格/不合格",
   *     reasons: [扣分/加分说明], fatal: 一票否决原因（有就是致命） }
   */
  function reviewComment(comment, post, beh) {
    const c = String(comment || "").trim();
    const src = String((post && (post.ctxReply || post.text)) || "");
    const reasons = [];
    let score = 100;

    const banned = uniq([...(beh && beh.review_banned ? splitList(beh.review_banned) : []), ...DEFAULT_BANNED]);
    const threshold = clamp(beh && beh.review_threshold != null ? Number(beh.review_threshold) : 60, 0, 100);

    // ---------- ① 一票否决 ----------
    if (!c) return { pass: false, score: 0, grade: "不合格", reasons: ["空评论"], fatal: "空评论" };

    for (const w of banned) {
      if (w && c.includes(w)) {
        return { pass: false, score: 0, grade: "不合格",
                 reasons: [`命中禁用词「${w}」`], fatal: `含禁用词「${w}」` };
      }
    }
    if (/^[\s\p{P}\p{S}\p{Emoji_Presentation}]+$/u.test(c))
      return { pass: false, score: 0, grade: "不合格", reasons: ["纯符号/纯表情"], fatal: "纯符号/纯表情" };

    // ---------- ② 观点强度（30 分）----------
    /* 观点词分两档，避免「但」这种单字虚词凑数：
     *   强观点词（≥2 字，本身就是判断）：1 个就给 18 分
     *   弱观点词（单字转折）：只能加分不能独立算观点
     */
    const WEAK = new Set(["但", "才", "就", "还", "也", "靠"]);
    const opHitAll = OPINION_WORDS.filter((w) => c.includes(w));
    const opHit = opHitAll.filter((w) => !WEAK.has(w));
    const weakHit = opHitAll.filter((w) => WEAK.has(w));
    const attHit = PURE_ATTITUDE.filter((w) => c.includes(w));
    let opScore;
    if (opHit.length === 0 && weakHit.length === 0) {
      /* 没有观点词时看态度：
       * 【用户要求】有态度也行，不该一刀切。
       * 真实的好评论里，「这话扎心」「太真实了」这种就是人的正常反应，
       * 只要长度够、能接住原帖情绪，就该给中等分而不是最低分。 */
      if (attHit.length) {
        opScore = c.length >= 10 ? 15 : 8;   // 态度 + 长度够 → 15
        reasons.push(`只有态度（"${attHit[0]}"）没有明确观点 → 观点分 ${opScore}/30`);
      } else {
        opScore = 8;
        reasons.push(`看不出观点，像随口一句 → 观点分 ${opScore}/30`);
      }
    } else if (opHit.length === 0) {
      opScore = 12;
      reasons.push(`只有一个转折词（"${weakHit[0]}"），判断不明确 → 观点分 ${opScore}/30`);
    } else if (opHit.length === 1) {
      opScore = weakHit.length ? 22 : 18;
      reasons.push(`有一个判断点（"${opHit[0]}"）→ 观点分 ${opScore}/30`);
    } else if (opHit.length <= 3) {
      opScore = 26;
      reasons.push(`观点明确（${opHit.slice(0, 3).join("、")}）→ 观点分 ${opScore}/30`);
    } else {
      opScore = 30;
      reasons.push(`观点充分（${opHit.length} 个判断成分）→ 观点分 ${opScore}/30`);
    }
/* 只有态度、没有观点 → 不一定差。
     * 【2026-11-19 用户反馈】「有态度也行」，不该一刀切。
     * 现在只拦真正没信息量的：态度 + 极短（<8 字）+ 没接住原帖任何内容。
     * 「这话扎心，我也有同感」这种虽然没观点，但接住了情绪、长度也够 → 放行。 */
    if (attHit.length && opHit.length === 0) {
      const tooShort = c.length < 8;
      const noRelevance = relevanceScore(c, src) === 0;
      if (tooShort && noRelevance)
        return { pass: false, score: Math.min(score, 42), grade: "不合格",
                 reasons: [...reasons, `只有态度且太短（${c.length} 字），也没接住原帖`],
                 fatal: "纯态度短句（如「说得对」「收藏了」）" };
      reasons.push(`只有态度（"${attHit[0]}"）没有明确观点 → 观点分按 ${opScore}/30 计`);
    }

    // ---------- ③ 与帖相关度（25 分）----------
    /* 注意：整句模板不引用原帖短语，字面命中天然为 0。
     * 但这类句子是**按场景**写的（亏损帖配亏损句），本来就是相关的。
     * 所以设一个 12 分保底，避免好句子因为「没抄原帖词」被误杀。 */
    const rel = relevanceScore(c, src);
    let relScore = Math.round(rel * 25);
    if (relScore < 12) {
      /* 字面没重合时不能直接判跑题。分两种情况：
       *   ① 句子和原帖同属一个场景（亏损帖配亏损句）→ 本来就相关，给保底分
       *   ② 连场景都对不上，也没共同实词 → 大概率发错地方，重罚
       * 场景由 comment.js 的 classifyPost 判定，通过 post.scene 传进来。 */
      const postScene = post && (post.scene || (typeof COMMENT_GEN !== "undefined" && COMMENT_GEN.classifyPost
        ? COMMENT_GEN.classifyPost(src) : ""));
      const cmtScene = postScene ? guessSceneLike(c) : "";
      const sameScene = postScene && cmtScene === postScene;
      const topicHit = OPINION_WORDS.some((w) => c.includes(w) && src.includes(w));
      if (sameScene) {
        relScore = 16;
        reasons.push(`和帖子同属「${postScene}」类话题 → 相关度 ${relScore}/25`);
      } else if (topicHit || rel > 0) {
        relScore = 12;
        reasons.push(`没直接引用原帖词，但接住了话题方向 → 相关度 ${relScore}/25（保底）`);
      } else {
        relScore = 4;
        reasons.push(`看不出和帖子有关，像发错了地方 → 相关度 ${relScore}/25`);
      }
    } else if (relScore >= 20) {
      reasons.push(`接住了帖子的具体内容 → 相关度 ${relScore}/25`);
    } else {
      reasons.push(`和帖子有一定关联 → 相关度 ${relScore}/25`);
    }

    // ---------- ④ 复述检查（-35）----------
    let repeatPenalty = 0;
    const echo = echoesSrc(c, src);
    if (echo) {
      repeatPenalty = 35;
      reasons.push(`复述了原帖内容（"${echo}"）→ 扣 35 分`);
    }

    // ---------- ⑤ 人味（20 分）----------
    let humanScore = 20;
    const aiHit = AI_FLAVOR.filter((w) => c.includes(w));
    if (aiHit.length) {
      humanScore -= Math.min(12, aiHit.length * 6);
      reasons.push(`有书面/AI 腔（${aiHit.slice(0, 2).join("、")}）→ 人味 ${humanScore}/20`);
    }
    const fab = FABRICATION.filter((w) => c.includes(w));
    if (fab.length) {
      humanScore -= 8;
      reasons.push(`疑似编造亲历（"${fab[0]}"）→ 人味 ${humanScore}/20`);
    }
    const humanHit = HUMAN_MARKERS.filter((w) => c.includes(w));
    if (!aiHit.length && !fab.length) {
      reasons.push(humanHit.length ? `口语自然 → 人味 ${humanScore}/20` : `偏书面但没 AI 腔 → 人味 ${humanScore}/20`);
    }

    // ---------- ⑥ 长度与完整度（15 分）----------
    let lenScore = 15;
    const len = c.length;
    if (len < 8) { lenScore = 4; reasons.push(`太短（${len} 字）→ 长度 ${lenScore}/15`); }
    else if (len < 12) { lenScore = 10; reasons.push(`略短（${len} 字）→ 长度 ${lenScore}/15`); }
    else if (len <= 40) { reasons.push(`长度合适（${len} 字）→ 长度 ${lenScore}/15`); }
    else if (len <= 60) { lenScore = 10; reasons.push(`偏长（${len} 字）→ 长度 ${lenScore}/15`); }
    else { lenScore = 5; reasons.push(`太长（${len} 字）→ 长度 ${lenScore}/15`); }

    // 句子是否讲完整：以句号/问号/叹号结尾，或没有悬空的连接词
    if (/[，,、；;：:]$/.test(c)) { lenScore = Math.max(0, lenScore - 6); reasons.push("结尾是逗号，句子没讲完 → 再扣 6"); }
    if (/(因为|所以|但是|虽然|如果|当|把|被)$/.test(c)) { lenScore = Math.max(0, lenScore - 6); reasons.push("结尾悬空（连接词收尾）→ 再扣 6"); }

    // ---------- ⑦ 重复度（-30）----------
    let dupPenalty = 0;
    const hist = (post && post.allHistory) || [];
    for (const h of hist) {
      const s = sim(c, h);
      if (s >= 0.6) { dupPenalty = 30; reasons.push(`和发过的评论太像（相似 ${(s * 100) | 0}%）→ 扣 30`); break; }
    }
    const sameAuthor = (post && post.myReplies) || [];
    for (const h of sameAuthor) {
      const s = sim(c, h);
      if (s >= 0.55) { dupPenalty = Math.max(dupPenalty, 25); reasons.push(`和给同一作者发过的太像 → 扣 25`); break; }
    }

    // ---------- 汇总 ----------
    score = clamp(opScore + relScore + humanScore + lenScore - repeatPenalty - dupPenalty, 0, 100);
    const pass = score >= threshold;
    const grade = score >= 85 ? "优" : score >= 70 ? "良" : pass ? "合格" : "不合格";
    reasons.unshift(`总分 ${score}（阈值 ${threshold}）→ ${pass ? "通过" : "不通过"}`);

    return { pass, score, grade, reasons, fatal: pass ? "" : `质量分不足（${score} < ${threshold}）` };
  }

  /* 判断评论像哪个场景。用与 classifyPost 同源的关键词，
   * 但只看评论本身说了什么。返回场景名，判不出返回 ""。 */
  const SCENE_WORDS = {
    jobhunt:   ["简历", "面试", "裁员", "求职", "岗位", "内推", "海投", "招聘方", "35"],
    sidegig:   ["副业", "兼职", "月入", "接单", "额外收入", "下班后"],
    hiring:    ["招人", "招聘", "面试", "候选人", "筛人", "员工", "团队", "用人"],
    vent:      ["亏", "回撤", "行情", "仓位", "浮亏", "心态", "利润", "收益", "本金"],
    teaser:    ["憋", "惊喜", "期待", "神秘", "揭晓", "预告"],
    content:   ["内容", "选题", "写作", "输出", "爆款", "读者", "订阅", "留存", "打开率"],
    risky:     ["风险", "可持续", "合规", "灰色", "封号", "法律"],
    milestone: ["节点", "第一个", "里程碑", "坚持", "记录", "回头看"],
    build:     ["产品", "开发", "需求", "推广", "分发", "构建", "做出来", "上线"],
    opinion:   ["趋势", "判断", "时代", "行业", "本质", "变量", "方向", "位置"],
    general:   [],
  };

  function guessSceneLike(comment) {
    const c = String(comment || "");
    let best = "", bestN = 0;
    for (const [scene, words] of Object.entries(SCENE_WORDS)) {
      if (!words.length) continue;
      const n = words.reduce((k, w) => k + (c.includes(w) ? 1 : 0), 0);
      if (n > bestN) { bestN = n; best = scene; }
    }
    return bestN > 0 ? best : "";
  }

  function splitList(s) {
    return String(s || "").split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  }

  /* 复述检测：评论是否照搬了原帖的较长片段。
   * 只拦「把作者的话说成自己的」，正常引用不算。 */
  function echoesSrc(c, src) {
    if (!c || !src || src.length < 8) return "";
    const W = 8;
    for (let i = 0; i + W <= src.length; i++) {
      const seg = src.slice(i, i + W);
      const idx = c.indexOf(seg);
      if (idx < 0) continue;
      const before = c.slice(Math.max(0, idx - 6), idx);
      if (/我(也|就|已经|刚|刚刚|之前|直接|终于|当时)?$/.test(before)) return seg;
      if (/(^|[，。！？])我/.test(c) && c.length <= seg.length + 6) return seg;
    }
    return "";
  }

  /* 字符二元组相似度（0~1） */
  function sim(a, b) {
    const x = String(a || "").replace(/\s/g, "");
    const y = String(b || "").replace(/\s/g, "");
    if (!x || !y) return 0;
    if (x === y) return 1;
    const bg = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const k = s.slice(i, i + 2);
        m.set(k, (m.get(k) || 0) + 1);
      }
      return m;
    };
    const A = bg(x), B = bg(y);
    let inter = 0, union = 0;
    for (const [k, v] of A) { const w = B.get(k) || 0; inter += Math.min(v, w); union += Math.max(v, w); }
    for (const [k, v] of B) if (!A.has(k)) union += v;
    return union ? inter / union : 0;
  }

  globalThis.COMMENT_REVIEW = {
    reviewComment, relevanceScore, echoesSrc, sim,
    DEFAULT_BANNED, FABRICATION, AI_FLAVOR, OPINION_WORDS, PURE_ATTITUDE, HUMAN_MARKERS,
  };
})();
