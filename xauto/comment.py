"""评论生成：看帖写一句「人话」。

两层：
  1. 有 LLM 配置 → 让模型读完帖子写一句（复用项目已有的 message.llm 客户端，
     密钥只从环境变量读，不落盘）
  2. 没有密钥 / 调用失败 → 退回模板句（明确标记 source="template"），保证功能可跑通

评论的硬规则（防止 AI 味和风险）：
  · 一句话，20~60 字，不换行、不分点、不加话题标签、不 @ 人
  · 必须抓住帖子里的一个具体点，不许「说得很好」「受益匪浅」这种空话
  · 不吹捧作者、不故作高深、不用「非常」「深刻」「值得深思」
  · 不引战、不评价人的能力、不涉及政治/地域/性别等敏感面
"""

from __future__ import annotations

import os
import random
import re

from xauto import behavior, config

# 语气与档次的说明由 behavior.py 提供，这里只把它们拼成 prompt
_TONE_HINT = {
    "friendly": "语气随和，像朋友随口接一句，可以带一点口语。",
    "professional": "语气专业克制：讲事实、给判断或补充信息，不寒暄、不调侃。",
    "humorous": "语气轻松幽默：可以自嘲或小小调侃，但不刻薄、不嘲讽作者。",
    "curious": "语气好奇：以提问或请教为主，表示想了解更多细节。",
    "supportive": "语气共情：先认同对方的感受或处境，再补一句自己的看法。",
    "sharp": "语气直接：可以提出不同意见，但只针对观点，不针对人。",
}

_STYLE_HINT = {
    "short": "长度 10~25 字，一句话说完。",
    "normal": "长度 20~60 字，一到两句话。",
    "detailed": "长度 60~120 字，给出具体理由或补充一个细节。",
}

# SOP 4.6 的八类场景：不同场景该补给什么，不该做什么
_SCENES = {
    "tool": ("AI 工具/产品分享",
             "指出它的一个具体用途或限制（可回溯、可核对的那类问题），不要只说「太强了/求教程」。"),
    "knowledge": ("知识分享",
                  "补一个原帖没展开、但和主题直接相关的机制或反例；不必硬写成问句。"),
    "social": ("社会现象",
               "可以提出一种解释并留下边界（不同处境的人感受不同）；不要给一群人贴标签。"),
    "help": ("技术或使用求助",
             "信息不足时只问一个能缩小范围的问题；有办法时给可执行的下一步，不要空安慰。"),
    "work": ("作品或成果展示",
             "先指出一个看得见的设计，再问一个作者容易回答的小问题；不要空泛求教程。"),
    "newbie": ("新人帖/出摊帖",
               "接住对方已经提到的内容（例如他说的方向）；可以很短，但不要用同一句招呼轮换。"),
    "chat": ("日常闲聊",
             "先接对方的具体情境，不要强行转到自己的领域，也不要虚构共同经历。"),
    "reply_to_me": ("回复我的评论",
                    "把问题收束到对方能接着回答的选择；若是纠正事实错误，核对后致谢或更正。"),
}

SCENE_HINTS = _SCENES


def classify_scene(text: str, is_reply_to_me: bool = False) -> str:
    """按 SOP 4.6 把帖子归到八类场景之一（决定提示词里的「该补什么」）。"""
    t = text or ""
    if is_reply_to_me:
        return "reply_to_me"
    # 「讲道理」的句子即便提到工具也算知识分享（SOP 4.6 第 2 类）
    if any(k in t for k in ("不等于", "本质", "关键在于", "归根到底", "道理", "原理", "往往比")):
        return "knowledge"
    if any(k in t for k in ("求助", "报错", "怎么解决", "跑不通", "装不上", "求大佬", "卡住")):
        return "help"
    if any(k in t for k in ("新来的", "新人", "出摊", "交个朋友", "串门", "认识一下")):
        return "newbie"
    if any(k in t for k in ("新工具", "插件", "软件", "产品", "上线了", "内测",
                            "价格", "免费", "付费", "app", "App", "小程序")):
        return "tool"
    if any(k in t for k in ("做了个", "我的作品", "开源", "仓库", "demo", "Demo", "截图")):
        return "work"
    if any(k in t for k in ("数据", "统计", "研究", "报道", "社会", "现象", "趋势", "年轻人")):
        return "social"
    if any(k in t for k in ("今天", "桌面", "晚饭", "天气", "熬夜", "通勤")):
        return "chat"
    return "knowledge"

