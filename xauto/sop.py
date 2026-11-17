"""SOP 判定层：把《X 新人浏览互动 SOP》变成可执行的判断。

设计原则（直接对应 SOP 第 0 节）：
  · 先理解再动作：没读懂就不赞不评
  · 阅读/点赞/评论/收藏/关注/转帖 **各自独立判断**，不搞「先赞再评再关」的链条
  · 没有可做的动作就跳过 —— 因此所有动作函数都返回 bool，允许「什么都不做」
  · 不追求数量、点赞评论比、固定间隔
  · 禁止：批量同义短评、承诺互关互赞、编造亲历、扩散未核实内容

这里只放「判断」，不碰浏览器。
"""

from __future__ import annotations

import random
import re

from xauto import behavior, config

# ---------------- 第 2.2 节：扫读就要跳过的 ---------------- #

SKIP_PATTERNS = (
    # 互关诱饵 / 关注抽奖 / 套模板引流
    "互关", "互粉", "回关", "求关注", "关注我", "点个赞", "点赞回",
    "抽奖", "关注抽", "转发抽", "评论区留言", "评论区扣", "扣1", "滴滴我",
    "想要的扣", "留言发你", "私信我", "加群", "进群", "扫码", "看主页",
    # 来源不清 / 催人授权
    "立刻验证", "连接钱包", "授权钱包", "空投领取", "助记词", "私钥",
    # 明显无关的站队骂战、纯热梗
    "骂战", "撕起来", "战队",
)

# 值得停留的信号（2.4 节）：把问题讲清楚、给了限制条件、区分事实与判断
QUALITY_SIGNALS = (
    "因为", "但是", "不过", "限制", "前提", "适用", "不适合", "适合谁",
    "我的做法", "实测", "踩过", "遇到过", "具体来说", "举个例子", "例如",
    "数据", "来源", "文档", "版本", "成本", "坑",
)

# 空话与禁用表达（4.7 / 第 12 节）
BANNED_COMMENT_PATTERNS = (
    "说得很好", "受益匪浅", "值得深思", "非常深刻", "感谢分享", "学习了",
    "很有启发", "干货", "点赞", "求关注", "互关", "回关", "互赞", "求带",
    "太强了", "牛啊", "支持一下", "前排", "沙发",
)

# 编造亲历的口吻
FABRICATION_PATTERNS = (
    "我刚测过", "我昨天试了", "我上周刚", "我用了一周", "我朋友在做",
    "我们团队实测", "我刚买", "我刚部署",
)

# 纯表情 / 纯点赞类通知（SOP 4/8：不必追问）
_EMOJI_ONLY = re.compile(r"^[\s\W_]+$")


# ---------------- 阅读分层 ---------------- #

def should_skip(tweet: dict) -> tuple[bool, str]:
    """扫读阶段是否直接滑过（第 2.2 节第一层）。"""
    text = (tweet.get("text") or "").strip()
    if not text:
        return True, "无正文（纯图/纯链接）"
    low = text.lower()
    for p in SKIP_PATTERNS:
        if p in text:
            return True, f"命中跳过项：{p}"
    if len(text) < 8 and not re.search(r"[a-zA-Z]{4,}", text):
        return True, "正文过短且无可读信息"
    if "http" in low and len(text) < 40:
        return True, "疑似纯链接"
    return False, ""


def quality_score(tweet: dict) -> float:
    """内容质量粗评（用于决定「值不值得展开/关注这个人」）。"""
    text = (tweet.get("text") or "")
    s = 0.0
    for sig in QUALITY_SIGNALS:
        if sig in text:
            s += 1.0
    s += min(len(text), 400) / 400.0 * 1.5          # 有一定篇幅
    if re.search(r"\d", text):
        s += 0.6                                     # 带数字更具体
    if any(k in text for k in config.INTEREST_KEYWORDS):
        s += 1.0
    return s


def should_expand(tweet: dict) -> bool:
    """第二层：是否点进详情/展开全文。

    SOP：长帖、图文、引用帖、回复类要展开看上下文；信息流已读懂的不必点进去。
    """
    text = (tweet.get("text") or "")
    if len(text) >= 220:
        return True                                  # 长帖必须看完
    if tweet.get("social"):
        return True                                  # 转推/引用，看原上下文
    if re.search(r"(回复|replied|Replying to)", text[:80], re.I):
        return True
    return random.random() < float(behavior.get("expand_prob") or 0.25)


# ---------------- 点赞（第 3 节）---------------- #

def should_like(tweet: dict) -> tuple[bool, str]:
    """读懂并且认可某个具体点才赞；不是任务。"""
    if should_skip(tweet)[0]:
        return False, "扫读阶段就跳过了"
    q = quality_score(tweet)
    base = float(behavior.get("like_prob") or 0.35)
    # 内容越具体，越值得赞（而不是每条都赞）
    p = min(0.9, base * (0.6 + q / 6.0))
    if random.random() > p:
        return False, f"概率外（{p:.0%}）"
    return True, f"质量分 {q:.1f}，点赞概率 {p:.0%}"


# ---------------- 评论（第 4 节）---------------- #

def should_comment(tweet: dict) -> tuple[bool, str]:
    """有没有「只有看过这条原帖才能写出来」的一句话说。"""
    if should_skip(tweet)[0]:
        return False, "扫读阶段就跳过了"
    text = (tweet.get("text") or "")
    if len(text) < 15:
        return False, "内容太薄，没有可接的具体点"
    if quality_score(tweet) < 1.2:
        return False, "看不出具体点（都是泛泛而谈）"
    p = float(behavior.get("comment_prob") or 0.2)
    if random.random() > p:
        return False, f"概率外（{p:.0%}）"
    return True, f"评论概率 {p:.0%}"


