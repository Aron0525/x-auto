"""每日上限（可从 UI 改）：xauto/data/limits.json。

为什么不写死在 config.py：用户要在控制台上直接调上限，改文件再重启进程太笨。
所以上限落地成一个 JSON，工具每次跑之前读一次。
"""

from __future__ import annotations

import json
from pathlib import Path

from xauto import config

LIMITS_FILE = config.DATA_DIR / "limits.json"

DEFAULTS = {
    "like": 60,        # 每天点赞上限
    "reply": 20,       # 每天评论上限（含评论别人）
    "follow": 25,      # 每天关注上限
    "mention": 20,     # 每天回复「通知里别人回我」的上限
    "post": 6,         # 每天发帖上限
}


def load() -> dict:
    d = dict(DEFAULTS)
    try:
        if LIMITS_FILE.exists():
            d.update({k: int(v) for k, v in json.loads(
                LIMITS_FILE.read_text(encoding="utf-8")).items() if k in DEFAULTS})
    except Exception:
        pass
    return d


def save(updates: dict) -> dict:
    d = load()
    for k, v in (updates or {}).items():
        if k in DEFAULTS:
            try:
                d[k] = max(0, int(v))
            except Exception:
                pass
    config.ensure_dirs()
    LIMITS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def get(name: str) -> int:
    return int(load().get(name, 0))
