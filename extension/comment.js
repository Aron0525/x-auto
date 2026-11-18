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

    // ③ 都不合适 → 返回空。调用方会改用「不带短语的纯观点句」，
    //    宁可少一点针对性，也不发断句。
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

  /* 默认提示词（对齐用户给的 CommentPrompts.kt 思路，但字数按本插件规则压到 ≤20）。
   * 核心：每条评论必须做两件事 —— ① 对内容有具体回应，不能是放之四海皆准的空话；
   *       ② 表达自己的观点，不是把原文换个说法复述。
   * 占位符：{len} 目标字数、{lo}/{hi} 区间、{cap} 硬上限、{tone} 语气、{post} 原帖正文 */
  const DEFAULT_MINE_PROMPT = `你是一个评论回复助手，负责根据帖子的内容写出可以公开发表的评论。

每条评论必须做两件事：
第一，对帖子的具体内容有回应 —— 要指向帖子里真实提到的那个东西（说了什么、做了什么、遇到什么问题），
不是"很有道理""值得思考"这种放到任何帖子下面都成立的话。
第二，表达你自己的观点 —— 可以是认同并补充、也可以是保留意见，但不能只是把原文换个说法复述一遍。

要求：
- 语言跟随原文（原文中文就用中文）。
- 每条不超过 {cap} 个字，{len} 字左右最合适，口语一点，像真人随口接一句。
- 只输出这一句评论本身，不要引号、不要解释、不要分点。
- 不要客套话，不要堆表情，不要加话题标签（#），不要 @ 人，不要贴链接。
- 不要编造数据或亲历（别说"我测过""我朋友在做"这类没发生的事）。
- 不阴阳怪气、不骂人、不引战、不评价作者本人。

语气：{tone}`;

  // 短句模板默认池：{p} 放原帖里的一句**完整短语**（已保证能独立读通）。
  // 设计原则：模板固定字数尽量短，让 {p} 有空间；接读起来通顺，不像机器拼接。
  const DEFAULT_MINE_TEMPLATES = [
    "「{p}」，我也有同样感觉。",
    "「{p}」这点我认同。",
    "{p}，关键还是看执行。",
    "「{p}」确实，代价不小。",
    "{p}，我持保留态度。",
    "「{p}」说得挺实在。",
    "{p}，我更看重长期。",
    "「{p}」我收藏了。",
    "{p}，短期热闹长期未必。",
    "「{p}」这个判断有道理。",
    "{p}，不过落地最难。",
    "「{p}」值得试试。",
  ];

  // 运行时使用的池子（可被面板覆盖）
  let MINE_SYSTEM = DEFAULT_MINE_PROMPT;
  let MINE_TEMPLATES = DEFAULT_MINE_TEMPLATES.slice();

  /* 面板改过的提示词/模板灌进来。空值 = 用默认。 */
  // 占位符替换（提示词里可用 {len} {lo} {hi} {cap} {tone} {post}）
  function fill(tpl, vars) {
    let out = String(tpl || "");
    for (const [k, v] of Object.entries(vars)) out = out.split("{" + k + "}").join(String(v));
    return out;
  }

  function applyCustom(beh) {
    MINE_SYSTEM = (beh && beh.comment_prompt) || DEFAULT_MINE_PROMPT;
    const raw = (beh && beh.comment_templates || "").trim();
    MINE_TEMPLATES = raw
      ? raw.split(/\n+/).map((s) => s.trim()).filter(Boolean)
      : DEFAULT_MINE_TEMPLATES.slice();
  }

  let lastMine = -1;
  /* 生成一条模板评论。
   * 关键思路调整（修「半导体周期见」「我觉得这个工」这类断词）：
   *   先按可用空间挑短语很别扭 —— 模板固定字数一多，短语就被挤成半截词。
   *   改成：短语按「有意义的长度」取（4~10 字，取完整词块），
   *         再挑一条「短语 + 模板固定字数 ≤ 上限」的模板来装它。 */
  function mineTemplate(post, len) {
    const { cap } = SOP.commentLength({ comment_target_len: len });
    const order = MINE_TEMPLATES.map((_, i) => i).sort(() => Math.random() - 0.5);

    // 短语目标：整句落 ~len，所以短语大致取 len - 模板固定字数，但不低于 4、不高于 10
    const tryOne = (tplIdx, phraseLen) => {
      const tpl = MINE_TEMPLATES[tplIdx];
      const phrase = shortPhrase(post.text || "", phraseLen);
      if (!phrase) return null;
      const text = tpl.replaceAll("{p}", phrase);
      if (text.length > cap) return null;
      return text;
    };

    for (const i of order) {
      const tpl = MINE_TEMPLATES[i];
      const fixed = tpl.replace("{p}", "").length;
      // 先试「刚好凑到目标字数」的短语长度，再放宽到装得下的最大长度
      const ideal = Math.max(4, Math.min(10, len - fixed));
      const roomy = Math.max(4, Math.min(12, cap - fixed - 1));
      for (const pl of [ideal, roomy, Math.max(4, ideal - 2)]) {
        const t = tryOne(i, pl);
        if (t) { lastMine = i; return t; }
      }
    }
    return null;
  }

  // 短语取不到时用的纯观点短句（不依赖原帖，但至少是通顺的一句话）
  const NO_PHRASE_TEMPLATES = [
    "这条我持保留，得看后续。",
    "方向没错，落地最难。",
    "有同感，短期热闹长期未必。",
    "挺真实的，代价也不小。",
    "我更看长期，不急着下结论。",
    "这判断我认同，但风险也要说。",
  ];

  // 占位符替换（提示词里可用 {len} {lo} {hi} {cap} {tone} {post}）
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
    const { lo, hi, cap } = SOP.commentLength(beh);
    const len = lo + Math.floor(Math.random() * (hi - lo + 1));   // 每次随机一个目标长度
    const tryAccept = (raw) => {
      const t = clean(raw).replace(/[。！？!?]+$/, (m) => m);
      if (!t) return null;
      const [ok] = SOP.validateComment(t, post, beh);
      return ok ? t : null;
    };

    if (llmCfg && llmCfg.apiKey && llmCfg.baseUrl && llmCfg.model) {
      const toneCn = { friendly: "随和", professional: "专业", humorous: "幽默",
                       curious: "好奇", supportive: "共情", sharp: "直接" }[beh?.tone] || "随和";
      const system = fill(MINE_SYSTEM, { len, lo, hi, cap, tone: toneCn, post: body.slice(0, 800) });

      // 已有回复：既包括页面上别人写的，也包括我自己之前发过的（防重复的关键）
      const others = (post.replies || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 8);
      const mineBefore = (post.myReplies || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 5);

      const parts = [];
      parts.push(`作者：@${post.handle || post.author || "unknown"}`);
      parts.push(`主内容：\n${body.slice(0, 800)}`);
      if (others.length) parts.push(`已有回复（供参考，不要重复别人说过的）：\n- ${others.join("\n- ")}`);
      if (mineBefore.length)
        parts.push(`我之前在这位作者下发过的评论（绝对不要再说一遍，换个角度）：\n- ${mineBefore.join("\n- ")}`);
      parts.push(`请给出 1 条评论，${lo}~${hi} 个字（不超过 ${cap} 字），语气${toneCn}。`);

      let feedback = "";
      for (const attempt of [1, 2, 3]) {
        let raw = "";
        try {
          raw = await chrome.runtime.sendMessage({
            t: "llm", system, user: parts.join("\n\n") + feedback, cfg: llmCfg,
          });
        } catch (e) { raw = ""; }
        if (!raw || raw.__error) break;
        const t = tryAccept(raw);
        if (t) {
          // 与我历史发过的评论重复 → 换角度重写
          if (isDuplicate(t, post, beh)) {
            feedback = `\n\n【这一版和我以前发过的太像了】请换一个完全不同的角度重写。`;
            continue;
          }
          return { text: t, source: "llm", model: llmCfg.model, len: t.length, target: len, attempts: attempt };
        }
        feedback = `\n\n【上一版不合格】字数或内容不符合要求（要求 ${lo}~${hi} 字，不超过 ${cap} 字），请重写一句。`;
      }
      const t = tryTemplates(post, len, beh);
      return { text: t || "", source: "template", target: len,
               ...(t ? { note: "LLM 不合格，退回短句模板" } : { error: "模板都超出字数上限，去「评论规则」窗口改短一点" }) };
    }

    const t = tryTemplates(post, len, beh);
    return { text: t || "", source: "template", target: len,
             ...(t ? { note: "未配置密钥，短句模板兜底" } : { error: "模板都超出字数上限，去「评论规则」窗口改短一点" }) };
  }

  /* 模板兜底：试多条模板，`{p}` 按每条模板的剩余空间截断，
   * 某条放不下（模板本身太长）或与历史重复就换下一条。
   * 全部都取不到短语时，退回「不带短语的纯观点短句」——宁可少一点针对性，
   * 也不要发出一句机器拼出来的怪话。 */
  function tryTemplates(post, len, beh, tries = 12) {
    const n = Math.max(1, MINE_TEMPLATES.length);
    for (let i = 0; i < Math.min(tries, n); i++) {
      const t = mineTemplate(post, len);
      if (!t) continue;
      const [ok] = SOP.validateComment(t, post, beh);
      if (!ok) continue;
      if (isDuplicate(t, post, beh)) continue;   // 和发过的太像 → 换一条
      return t;
    }
    // 没有可用短语 → 纯观点兜底
    const pool = NO_PHRASE_TEMPLATES.filter((t) => {
      const [ok] = SOP.validateComment(t, post, beh);
      return ok && !isDuplicate(t, post, beh);
    });
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    return "";
  }

  return { generate, classifyScene, generateMine, applyCustom, tryTemplates,
           isDuplicate, setHistory, pushHistory, sim,
           DEFAULT_MINE_PROMPT, DEFAULT_MINE_TEMPLATES };
})();