SYSTEM_PROMPT = """你在 X 上刷时间线，看完一条帖子，想留一条评论。

一条值得发的评论通常有三部分（不必写成填空，但三样都要在）：
1. 锚定：明确你在回原帖里的**哪一个具体点**（某个说法、数字、做法、限制）
2. 贡献：补一个信息、一个限制、一个解释、一个不同判断，或提一个对方能回答的具体问题
3. 边界：不编造「我刚测过」，不承诺回关/互赞，不把猜测写成结论，不评价人

硬性规则（违反任何一条都算失败）：
1. 只输出评论正文：不要换行、不要分点、不要引号、不要解释。
2. 必须出现原帖里的具体词或细节 —— 判断标准是：**这句话只有看过这条原帖才写得出来**。
   放到任何帖子下面都成立的句子（「说得好」「学到了」「太强了」）一律不合格。
3. 不要话题标签（#），不要 @ 人，不要贴链接，不要推销自己的账号或工具。
4. 不要空话套话，不要为了凑字数或凑问句（SOP 没有「必须超过多少字」的规定，短也可以）。
5. 不引战、不评价作者能力或身份、不涉及政治/地域/性别等敏感面。
6. 原帖已经写明的细节不要再假装追问；也不要把简单意思为了凑字数拉长。
【本次场景】{scene}：{scene_hint}
【本次语气】{tone}
【本次长度】{style}"""

_AVOID = ("说得很好", "受益匪浅", "值得深思", "非常深刻", "感谢分享", "学习了",
          "很有启发", "深刻", "干货", "点赞")

# 用户自带的「评论规则」文件（后面会有一套规则要参照，放这里即可生效）
# 注意：用 PKG_DIR 而不是 DATA_DIR.parent——数据目录按档位分家后，规则文件仍共用一份。
RULES_FILE = config.PKG_DIR / "comment_rules.md"


def _rules() -> str:
    """读取可选的评论规则文件，拼到 system prompt 后面。不存在就返回空。"""
    try:
        if RULES_FILE.exists():
            txt = RULES_FILE.read_text(encoding="utf-8").strip()
            if txt:
                return "\n\n【补充规则（来自 comment_rules.md，优先级高于上面的通用规则）】\n" + txt
    except Exception:
        pass
    return ""


def _clean(text: str) -> str:
    t = (text or "").strip()
    for pref in ("评论：", "评论:", "回复：", "回复:"):
        if t.startswith(pref):
            t = t[len(pref):].strip()
    if len(t) >= 2 and t[0] in "“\"'「" and t[-1] in "”\"'」":
        t = t[1:-1].strip()
    t = re.sub(r"\s+", " ", t)          # 压成一行
    t = t.replace("#", "")
    return t.strip()


def _max_chars() -> int:
    """按当前「风格档次」决定长度上限。"""
    return {"short": 30, "normal": 70, "detailed": 140}.get(
        behavior.get("style"), config.COMMENT_MAX_CHARS)


def _valid(text: str) -> bool:
    if not text or len(text) > _max_chars():
        return False
    if any(w in text for w in _AVOID):
        return False
    return True


# ---------------- 模板兜底（没有模型时用）----------------
#
# 关键不是「随便说一句」，而是抓准帖子里的**信息量最大的那一句**。
# 早期版本直接截前 14 个字，结果抓到了「我突然发现一个暴富的好机会」这种钩子句，
# 拼出来的评论读着像复读机。所以这里做子句切分 + 打分挑选。

_CLAUSE_SPLIT = re.compile(r"[。！？；;!?\n]+")
_HEAD_NOISE = ("我突然发现", "兄弟们", "家人们", "姐妹们", "说真的", "讲真",
               "绝了", "震惊", "谁懂", "亲测")


def _key_phrase(text: str, limit: int = 22) -> str:
    """从帖子里挑一句最有信息量的话（含兴趣词优先，去掉开头钩子）。"""
    clauses = [c.strip(" ，,、") for c in _CLAUSE_SPLIT.split(text or "") if c.strip()]
    if not clauses:
        return (text or "").strip()[:limit]

    def weight(c: str) -> float:
        w = 0.0
        w += min(len(c), 60) / 30.0                      # 太短的不算「内容」
        for kw in config.INTEREST_KEYWORDS:
            if kw.lower() in c.lower():
                w += 1.2
        if any(c.startswith(n) for n in _HEAD_NOISE):
            w -= 1.5                                     # 开头钩子句降权
        if re.search(r"\d", c):
            w += 0.3                                     # 带数字的通常更具体
        return w

    best = max(clauses, key=weight).strip()
    for n in _HEAD_NOISE:
        if best.startswith(n):
            best = best[len(n):].lstrip("，,：: ")
    return _cut(best, limit)


