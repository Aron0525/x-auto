"""原创文案生成（SOP 第 10 节：吸收灵感，但不照搬）。

要点：
  · 不能把时间线里的句子改写后发一遍 → 只给主题，让模型用它自己的问题/过程/观察写
  · 工具帖必须写「实际做了什么」；没做过就别写成体验
  · 短感想可以保留，但要让读者带走一个具体例子或限制条件
  · 语气/长度跟行为设置走
"""

from __future__ import annotations

import re

from xauto import behavior, comment as comment_gen, config

SYSTEM = """你是 X 上的中文科技/创业向创作者，要发一条原创推文。

硬规则：
1. 只输出推文正文，不要解释、不要标题、不要引号。
2. 不要话题标签（#）堆砌，不要 @ 人，不要贴链接，不要推销。
3. 不要空话套话（「干货来了」「值得一看」「一起加油」一律禁止）。
4. 必须让读者带走**一个具体的东西**：一个观察、一个具体做法、一个具体数字，或一个具体的坑。
5. 不要照抄别人时间线上的句子；用你自己的问题和经历口吻写。
6. 没做过的事不要写成体验（不许编造「我实测过」）。
【语气】{tone}
【长度】{style}"""

_TONE = {
    "friendly": "随和，像跟朋友聊天",
    "professional": "专业克制，讲事实给判断",
    "humorous": "轻松幽默，可以自嘲",
    "curious": "好奇，抛问题和观察",
    "supportive": "共情，鼓励但不喊口号",
    "sharp": "直接，有态度但不攻击人",
}
_STYLE = {
    "short": "10~30 字",
    "normal": "30~80 字，一到两句",
    "detailed": "80~180 字，带一个具体细节或例子",
}


def generate_post(topic: str) -> dict:
    """按主题生成一条原创推文。返回 {text, source, error?}。"""
    try:
        from message import llm as llm_mod
        comment_gen.ensure_key()
        system = SYSTEM.format(
            tone=_TONE.get(behavior.get("tone"), _TONE["friendly"]),
            style=_STYLE.get(behavior.get("style"), _STYLE["normal"]),
        )
        raw = llm_mod.chat(system, f"【主题】{topic}", dict(config.LLM))
        text = re.sub(r"\s+", " ", (raw or "").strip()).strip('"“”「」')
        if not text:
            return {"text": "", "source": "llm", "error": "模型返回空"}
        return {"text": text[:280], "source": "llm"}
    except Exception as e:
        return {"text": "", "source": "error", "error": str(e)}
