"""行为设置：语气、风格、选帖策略、节奏、休息、故障恢复。

全部持久化在 xauto/data/behavior.json，UI 上改完立即生效（工具每次启动读一次）。
"""

from __future__ import annotations

import json

from xauto import config

FILE = config.DATA_DIR / "behavior.json"

# ---- 可选项（UI 下拉框直接用这些）----

TONES = {
    "friendly": "随和（默认）：像朋友随口接一句",
    "professional": "专业：讲事实、给判断，不闲聊",
    "humorous": "幽默：轻松的调侃，不刻薄",
    "curious": "好奇：以提问或请教为主",
    "supportive": "共情：先认同情绪，再补一句",
    "sharp": "犀利：直接给不同意见，但不攻击人",
}

STYLES = {
    "short": "极简：10~25 字，一句到底",
    "normal": "标准：20~60 字，一句到两句",
    "detailed": "详细：60~120 字，带具体理由",
}

PICK_STRATEGIES = {
    "latest": "最新：优先回时间线上最新的帖子",
    "random": "纯随机：完全不挑",
    "interest": "兴趣优先：命中兴趣词的概率更高",
    "popular": "热帖优先：互动量（赞/转）高的优先",
}

DAILY_REST_OPTIONS = (0, 30, 60, 90, 120, 240)   # 分钟；0=关闭

DEFAULTS = {
    "tone": "friendly",            # 回复语气
    "style": "normal",             # AI 回复风格档次
    "pick_strategy": "interest",   # 回复哪篇帖子
    "reply_gap_min": 60,           # 两次回复之间最短秒数（SOP：不追求固定间隔，放宽）
    "reply_gap_max": 240,          # 两次回复之间最长秒数
    "typing_ms": 150,              # 打字时每个字符毫秒数
    "rest_after_replies": 3,       # 每回复 N 条后休息（0=不休息）
    "rest_minutes": 10,            # 单次休息多少分钟
    "daily_rest_enabled": True,    # 每日定时休息开关
    "daily_rest_start": "02:00",   # 每日休息开始时间
    "daily_rest_minutes": 60,      # 每日休息时长（分钟）
    "refresh_on_failures": 2,      # 连续失败多少次后刷新页面
    "max_refresh": 3,              # 最多连续刷新几次
    "stop_after_failures": 6,      # 连续失败多少次后停止任务（0=不停止）

    # ---- SOP 专属：动作各自独立，都允许「什么都不做」 ----
    "session_minutes": 25,         # 时间盒：一次会话多久（SOP 2.5：20~30 分钟）
    "expand_prob": 0.25,           # 扫读后「值得展开」的比例（SOP 2.2 分层）
    "like_prob": 0.35,             # 读懂且认可才赞，基线概率
    "comment_prob": 0.2,           # 有可接的具体点才评，基线概率
    "bookmark_prob": 0.05,         # 收藏只留给以后会用到
    "follow_per_session": 1,       # 一次会话最多关注几个人（慢慢加）
    "allow_repost": False,         # SOP：转帖需逐条人工判断，默认关
    "search_mutual_follow": False, # SOP 禁止互动交换 → 默认不搜「互关」找人
}


def load() -> dict:
    d = dict(DEFAULTS)
    try:
        if FILE.exists():
            raw = json.loads(FILE.read_text(encoding="utf-8"))
            for k, v in raw.items():
                if k in DEFAULTS:
                    d[k] = v
    except Exception:
        pass
    return _sanitize(d)


def _sanitize(d: dict) -> dict:
    if d["tone"] not in TONES:
        d["tone"] = "friendly"
    if d["style"] not in STYLES:
        d["style"] = "normal"
    if d["pick_strategy"] not in PICK_STRATEGIES:
        d["pick_strategy"] = "interest"
    for k, lo, hi in (("reply_gap_min", 1, 3600), ("reply_gap_max", 1, 7200),
                      ("typing_ms", 10, 2000), ("rest_after_replies", 0, 1000),
                      ("rest_minutes", 0, 720), ("daily_rest_minutes", 0, 1440),
                      ("refresh_on_failures", 0, 20), ("max_refresh", 0, 20),
                      ("stop_after_failures", 0, 100), ("session_minutes", 1, 240),
                      ("follow_per_session", 0, 20)):
        try:
            d[k] = int(d[k])
        except Exception:
            d[k] = DEFAULTS[k]
        d[k] = max(lo, min(hi, d[k]))
    for k in ("expand_prob", "like_prob", "comment_prob", "bookmark_prob"):
        try:
            d[k] = float(d[k])
        except Exception:
            d[k] = DEFAULTS[k]
        d[k] = max(0.0, min(1.0, d[k]))
    d["allow_repost"] = bool(d.get("allow_repost"))
    d["search_mutual_follow"] = bool(d.get("search_mutual_follow"))
    if d["reply_gap_max"] < d["reply_gap_min"]:
        d["reply_gap_max"] = d["reply_gap_min"]
    d["daily_rest_enabled"] = bool(d["daily_rest_enabled"])
    return d


def save(updates: dict) -> dict:
    d = load()
    for k, v in (updates or {}).items():
        if k in DEFAULTS:
            d[k] = v
    d = _sanitize(d)
    config.ensure_dirs()
    FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def get(key: str):
    return load().get(key, DEFAULTS.get(key))


def options() -> dict:
    return {"tones": TONES, "styles": STYLES, "pick_strategies": PICK_STRATEGIES,
            "daily_rest_options": DAILY_REST_OPTIONS}
