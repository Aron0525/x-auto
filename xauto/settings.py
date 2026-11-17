"""运行设置（UI 可改）：xauto/data/settings.json

目前只有一项，但很关键：
    input_mode = "os"  → 真实鼠标键盘（SendInput）：像人，但会占用你的鼠标/抢前台
    input_mode = "cdp" → 后台合成事件（Input.dispatchMouseEvent / insertText）：
                         不动真实光标、不抢焦点，代价是窗口必须保持可见（不能最小化）

工具每次启动读一次；UI 保存后新拉起的任务立即生效。
"""

from __future__ import annotations

import json
import os

from xauto import config

SETTINGS_FILE = config.DATA_DIR / "settings.json"

DEFAULTS = {
    "input_mode": os.environ.get("XAUTO_INPUT", "os"),   # os | cdp
}


def load() -> dict:
    d = dict(DEFAULTS)
    try:
        if SETTINGS_FILE.exists():
            d.update({k: v for k, v in json.loads(
                SETTINGS_FILE.read_text(encoding="utf-8")).items() if k in DEFAULTS})
    except Exception:
        pass
    if d.get("input_mode") not in ("os", "cdp"):
        d["input_mode"] = "os"
    return d


def save(updates: dict) -> dict:
    d = load()
    for k, v in (updates or {}).items():
        if k == "input_mode" and v in ("os", "cdp"):
            d[k] = v
    config.ensure_dirs()
    SETTINGS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def input_mode() -> str:
    return load()["input_mode"]
