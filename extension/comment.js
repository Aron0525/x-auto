/* comment.js —— 评论生成（Python 版 xauto/comment.py 的 JS 移植）
 *
 * 两层：
 *   1. 面板里配了密钥 → 让 LLM 读完帖子写一句（内容脚本 fetch 会被 CORS 拦，
 *      所以经 background 代发；密钥存 chrome.storage.local，不进 git）
 *   2. 没密钥 / 调用失败 → 模板句兜底（抓帖子里信息量最大的子句）
 *
 * 硬规则：一句话；必须接住原帖的具体点；不空话、不编造亲历、不互动交换。
 */

globalThis.COMMENT_GEN = (() => {
  const TONE_HINT = {
    friendly: "语气随和，像朋友随口接一句，可以带一点口语。",
    professional: "语气专业克制：讲事实、给判断或补充信息，不寒暄、不调侃。",
    humorous: "语气轻松幽默：可以自嘲或小小调侃，但不刻薄、不嘲讽作者。",
    curious: "语气好奇：以提问或请教为主，表示想了解更多细节。",
    supportive: "语气共情：先认同对方的感受或处境，再补一句自己的看法。",
    sharp: "语气直接：可以提出不同意见，但只针对观点，不针对人。",
  };
  const STYLE_HINT = {
    short: "长度 10~25 字，一句话说完。",
    normal: "长度 20~60 字，一到两句话。",
    detailed: "长度 60~120 字，给出具体理由或补充一个细节。",
  };
  const SCENES = {
    tool: ["AI 工具/产品分享", "指出它的一个具体用途或限制，不要只说「太强了/求教程」。"],
    knowledge: ["知识分享", "补一个原帖没展开、但和主题直接相关的机制或反例。"],
    social: ["社会现象", "可以提出一种解释并留下边界；不要给一群人贴标签。"],
    help: ["技术或使用求助", "信息不足时只问一个能缩小范围的问题；有办法时给可执行的下一步。"],
    work: ["作品或成果展示", "先指出一个看得见的设计，再问一个作者容易回答的小问题。"],
    newbie: ["新人帖/出摊帖", "接住对方已经提到的内容；可以很短，但不要同一句招呼轮换。"],
    chat: ["日常闲聊", "先接对方的具体情境，不要强行转到自己的领域，也不虚构共同经历。"],
    reply_to_me: ["回复我的评论", "把问题收束到对方能接着回答的选择；纠正事实要核对后致谢或更正。"],
  };

  function classifyScene(text, isReplyToMe) {
    const t = text || "";
    if (isReplyToMe) return "reply_to_me";
    if (["不等于", "本质", "关键在于", "归根到底", "道理", "原理", "往往比"].some((k) => t.includes(k))) return "knowledge";
    if (["求助", "报错", "怎么解决", "跑不通", "装不上", "求大佬", "卡住"].some((k) => t.includes(k))) return "help";
    if (["新来的", "新人", "出摊", "交个朋友", "串门", "认识一下"].some((k) => t.includes(k))) return "newbie";
    if (["新工具", "插件", "软件", "产品", "上线了", "内测", "价格", "免费", "付费", "app", "App", "小程序"].some((k) => t.includes(k))) return "tool";
    if (["做了个", "我的作品", "开源", "仓库", "demo", "Demo", "截图"].some((k) => t.includes(k))) return "work";
    if (["数据", "统计", "研究", "报道", "社会", "现象", "趋势", "年轻人"].some((k) => t.includes(k))) return "social";
    if (["今天", "桌面", "晚饭", "天气", "熬夜", "通勤"].some((k) => t.includes(k))) return "chat";
    return "knowledge";
  }

  const SYSTEM_PROMPT = `你在 X 上刷时间线，看完一条帖子，想留一条评论。

一条值得发的评论通常有三部分（不必写成填空，但三样都要在）：
1. 锚定：明确你在回原帖里的**哪一个具体点**（某个说法、数字、做法、限制）
2. 贡献：补一个信息、一个限制、一个解释、一个不同判断，或提一个对方能回答的具体问题
3. 边界：不编造「我刚测过」，不承诺回关/互赞，不把猜测写成结论，不评价人

硬性规则（违反任何一条都算失败）：
1. 只输出评论正文：不要换行、不要分点、不要引号、不要解释。
2. 必须出现原帖里的具体词或细节 —— 判断标准是：**这句话只有看过这条原帖才写得出来**。
   放到任何帖子下面都成立的句子（「说得好」「学到了」「太强了」）一律不合格。
3. 不要话题标签（#），不要 @ 人，不要贴链接，不要推销自己的账号或工具。
4. 不要空话套话，不要为了凑字数或凑问句。
5. 不引战、不评价作者能力或身份、不涉及政治/地域/性别等敏感面。
6. 原帖已经写明的细节不要再假装追问；也不要把简单意思为了凑字数拉长。
【本次场景】{scene}：{scene_hint}
【本次语气】{tone}
【本次长度】{style}`;

  const AVOID = ["说得很好", "受益匪浅", "值得深思", "非常深刻", "感谢分享", "学习了",
                 "很有启发", "深刻", "干货", "点赞"];

  function clean(text) {
    let t = (text || "").trim();
    for (const pref of ["评论：", "评论:", "回复：", "回复:"]) if (t.startsWith(pref)) t = t.slice(pref.length).trim();
    if (t.length >= 2 && "“\"'「".includes(t[0]) && "”\"'」".includes(t[t.length - 1])) t = t.slice(1, -1).trim();
    t = t.replace(/\s+/g, " ").replace(/#/g, "");
    return t.trim();
  }

  const maxChars = (style) => ({ short: 30, normal: 70, detailed: 140 })[style] || 80;

  function valid(text, style) {
    if (!text || text.length > maxChars(style)) return false;
    return !AVOID.some((w) => text.includes(w));
  }

  /* ---------- 模板兜底 ---------- */

  const CLAUSE_SPLIT = /[。！？；;!?\n]+/;
  const HEAD_NOISE = ["我突然发现", "兄弟们", "家人们", "姐妹们", "说真的", "讲真",
                      "绝了", "震惊", "谁懂", "亲测"];

  function cut(s, limit) {
    s = s.trim();
    if (s.length <= limit) return s.replace(/[，。,.!?！？]+$/, "");
    const window = s.slice(0, limit);
    for (const [sep, thresh] of [["，", 0.5], ["、", 0.5], ["；", 0.5], [",", 0.5], [" ", 0.75]]) {
      const idx = window.lastIndexOf(sep);
      if (idx >= limit * thresh) return window.slice(0, idx).replace(/[，,、]+$/, "") + "…";
    }
    return window.slice(0, limit - 1) + "…";
  }

  /* 从原帖里挑一个「值得回应的具体短语」。
   * 之前的坑：不分内容质量地挑最长的子句再硬截断，结果拼出
   *   「5、开源免…」这种数字开头的残句 + 模板尾巴，人能看出来是机器拼的。
   * 现在：① 剔掉列表序号/编号开头的；② 剔掉信息量太低的；
   *       ③ 优先带观点或事实的句子；④ 宁可返回空也不返回残句。 */
  const LOW_INFO = /^(今天|昨天|最近|感觉|觉得|这个|那个|我们|他们|还是|就是|然后|所以|但是|不过|其实|可能)/;
  // 纯虚词/口语填充：整句都是这些，说明没实质内容
  const FILLER = /^(这个|那个|这样|那样|这些|那些|一下|真的|确实|应该|可以|需要|东西|事情|问题|时候|地方|感觉|觉得|其实|反正|基本|大概)+$/;

  function usablePhrase(s) {
    if (!s || s.length < 6) return false;
    if (/^[\d\s.、,，)）]/.test(s)) return false;          // 数字/序号开头（"5、开源免…"）
    if (/…|\.\.\.|．{2,}/.test(s)) return false;           // 自带省略号的残句（原文被截断过）
    if (/^[a-zA-Z]{1,3}$/.test(s)) return false;
    if (LOW_INFO.test(s) && s.length < 14) return false;   // 开头就是口头语且太短
    if (FILLER.test(s)) return false;                      // 全是填充词
    if (/(^|\s)(https?:\/\/|www\.)/.test(s)) return false;
    // 至少要有一个「实词感」的字：去掉标点和常见虚词后仍有 4 个字以上
    const solid = s.replace(/[的了吗呢吧啊呀哦嗯是在有不我你他她们这那和就都也很还都]/g, "");
    if (solid.length < 4) return false;
    return true;
  }

  function shortPhrase(text, limit = 16) {
    const clauses = (text || "").split(CLAUSE_SPLIT)
      .map((c) => c.trim().replace(/^[\s\d.、,，)）(（]+/, "").replace(/[，,、：:]+$/, ""))
      .filter(Boolean)
      .filter(usablePhrase);
    if (!clauses.length) return "";

    const scored = clauses.map((c) => {
      let s = 0;
      for (const kw of SOP.INTEREST_KEYWORDS) if (c.toLowerCase().includes(kw.toLowerCase())) s += 1.0;
      if (SOP.focusHit && SOP.focusHit(c)) s += 1.2;
      if (c.includes("因为") || c.includes("所以") || c.includes("但是") || c.includes("不过")) s += 0.6;
      if (/\d/.test(c)) s += 0.3;
      return { c, s };
    });
    scored.sort((a, b) => b.s - a.s);

    /* 【纪律】只返回「能独立读通的完整片段」，绝不硬切。
     * 之前硬切出来的「半导体周期见」「我觉得这个工」，人一眼就能看出是机器拼的。 */
    const MIN = 4;
    // ① 整句就是合适长度的短语
    const fit = scored.find((x) => x.c.length >= MIN && x.c.length <= limit);
    if (fit) return fit.c;

    // ② 按标点切成小段，取第一段长度合适的
    for (const { c } of scored) {
      const parts = c.split(/[，,、；;]/).map((s) => s.trim()).filter((s) => s.length >= MIN);
      const p = parts.find((s) => s.length <= limit);
      if (p) return p;
    }

    // ③ 都超长 → 取「最短的完整分段」，允许整句略超目标字数。
    //    用户明确要求：宁可多写几个字把话说完整，也不要硬截断。
    //    仍然只取**完整**的逗号分段，不会切出「半导体周期见」这种半句。
    for (const { c } of scored) {
      const parts = c.split(/[，,、；;]/).map((s) => s.trim()).filter((s) => s.length >= MIN);
      if (parts.length) return parts.reduce((a, b) => (b.length < a.length ? b : a));
    }

    // ④ 实在切不出分段 → 返回空，调用方用纯观点句
    return "";
  }

  const TYPE_HINTS = {
    ask: ["？", "?", "怎么", "为什么", "有没有", "求问", "谁知道", "请教", "求助", "要不要", "值得吗"],
    howto: ["步骤", "方法", "教程", "实操", "清单", "流程", "搭建", "配置", "复盘", "模板", "工具链", "踩坑", "源码"],
    vent: ["资本家", "精神内耗", "离谱", "无语", "破防", "服了", "笑死", "劝退", "太难", "跪", "窒息", "白嫖", "压榨"],
  };
  const TEMPLATES_BY_TYPE = {
    vent: ["代入了一下血压就上来了，这种事真不少见。",
           "看笑了，只能说这行情谁都在硬撑。",
           "这段我看完先沉默了半分钟，太真实了。"],
    ask: ["同问，这块我也一直没搞明白，蹲个答案。",
          "我也想知道，之前试过两次都没跑通。",
          "这个问题我遇到过，等懂的人说说。"],
    howto: ["「{p}」这步我照着试了下，确实比之前省事。",
            "记下来了，我一直是硬怼过去的，没这么系统。",
            "流程拆得挺清楚，回头照着跑一遍。"],
    view: ["「{p}」这点我认，真做起来才知道难在哪。",
           "同意「{p}」，剩下的就是能不能一直做下去。",
           "「{p}」——比听起来难，但方向是对的。",
           "这思路我记下了，回头自己试一遍。"],
  };

  function classifyType(text) {
    const t = text || "";
    if (t.includes("？") || t.includes("?")) return "ask";
    for (const kind of ["ask", "howto", "vent"])
      if (TYPE_HINTS[kind].some((h) => t.includes(h))) return kind;
    return "view";
  }

  let lastTpl = -1;
  function template(post) {
    const text = post.text || "";
    const kind = classifyType(text);
    const pool = TEMPLATES_BY_TYPE[kind] || TEMPLATES_BY_TYPE.view;
    const phrase = shortPhrase(text) || "这个方向";
    let idx = 0;
    if (pool.length > 1) {
      const choices = pool.map((_, i) => i).filter((i) => i !== lastTpl);
      idx = choices[Math.floor(Math.random() * choices.length)];
    }
    lastTpl = idx;
    return pool[idx].replaceAll("{p}", phrase);
  }

  /* ---------- 我的规则：短评（回应帖子 + 表达观点，13 字左右，上限 20 字）----------
   * 用户要求：什么帖子都能评、不超 20 字、最好 13 字左右且随机、内容 = 回应帖子 + 观点。
   * 这里给 LLM 一套极简指令，模板兜底也换成短句池（不再是 SOP 那套长模板）。 */

  /* 默认提示词（2026-11-18 重写）。
   * 起因：正式号把「即时通讯回复助手」的提示词直接搬来当评论提示词，
   * 模型以为在跟人私聊，于是顺着对话逻辑复述对方的话
   * （作者说「我上架了」，它也回「我上架了」）。
   * 结构沿用那段提示词的简洁风格，但**场景必须说清**：
   *   · 你是浏览帖子的用户，不是对话的另一方
   *   · 帖子作者是别人，你是在评论他写的内容
   *   · 绝不能复述作者的话、不能说自己做了他描述的事
   * 占位符：{len} 目标字数、{lo}/{hi} 建议区间、{tone} 语气、{post} 原帖正文 */
  const DEFAULT_MINE_PROMPT = `你是一个在 X（推特）上浏览帖子的普通用户，只输出 1 条公开评论。

帖子作者是别人，你是评论者，针对帖子内容发表看法：可以认同并补充、可以保留意见、可以说出你的判断。

绝不能复述作者的话，也不能说自己做了帖子里描述的事（作者说他上架了产品，你不能说你也上架了——那是他的事，不是你的）。

回复语言跟随帖子：帖子用英文就用自然英文，帖子用中文就用中文。

长度大约 {len} 字最理想，但不是硬上限，话说完整优先，口语自然，像真人随手评论。

不要解释、不要客套、不加话题标签、不@人、不贴链接、不编造亲身经历，直接输出这句评论本身。

语气：{tone}`;

  /* 短句模板池（2026-11-18 第三次重做）。
   *
   * 前两版都失败，教训记在这里：
   *   第 1 版：「{p}我收藏了」→ 没有观点，纯情绪。
   *   第 2 版：「{p}这个判断有道理，落地最难」→ 观点和帖子不匹配，
   *            帖子在讲亏钱，评论说「落地最难」，牛头不对马嘴。
   *
   * 根因：**「抓一个短语 + 套一个固定观点」这个模型本身就是错的**。
   * 短语是碎片（「只有 9 美元」「一年多来」），固定观点和它对不上，拼出来必然像机器。
   *
   * 第 3 版改成：**先判断帖子类型，再用该类型的整句**。
   * 整句自带完整的「回应 + 观点」，不依赖脆弱的短语拼接。
   * {p} 仍然可用，但只作为可选前缀，且优先选有信息量的片段。
   */
  const MINE_TEMPLATES_BY_SCENE = {
    // 亏损/挫折/吐槽：先共情处境，再给一个不廉价的判断
    vent: [
      "这种回撤最难受的是把之前的利润全吐回去，心态比钱更难修。",
      "一年定投抵不过几天行情，这事最磨人的地方就是让人怀疑方法本身。",
      "赚的时候觉得是自己本事，亏回去才明白大部分是行情给的。",
      "单看一个月的回撤没意义，扛不扛得住下一轮才是分水岭。",
      "这种时候最忌讳临时改策略，往往改在最低点。",
      "账面利润本来就不算数，落袋之前都是浮盈。",
    ],
    // 独立开发/创业经验：给具体的判断，不泛泛认同
    build: [
      "闷头改产品最舒服，因为不用面对没人用这件事，本质是逃避。",
      "先抄一个验证过的需求不丢人，第一次创业活下去比原创重要。",
      "分发比构建难这件事，做过一次的人不用解释，没做过的解释也没用。",
      "真正的坑是做了半年才发现没人要，不是做不出来。",
      "自己觉得好的东西和市场愿不愿意付费，中间隔着一条河。",
      "早期最该做的事是把它扔出去被人嫌弃，而不是继续打磨。",
    ],
    // 行业/趋势观点：可以不同意，但要给理由
    opinion: [
      "构建成本降了，意味着稀缺的东西变成了注意力和信任。",
      "工具再强也解决不了「做什么」这个问题，那还是人的判断。",
      "门槛降低的结果通常是混战，最后活下来的是有渠道的。",
      "这个判断我部分同意，但它忽略了时间这个变量。",
      "趋势对不代表个体能吃到，位置比方向更重要。",
    ],
    // 成果/里程碑分享：肯定 + 指出后面真正难的地方
    milestone: [
      "第一个付费用户最难，从 0 到 1 的心理门槛比数字重要得多。",
      "9 美元的分量和 9000 美元不一样，这一步是从想法变成生意的证据。",
      "订阅从 0 到 3000，最难的是中间那段没人看的时期。",
      "能做到这个数字，说明选题和坚持缺一不可，光靠内容质量不够。",
      "这种节点值得记下来，以后回头看才知道自己走了多远。",
    ],
    // 招人/管理类：给一个可操作的判断
    hiring: [
      "兴趣确实教不了，但光有兴趣扛不住长期枯燥，还得看耐受力。",
      "技术能教这句我认同，不过筛人的时候最难判断的恰恰是兴趣真假。",
      "看一个人对什么感兴趣，其实看他业余时间花在哪最准。",
      "招错人的成本远高于招慢一点，这个岗位尤其。",
    ],
    // 争议/擦边/灰产类：不做道德评判，只谈可持续性
    risky: [
      "这类需求确实存在，但平台规则一变就可能归零。",
      "赚得快，风险也大，做不长。",
      "收入数字好看，但可持续性存疑。",
      "这种业务最怕政策收紧，钱可能来得快去得也快。",
    ],
    // 通用兜底：也要有实质判断，不能是「说得对」
    general: [
      "这个角度我之前没往这想，但细想确实成立。",
      "结论能不能成立，取决于背后那些没写出来的前提。",
      "这类事没有标准答案，看的是愿意承担哪种代价。",
      "说得具体，比那些只给结论的文章有用多了。",
      "看长期的话，这类选择的影响会被时间放大。",
      "真正难的不是知道该做什么，是在没人反馈的时候还继续做。",
      "这种复盘比事后总结有价值，因为能看到当时是怎么想的。",
      "信息密度够，比那种绕半天不给结论的强多了。",
    ],
    // 预告/悬念类：「今晚揭晓」这种，不硬猜内容
    teaser: [
      "铺垫这么久，期待一下，希望不是又一次吊胃口。",
      "能把事憋这么久不发，说明中间过程大概不轻松。",
      "这种预告最考验后续，发不出来比不发更伤信任。",
    ],
    // 内容创作 / newsletter / 自媒体
    content: [
      "选题决定打开率，质量决定留存，这两件事经常被混着谈。",
      "订阅从 0 到 3000，中间那段没人看的日子最难熬。",
      "内容做到最后拼的是持续输出，不是某篇爆款。",
      "稳定更新本身就筛掉了一大半人。",
    ],
  };

  /* 判断帖子属于哪一类（关键词打分，取最高分）。
   * 这一步很关键：不同场景用不同整句，评论才不会牛头不对马嘴。
   * 2026-11-18 调优：加「先排除」，避免招人帖被判成独立开发帖。 */
  function classifyPost(text) {
    const t = String(text || "");
    const hit = (ws) => ws.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    const score = {
      hiring:    hit(["招人", "招聘", "面试", "候选人", "员工", "团队", "管理", "CFO", "技术可以教"]),
      vent:      hit(["亏", "回撤", "跌", "吐回去", "难受", "崩", "麻了", "白干", "套牢", "浮盈", "赚的钱", "输光"]),
      teaser:    hit(["不再是秘密", "今晚", "揭晓", "公布", "即将", "期待", "准备好"]),
      content:   hit(["newsletter", "订阅", "选题", "内容", "写作", "更新", "读者"]),
      risky:     hit(["定制", "私下", "擦边", "灰产", "暴利", "恐怖", "有色", "成人", "真人", "擦边球"]),
      milestone: hit(["第一个", "终于", "付费用户", "营收", "突破", "里程碑"]),
      build:     hit(["独立开发", "创业", "闷头", "推广", "分发", "做一个", "做出来", "上架", "需求", "MVP"]),
      opinion:   hit(["趋势", "时代", "未来", "行业", "意味着", "本质", "我认为", "并没有", "AI"]),
    };
    if (score.hiring >= 1) return "hiring";     // 招人类优先，误判最扎眼
    if (score.vent >= 2) return "vent";         // 亏损类次优先，最需要共情
    if (score.teaser >= 2) return "teaser";     // 预告类单独处理，不硬猜内容
    if (score.content >= 2) return "content";   // 内容创作类
    if (score.risky >= 2) return "risky";       // 争议/擦边类，只谈风险不谈道德

    let best = "general", bestV = 1;            // 至少 2 分才算命中
    for (const [k, v] of Object.entries(score)) if (v > bestV) { bestV = v; best = k; }
    return best;
  }

  // 运行时使用的池子（可被面板覆盖）
  let MINE_SYSTEM = DEFAULT_MINE_PROMPT;
  let CUSTOM_TEMPLATES = null;    // 面板自定义的模板（扁平池）

  const DEFAULT_MINE_TEMPLATES = Object.values(MINE_TEMPLATES_BY_SCENE).flat();

  /* 观点检测：一条合格的评论，除了「引用帖子」之外，必须还有**观点**——
   * 判断、因果、条件、取舍，至少占一样。
   * 反例：「刷到一位兄弟我收藏了」—— 只有情绪，没有任何判断，等于废话。
   * 反例：「这点我认同」—— 只有态度。
   * 正例：「我认同，难的是后面执行」—— 态度 + 具体判断。
   */
  const OPINION_MARKERS = [
    // 因果/条件/转折
    "但", "不过", "然而", "其实", "关键", "取决", "前提", "如果", "除非",
    "因为", "所以", "反而", "才", "除非",
    // 判断词
    "难的是", "最难", "容易", "风险", "代价", "成本", "收益", "复利", "最难熬",
    "未必", "不一定", "短期", "长期", "可持续", "可持续性", "分水岭",
    "不同意", "保留", "理想化", "复杂", "相反", "认同", "同意", "部分同意",
    "落地", "执行", "坚持", "投入", "资源", "节奏", "方向", "位置",
    "省", "负担", "坑", "机会", "值得", "更关心", "逃避", "稀缺",
    // 期待/评价/信任类（预告帖、内容创作帖常用）
    "期待", "希望", "考验", "信任", "吊胃口", "铺垫", "不轻松",
    "决定", "留存", "打开率", "持续", "稳定", "拼", "筛掉", "熬",
    "有价值", "密度", "结论", "前提", "变数", "忽略", "放大", "影响",
  ];

  function hasOpinion(text) {
    const t = String(text || "");
    return OPINION_MARKERS.some((m) => t.includes(m));
  }

  /* 复述/角色错位检测（用户踩过的真实坑：作者说「我把它上架了」，评论也回「我把它上架了」）。
   * 分两层，因为单纯字面匹配挡不住**改写式复述**：
   *   ① 字面：评论含原帖 8 字以上连续片段 → 复述
   *   ② 语义：评论以「我」+ 动词开头，且该动词/动作在原帖里是**作者**做的
   *      （原帖出现「我…上架」「把它上架」这类第一人称陈述）→ 把作者经历据为己有
   */
  function echoesAuthor(comment, post) {
    const c0 = String(comment || "");
    const c = c0.replace(/\s/g, "");
    const src = String((post && (post.ctxReply || post.text)) || "").replace(/\s/g, "");
    if (!c || !src) return false;

    /* ① 字面复述：**只在评论把这段话说成自己的时候才算**。
     * 引用原帖事实（「订阅从 0 到 3000」）是正常评论手法，不该拦。
     * 判据：评论文本里，该片段前面紧跟「我/我也/我刚/我已经」这类第一人称主语 →
     *       是把作者的经历据为己有 → 复述。
     */
    if (src.length >= 8) {
      const WIN = 8;
      for (let i = 0; i + WIN <= src.length; i++) {
        const seg = src.slice(i, i + WIN);
        const idx = c.indexOf(seg);
        if (idx < 0) continue;
        const before = c.slice(Math.max(0, idx - 8), idx);
        // 前面是第一人称 → 据为己有
        if (/(^|[，。！？、；])我(也|就|已经|刚|刚刚|之前|直接|终于|当时|后来|现在)?$/.test(before)) return true;
        // 或者整句几乎就是原帖（相似度极高）→ 复述
        if (sim(c, src) >= 0.8) return true;
        // 否则只是引用事实，放行
      }
    }

    // ② 语义：原帖里「我/把它 + 动词」，评论里也用同样动词说「我…」
    //    抓原帖中的动作词（上架、发布、做了、写完、跑通…常见动作）
    const ACTIONS = ["上架", "发布", "上线", "开发", "做了", "做完", "写完", "跑通",
                     "搭建", "注册", "申请", "注册了", "辞职", "搬进", "预约", "赚到",
                     "学了", "开始做", "转型", "创业", "开了", "买了", "试了"];
    for (const act of ACTIONS) {
      if (!src.includes(act)) continue;                    // 原帖没提这个动作
      // 原帖里这个动作是不是「作者自己做的」：动作前面出现 我/它/把它/已经
      if (!new RegExp(`(我|把它|它|已经|刚|终于)[^。！？]{0,6}${act}`).test(src)) continue;
      // 评论里也以「我」为主语说了这个动作 → 角色错位
      if (new RegExp(`我[^。！？]{0,4}${act}`).test(c)) return true;
    }

    return false;
  }

  /* 面板改过的提示词/模板灌进来。空值 = 用默认。 */
  // 占位符替换（提示词里可用 {len} {lo} {hi} {tone} {post}）
  function fill(tpl, vars) {
    let out = String(tpl || "");
    for (const [k, v] of Object.entries(vars)) out = out.split("{" + k + "}").join(String(v));
    return out;
  }

  function applyCustom(beh) {
    MINE_SYSTEM = (beh && beh.comment_prompt) || DEFAULT_MINE_PROMPT;
    const raw = (beh && beh.comment_templates || "").trim();
    CUSTOM_TEMPLATES = raw
      ? raw.split(/\n+/).map((s) => s.trim()).filter(Boolean)
      : null;                      // 没自定义 → 用分场景内置池
  }

  /* 生成一条模板评论（第 3 版：按帖子场景挑整句）。
   * 返回 { text } 或 null。
   * 逻辑：
   *   ① 判断帖子场景（vent/build/opinion/milestone/hiring/general）
   *   ② 从该场景的整句里随机挑一条
   *   ③ 面板自定义过模板 → 优先用自定义池（用户自己写的，尊重他的配置）
   */
  function mineTemplate(post) {
    const src = String(post.ctxReply || post.text || "");
    const scene = classifyPost(src);
    const pool = (CUSTOM_TEMPLATES && CUSTOM_TEMPLATES.length)
      ? CUSTOM_TEMPLATES
      : (MINE_TEMPLATES_BY_SCENE[scene] || MINE_TEMPLATES_BY_SCENE.general);

    const pick = [];
    for (let i = 0; i < pool.length; i++) if (i !== lastMine) pick.push(pool[i]);
    const tpl = (pick.length ? pick : pool)[Math.floor(Math.random() * (pick.length || pool.length))];
    if (!tpl) return null;

    // 整句模板不含 {p} → 直接用（这是推荐形式）
    if (!tpl.includes("{p}")) {
      lastMine = pool.indexOf(tpl);
      return tpl;
    }
    // 含 {p} 的自定义模板 → 仍需短语，按剩余空间取完整片段
    const fixed = tpl.replace("{p}", "").length;
    const room = Math.max(4, 16 - fixed);
    const phrase = shortPhrase(src, room) || shortPhrase(src, 10);
    if (!phrase) return null;
    return tpl.replaceAll("{p}", phrase);
  }
  let lastMine = -1;

  // 占位符替换（提示词里可用 {len} {lo} {hi} {tone} {post}）
  function fill(tpl, vars) {
    let out = String(tpl || "");
    for (const [k, v] of Object.entries(vars)) out = out.split("{" + k + "}").join(String(v));
    return out;
  }

  /* ---------- 防重复评论（用户反复踩的坑）----------
   * 三层：
   *   1) 同一个帖子 ID 只评一次（content.js 的 replied 表，最硬）
   *   2) 同一个作者：最近给他评论过的句子不许再说（myReplies 传进来）
   *   3) 全局：和我最近发过的 N 条不相似（字符二元组相似度）
   * 这里实现 2、3 的判定。 */
  let HISTORY = [];          // 最近发过的评论（全局）

  function setHistory(arr) { HISTORY = (arr || []).slice(-100); }
  function pushHistory(t) { if (t) { HISTORY.push(t); HISTORY = HISTORY.slice(-100); } }

  // 字符二元组（bigram）相似度，对中文比编辑距离稳，短句也适用
  function bigrams(s) {
    const t = String(s || "").replace(/[\s，。！？、,.!?~—「」""'']/g, "");
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  }
  function sim(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const g of A) if (B.has(g)) hit++;
    return hit / Math.min(A.size, B.size);
  }

  const DUP_THRESHOLD = 0.6;   // 相似度超过这个就算重复

  function isDuplicate(text, post, beh) {
    const cand = [
      ...((post && post.myReplies) || []),   // 同作者的历史
      ...HISTORY,                            // 全局历史
    ];
    for (const old of cand) {
      if (!old || old === text) return true;
      if (sim(text, old) >= DUP_THRESHOLD) return true;
    }
    return false;
  }

  /* ---------- 生成入口 ---------- */

  async function generate(post, beh, llmCfg) {
    const body = (post.text || "").trim();
    if (!body) return { text: "", source: "none", error: "帖子没有正文，跳过" };

    applyCustom(beh);        // 面板改过的提示词/模板在这里生效
    if (SOP.isMineMode(beh)) return generateMine(post, body, beh, llmCfg);

    if (llmCfg && llmCfg.apiKey && llmCfg.baseUrl && llmCfg.model) {
      const scene = classifyScene(body, !!post.is_reply_to_me);
      const [sceneName, sceneHint] = SCENES[scene] || SCENES.knowledge;
      const system = SYSTEM_PROMPT
        .replace("{scene}", sceneName).replace("{scene_hint}", sceneHint)
        .replace("{tone}", TONE_HINT[beh.tone] || TONE_HINT.friendly)
        .replace("{style}", STYLE_HINT[beh.style] || STYLE_HINT.normal);
      let feedback = "";
      for (const attempt of [1, 2]) {
        const user = `【帖子作者】${post.author || ""}\n【帖子正文】\n${body.slice(0, 800)}\n\n` +
                     `【风格要求】像真人随手留一句，说具体的东西，不吹捧不空话${feedback}`;
        let raw = "";
        try {
          raw = await chrome.runtime.sendMessage({ t: "llm", system, user, cfg: llmCfg });
        } catch (e) {
          raw = "";
        }
        if (!raw || raw.__error) {
          feedback = `\n\n【模型调用失败】${(raw && raw.__error) || "无响应"}，改用模板`;
          break;
        }
        const text = clean(raw);
        const [ok, why] = SOP.validateComment(text, post);
        if (ok && valid(text, beh.style))
          return { text, source: "llm", model: llmCfg.model, attempts: attempt };
        if (attempt === 1)
          feedback = `\n\n【上一版被否原因】${why}\n请重写：必须直接引用或复述原帖里的一个具体词/细节，` +
                     `让别人看得出你只对这条帖子才能说这句话。`;
      }
      // LLM 两版不合格 → 试模板
      const tpl = template(post);
      const [okT, whyT] = SOP.validateComment(tpl, post);
      return { text: okT ? tpl : "", source: "template",
               error: okT ? "LLM 不合格，退回模板" : `模板也未过校验：${whyT}` };
    }

    const tpl = template(post);
    const [ok, why] = SOP.validateComment(tpl, post);
    return { text: ok ? tpl : "", source: "template",
             ...(ok ? { note: "未配置密钥，模板兜底" } : { error: `模板未通过 SOP 校验：${why}` }) };
  }

  /* 我的规则：短评生成。LLM 优先生成，失败/不合格退回短句模板。
   * 长度：目标 len（默认 13，随机 ±5 内浮动），硬上限 20 字。 */
  async function generateMine(post, body, beh, llmCfg) {
    const { lo, hi } = SOP.commentLength(beh);
    const len = lo + Math.floor(Math.random() * (hi - lo + 1));   // 每次随机一个目标长度
    const tryAccept = (raw) => {
      const t = clean(raw).replace(/[。！？!?]+$/, (m) => m);
      if (!t) return null;
      const [ok] = SOP.validateComment(t, post, beh);
      if (!ok) return null;
      // 【硬拦截】复述作者的话 = 身份错位
      if (echoesAuthor(t, post)) return null;
      // 【硬拦截】没有观点 = 废话（「刷到一位兄弟我收藏了」这类）
      if (!hasOpinion(t)) return null;
      return t;
    };

    if (llmCfg && llmCfg.apiKey && llmCfg.baseUrl && llmCfg.model) {
      const toneCn = { friendly: "随和", professional: "专业", humorous: "幽默",
                       curious: "好奇", supportive: "共情", sharp: "直接" }[beh?.tone] || "随和";
      const system = fill(MINE_SYSTEM, { len, lo, hi, tone: toneCn, post: body.slice(0, 800) });

      // 已有回复：既包括页面上别人写的，也包括我自己之前发过的（防重复的关键）
      const others = (post.replies || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 8);
      const mineBefore = (post.myReplies || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 5);

      const parts = [];
      parts.push(`帖子作者：@${post.handle || post.author || "unknown"}`);
      // 通知回复场景：给他回复我的那条帖子 → 必须结合「我的原帖 + 他说的话」
      if (post.ctxReply) {
        if (post.ctxMyPost) parts.push(`我的原帖（我先前说的，作为上下文）：\n${String(post.ctxMyPost).slice(0, 500)}`);
        parts.push(`作者对我的回复（我要评论的是他这句话）：\n${String(post.ctxReply).slice(0, 500)}`);
        parts.push(`请针对他这句话写 1 条回应：接住他说到的点，再表明我的态度或补充。注意主语是我，不是他。`);
      } else {
        parts.push(`作者发的帖子（我要评论的内容，不是我的话）：\n${body.slice(0, 800)}`);
        parts.push(`请针对作者这个帖子写 1 条评论。用你自己的视角说话；作者做了什么事、有什么观点，不要搬到你自己身上。`);
      }
      if (others.length) parts.push(`已有回复（供参考，不要重复别人说过的）：\n- ${others.join("\n- ")}`);
      if (mineBefore.length)
        parts.push(`我之前在这位作者下发过的评论（绝对不要再说一遍，换个角度）：\n- ${mineBefore.join("\n- ")}`);
      parts.push(`要求：大约 ${len} 个字（${lo}~${hi} 是理想区间，多几个字没关系，但句子必须完整），语气${toneCn}。`);

      let feedback = "";
      for (const attempt of [1, 2, 3]) {
        let raw = "";
        try {
          raw = await chrome.runtime.sendMessage({
            t: "llm", system, user: parts.join("\n\n") + feedback, cfg: llmCfg,
          });
        } catch (e) { raw = ""; }
        if (!raw || raw.__error) break;

        const cleaned = clean(raw).replace(/[。！？!?]+$/, (m) => m);
        if (cleaned) {
          // ① 先单独判复述——给出针对性的重写指令，比笼统说"不合格"有效得多
          if (echoesAuthor(cleaned, post)) {
            feedback = `\n\n【上一版的问题】你复述了作者说过的话（"${cleaned.slice(0, 30)}"）。` +
                       `记住：作者是你评论的对象，他做的事不是你的。请用你自己的视角重新写一句，` +
                       `不要再出现他原话里的表述。`;
            continue;
          }
          const t = tryAccept(cleaned);
          if (t) {
            if (isDuplicate(t, post, beh)) {
              feedback = `\n\n【这一版和我以前发过的太像了】请换一个完全不同的角度重写。`;
              continue;
            }
            return { text: t, source: "llm", model: llmCfg.model, len: t.length, target: len, attempts: attempt };
          }
        }
        feedback = `\n\n【上一版不合格】内容不符合要求（大约 ${len} 字，句子要完整通顺），请重写一句。`;
      }
      const t = tryTemplates(post, len, beh);
      return { text: t || "", source: "template", target: len,
               ...(t ? { note: "LLM 不合格，退回短句模板" } : { error: "模板都超出字数上限，去「评论规则」窗口改短一点" }) };
    }

    const t = tryTemplates(post, len, beh);
    return { text: t || "", source: "template", target: len,
             ...(t ? { note: "未配置密钥，短句模板兜底" } : { error: "模板都超出字数上限，去「评论规则」窗口改短一点" }) };
  }

  /* 模板兜底：按场景挑整句，过校验、过重复检测。
   * 整句模板不依赖短语，所以不会再出现「只有 9 美元 这说法有点理想化」这种错配。 */
  function tryTemplates(post, len, beh, tries = 12) {
    for (let i = 0; i < tries; i++) {
      const t = mineTemplate(post);
      if (!t) continue;
      const [ok] = SOP.validateComment(t, post, beh);
      if (!ok) continue;
      if (echoesAuthor(t, post)) continue;
      if (!hasOpinion(t)) continue;
      if (isDuplicate(t, post, beh)) continue;
      return t;
    }
    return "";
  }

  return { generate, classifyScene, classifyPost, generateMine, applyCustom, tryTemplates,
           isDuplicate, setHistory, pushHistory, sim, hasOpinion, echoesAuthor,
           DEFAULT_MINE_PROMPT, DEFAULT_MINE_TEMPLATES, MINE_TEMPLATES_BY_SCENE };
})();