def _cut(s: str, limit: int) -> str:
    """截断到 limit 字以内，尽量在标点处断开，别把词切一半。

    空格断点单独设更高的门槛：中英混排时空格很靠前（例如「最近 DeepSeek …」），
    在空格断开会得到过短的残片，读起来比硬截更难懂。
    """
    s = s.strip()
    if len(s) <= limit:
        return s.rstrip("，。,.!?！？ ")
    window = s[:limit]
    for sep, thresh in (("，", 0.5), ("、", 0.5), ("；", 0.5), (",", 0.5), (" ", 0.75)):
        idx = window.rfind(sep)
        if idx >= limit * thresh:
            return window[:idx].rstrip("，,、") + "…"
    return window[:limit - 1] + "…"


_TEMPLATES = (
    "「{p}」这点有共鸣，我做的时候也卡在这个环节。",
    "「{p}」这个我信，只是真落地还得看具体场景。",
    "顺着「{p}」这个思路想，最麻烦的其实是后面怎么持续。",
    "好奇「{p}」这一步你们是怎么处理的？我这边一直没理顺。",
    "「{p}」——关键可能不在方法，而在能不能一直做下去。",
    "最近也在看「{p}」这块，比想象中难绕开。",
)

_last_template = -1

# ---------------- 帖子类型 → 话术（没有模型时的主要质量来源）----------------
# 思路：先判断这条帖子属于哪类（吐槽 / 提问 / 教程 / 观点），
# 再用对应的话术回应。对吐槽帖去讲「落地场景」是最出戏的，所以要分类。

_TYPE_HINTS = {
    # 顺序即优先级：先看是不是在问，再看是不是教程，最后才轮到吐槽/观点。
    # 「坑」这类词两边都会出现，所以不能只靠单个词判类型。
    "ask": ("？", "?", "怎么", "为什么", "有没有", "求问", "谁知道", "请教", "求助",
            "要不要", "值得吗"),
    "howto": ("步骤", "方法", "教程", "实操", "清单", "流程", "搭建", "配置",
              "复盘", "模板", "工具链", "踩坑", "源码"),
    "vent": ("资本家", "精神内耗", "离谱", "无语", "破防", "服了", "笑死", "劝退",
             "太难", "跪", "窒息", "白嫖", "压榨"),
}

_TEMPLATES_BY_TYPE = {
    "vent": (
        "代入了一下血压就上来了，这种事真不少见。",
        "看笑了，只能说这行情谁都在硬撑。",
        "这段我看完先沉默了半分钟，太真实了。",
    ),
    "ask": (
        "同问，这块我也一直没搞明白，蹲个答案。",
        "我也想知道，之前试过两次都没跑通。",
        "这个问题我遇到过，等懂的人说说。",
    ),
    "howto": (
        "「{p}」这步我照着试了下，确实比之前省事。",
        "记下来了，我一直是硬怼过去的，没这么系统。",
        "流程拆得挺清楚，回头照着跑一遍。",
    ),
    "view": (
        "「{p}」这点我认，真做起来才知道难在哪。",
        "同意「{p}」，剩下的就是能不能一直做下去。",
        "「{p}」——比听起来难，但方向是对的。",
        "这思路我记下了，回头自己试一遍。",
    ),
}


def _classify(text: str) -> str:
    t = text or ""
    if "？" in t or "?" in t:
        return "ask"                          # 带问号的最强信号
    for kind in ("ask", "howto", "vent"):
        if any(h in t for h in _TYPE_HINTS[kind]):
            return kind
    return "view"


def _short_phrase(text: str, limit: int = 16) -> str:
    """取一句短的核心话（引用用），优先带兴趣词的子句。"""
    clauses = [c.strip(" ，,、：:") for c in _CLAUSE_SPLIT.split(text or "") if c.strip()]
    clauses = [c for c in clauses if 6 <= len(c) <= 40]
    if not clauses:
        return ""
    def w(c: str) -> float:
        s = 0.0
        for kw in config.INTEREST_KEYWORDS:
            if kw.lower() in c.lower():
                s += 1.0
        s -= abs(len(c) - 16) / 20.0        # 越接近 16 字越好用
        return s
    return _cut(max(clauses, key=w), limit)