# 太泛的词：即便在原帖里出现，也不能证明「你读了这条帖子」
GENERIC_TOKENS = {
    "工具", "时间", "内容", "帖子", "这个", "那个", "真的", "就是", "可以",
    "东西", "问题", "方法", "感觉", "应该", "需要", "觉得", "还是", "不是",
}


def _specific_overlap(comment: str, post_text: str) -> int:
    """评论里有多少「具体片段」是原帖里出现过的。

    中文没有空格切词，所以按 **2 字片段（bigram）** 统计：
    只算非泛词片段 —— 「整理 / 纪要 / 原句」这类承接原帖的实词会命中，
    而「工具 / 这个 / 可以」这种到处都有的不算。
    """
    post = post_text or ""
    hits = 0
    for run in re.findall(r"[\u4e00-\u9fa5]{2,}", comment or ""):
        for i in range(len(run) - 1):
            g = run[i:i + 2]
            if g in GENERIC_TOKENS:
                continue
            if g in post:
                hits += 1
    for w in re.findall(r"[A-Za-z0-9]{3,}", comment or ""):
        if w.lower() in post.lower():
            hits += 1
    return hits


def validate_comment(comment: str, tweet: dict) -> tuple[bool, str]:
    """第 4.1/4.7/12 节的发前检查。不合格就重写或放弃。"""
    c = (comment or "").strip()
    if not c:
        return False, "空评论"
    if len(c) > 200:
        return False, "过长（SOP 不要求长，长容易注水）"
    for bad in BANNED_COMMENT_PATTERNS:
        if bad in c:
            return False, f"含禁用表达：{bad}"
    for bad in FABRICATION_PATTERNS:
        if bad in c:
            return False, f"疑似编造亲历：{bad}"
    if any(k in c for k in ("互关", "回关", "互赞", "关注我")):
        return False, "涉及互动交换（SOP 明令禁止）"
    if _EMOJI_ONLY.match(c):
        return False, "纯表情/纯符号"
    # 必须接住原帖里的至少一个具体实词，否则就是「放哪都成立」
    if _specific_overlap(c, tweet.get("text") or "") < 1:
        return False, "没有接住原帖的具体点（换个帖也能用 → 不合格）"
    return True, "通过"


# ---------------- 收藏（第 6 节）---------------- #

def should_bookmark(tweet: dict) -> tuple[bool, str]:
    """收藏是留给「过几天还可能用到」的内容，不是另一种点赞。"""
    if should_skip(tweet)[0]:
        return False, "扫读阶段就跳过了"
    text = (tweet.get("text") or "")
    useful = any(k in text for k in ("工具", "方法", "流程", "教程", "清单", "对比",
                                     "限制", "价格", "文档", "实测", "踩坑"))
    if not useful:
        return False, "看不出以后会用到"
    p = float(behavior.get("bookmark_prob") or 0.05)
    if random.random() > p:
        return False, f"概率外（{p:.0%}）"
    return True, "有复用价值"


# ---------------- 关注（第 5 节）---------------- #

def should_follow(profile: dict, recent_tweets: list[dict], why: str = "") -> tuple[bool, str]:
    """关注前看：简介能不能辨认方向 / 近期多篇是不是都在认真写 / 能不能说出关注理由。"""
    bio = (profile.get("bio") or "").strip()
    if len(bio) < 6:
        return False, "简介看不出方向"
    if not recent_tweets:
        return False, "看不到近期原帖"
    good = sum(1 for t in recent_tweets
               if quality_score(t) >= 1.5 and not should_skip(t)[0])
    if good < max(1, len(recent_tweets) // 3):
        return False, f"近期 {len(recent_tweets)} 条里只有 {good} 条像认真内容"
    if not why.strip():
        return False, "说不出关注理由"
    # 慢慢加：每日上限由 limits.json 的 follow 控制
    return True, f"{good}/{len(recent_tweets)} 条符合，理由：{why[:40]}"


# ---------------- 通知（4.8 节）---------------- #

def notification_needs_reply(text: str) -> tuple[bool, str]:
    """自己的通知优先处理；但纯表情、纯点赞不必追问。"""
    t = (text or "").strip()
    if not t:
        return False, "空通知"
    # 去掉「回复了你 / mentioned you」等前缀后看实质内容
    # X 的通知格式是「某人 replied to you 正文」，所以取提示语之后的部分才是对方说的内容
    parts = re.split(r"(replied to you|回复了你|mentioned you|提到了你)", t, flags=re.I)
    body = (parts[-1] if len(parts) >= 2 else t).strip(" ·:：-\n")
    body = re.sub(r"·\s*\d+\s*[mhd]$", "", body).strip()
    if not body:
        return False, "只有提示没有正文"
    if _EMOJI_ONLY.match(body):
        return False, "纯表情/纯符号"
    if len(body) < 4:
        return False, "内容太短，无需追问"
    return True, "有实质内容"


# ---------------- 转帖/引用（第 7 节）---------------- #

def should_repost() -> tuple[bool, str]:
    """转帖默认关闭：SOP 要求「基本同意且愿意公开扩散」才转。"""
    if not behavior.get("allow_repost"):
        return False, "转帖默认关闭（SOP：需要单独判断）"
    return False, "程序不做自动转帖：SOP 要求逐条人工判断"
