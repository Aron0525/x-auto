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

  function shortPhrase(text, limit = 16) {
    const clauses = (text || "").split(CLAUSE_SPLIT).map((c) => c.trim(" ，,、：:")).filter((c) => c);
    const pool = clauses.filter((c) => c.length >= 6 && c.length <= 40);
    if (!pool.length) return "";
    const w = (c) => {
      let s = 0;
      for (const kw of SOP.INTEREST_KEYWORDS) if (c.toLowerCase().includes(kw.toLowerCase())) s += 1.0;
      return s - Math.abs(c.length - 16) / 20.0;
    };
    return cut(pool.reduce((a, b) => (w(b) > w(a) ? b : a)), limit);
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

  const MINE_SYSTEM = `你在 X（推特）上刷到一条帖子，随手回一句短评（中文）。
1. 先用半句回应原帖的具体内容，再表达你的观点或态度。
2. 总长度不超过 20 个字，{len} 字左右最合适。只输出这一句话，不要引号、不要解释。
3. 像真人随口接话，可以有态度，但不阴阳怪气、不骂人、不引战。
4. 不要话题标签（#），不要 @ 人，不要贴链接，不要推销自己。
5. 不要用「说得很好」「学习了」「干货」「感谢分享」这类空话。`;

  // 短句模板：{p} 放原帖抓出来的具体短语，保证「回应帖子」
  const MINE_TEMPLATES = [
    "「{p}」这点确实，我也这么看。",
    "「{p}」有同感，不止一次了。",
    "{p}，我觉得关键还是看执行。",
    "「{p}」挺真实，代价也不小。",
    "{p}，这个判断我认同。",
    "「{p}」我持保留，但方向没错。",
    "{p}说得在理，落地最难。",
    "「{p}」——确实，越往后越明显。",
    "{p}，我更看重它后面的影响。",
    "「{p}」这条我收藏了，有用。",
    "{p}，短期热闹，长期未必。",
    "「{p}」说得挺实在，值得一试。",
  ];

  let lastMine = -1;
  function mineTemplate(post, len) {
    const phrase = shortPhrase(post.text || "", Math.max(6, len - 6)) || "这个观点";
    let idx = 0;
    if (MINE_TEMPLATES.length > 1) {
      const choices = MINE_TEMPLATES.map((_, i) => i).filter((i) => i !== lastMine);
      idx = choices[Math.floor(Math.random() * choices.length)];
    }
    lastMine = idx;
    return MINE_TEMPLATES[idx].replaceAll("{p}", phrase);
  }

  /* ---------- 生成入口 ---------- */

  async function generate(post, beh, llmCfg) {
    const body = (post.text || "").trim();
    if (!body) return { text: "", source: "none", error: "帖子没有正文，跳过" };

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
      const system = MINE_SYSTEM.replace("{len}", String(len));
      let feedback = "";
      for (const attempt of [1, 2]) {
        let raw = "";
        try {
          raw = await chrome.runtime.sendMessage({
            t: "llm", system,
            user: `【帖子作者】${post.author || ""}\n【帖子正文】\n${body.slice(0, 800)}\n\n` +
                  `【要求】${lo}~${hi} 个字（不超过 ${cap} 字），先回应帖子内容再表达观点。${feedback}`,
            cfg: llmCfg,
          });
        } catch (e) { raw = ""; }
        if (!raw || raw.__error) break;
        const t = tryAccept(raw);
        if (t) return { text: t, source: "llm", model: llmCfg.model, len: t.length, target: len, attempts: attempt };
        feedback = `\n\n【上一版不合格】字数或内容不符合要求（要求 ${lo}~${hi} 字，不超过 ${cap} 字），请重写一句。`;
      }
      const tpl = mineTemplate(post, len);
      const t = tryAccept(tpl);
      return { text: t || "", source: "template", target: len,
               ...(t ? { note: "LLM 不合格，退回短句模板" } : { error: "模板也超出字数上限" }) };
    }

    const tpl = mineTemplate(post, len);
    const t = tryAccept(tpl);
    return { text: t || "", source: "template", target: len,
             ...(t ? { note: "未配置密钥，短句模板兜底" } : { error: "模板超出字数上限" }) };
  }

  return { generate, classifyScene, generateMine };
})();