def _template(post: dict) -> str:
    """没有模型时的兜底：按帖子类型选话术，引用只取短句。

    模板轮换而不是纯随机：连续两条用同一个句式最像机器人。
    """
    global _last_template
    text = post.get("text") or ""
    kind = _classify(text)
    pool = _TEMPLATES_BY_TYPE.get(kind) or _TEMPLATES_BY_TYPE["view"]
    phrase = _short_phrase(text) or "这个方向"
    idx = 0
    if len(pool) > 1:
        choices = [i for i in range(len(pool)) if i != _last_template]
        idx = random.choice(choices)
    _last_template = idx
    msg = pool[idx].format(p=phrase)
    if "{p}" not in pool[idx]:              # 有的句式不需要引用
        msg = msg
    return msg


def _key_file():
    """密钥兜底文件：xauto/.llm_key（已加进 .gitignore，不要提交）。"""
    return config.PKG_DIR / ".llm_key"


def ensure_key() -> bool:
    """保证 api_key_env 指向的环境变量有值。

    为什么要文件兜底：Windows 上 `SetEnvironmentVariable(..., 'User')` 只对
    之后新登录的进程生效，已经跑着的终端/IDE 拿不到 —— 表现为「明明设了却报没密钥」。
    文件兜底最省事，而且不落进 git。
    """
    name = config.LLM.get("api_key_env") or "LLM_API_KEY"
    if os.environ.get(name):
        return True
    p = _key_file()
    try:
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    os.environ[name] = line
                    return True
    except Exception:
        pass
    return False


def generate(post: dict, cfg_llm: dict | None = None) -> dict:
    """给一条帖子生成评论。返回 {text, source, model, error?}。

    SOP 第 4 节要求「先接住一个具体点」+「只有看过原帖才写得出来」，
    所以这里加了硬校验（xauto/sop.validate_comment）：不合格就带着反馈重写一次，
    仍不合格就返回空 —— 宁可不评论，也不发一句放哪都成立的废话。
    """
    from xauto import sop

    body = (post.get("text") or "").strip()
    if not body:
        return {"text": "", "source": "none", "error": "帖子没有正文，跳过"}

    cfg = (cfg_llm or {}).copy()
    if not cfg:
        cfg = dict(config.LLM)                       # xauto 自己的 LLM 设置
    ensure_key()

    if cfg.get("base_url") and cfg.get("model"):
        try:
            from message import llm as llm_mod
            tone = behavior.get("tone")
            style = behavior.get("style")
            scene = classify_scene(body, bool(post.get("is_reply_to_me")))
            scene_name, scene_hint = _SCENES.get(scene, _SCENES["knowledge"])
            system = SYSTEM_PROMPT.format(
                tone=_TONE_HINT.get(tone, _TONE_HINT["friendly"]),
                style=_STYLE_HINT.get(style, _STYLE_HINT["normal"]),
                scene=scene_name,
                scene_hint=scene_hint,
            ) + _rules()
            base_prompt = (
                f"【帖子作者】{post.get('author', '')}\n"
                f"【帖子正文】\n{body[:800]}\n\n"
                f"【风格要求】{config.COMMENT_STYLE}"
            )
            feedback = ""
            for attempt in (1, 2):
                raw = llm_mod.chat(system, base_prompt + feedback, cfg)
                text = _clean(raw)
                ok, why = sop.validate_comment(text, post)
                if ok:
                    return {"text": text, "source": "llm",
                            "model": cfg.get("model", ""), "attempts": attempt}
                if attempt == 1:
                    feedback = (f"\n\n【上一版被否原因】{why}\n"
                                f"请重写：必须直接引用或复述原帖里的一个具体词/细节，"
                                f"让别人看得出你只对这条帖子才能说这句话。")
            return {"text": "", "source": "llm-rejected",
                    "error": f"两版都没通过 SOP 校验：{why}"}
        except Exception as e:
            tpl = _template(post)
            ok, why = sop.validate_comment(tpl, post)
            return {"text": tpl if ok else "", "source": "template",
                    "error": f"LLM 不可用，退回模板：{e}",
                    **({"note": f"模板也未过校验：{why}"} if not ok else {})}

    tpl = _template(post)
    ok, why = sop.validate_comment(tpl, post)
    return {"text": tpl if ok else "", "source": "template", "model": "",
            **({"error": f"模板未通过 SOP 校验：{why}"} if not ok else
               {"note": "未配置 LLM 密钥，使用模板兜底"})}
