"""DOM 层小工具：等待条件、抓文本、找元素表达式。

这里只负责「读」，不负责点。点击/输入统一在 pages/x_twitter.py 里用
core.cdpinput 处理，保持「读走 evaluate、写走 Input」的分工。
"""

from __future__ import annotations

import json
import time
from typing import Any

from core.cdp import Cdp, CdpError


def js(value: Any) -> str:
    """把 Python 值安全地嵌进 JS 表达式。"""
    return json.dumps(value, ensure_ascii=False)


def wait_js(cdp: Cdp, condition: str, timeout: float = 10.0,
            interval: float = 0.35, label: str = "条件") -> bool:
    """轮询一段返回布尔值的 JS，直到为真或超时。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if cdp.evaluate("Boolean(" + condition + ")"):
                return True
        except CdpError:
            pass
        time.sleep(interval)
    return False


def wait_element(cdp: Cdp, selector: str, timeout: float = 10.0) -> bool:
    return wait_js(cdp, f"document.querySelector({js(selector)})",
                   timeout=timeout, label=selector)


def wait_gone(cdp: Cdp, selector: str, timeout: float = 10.0) -> bool:
    return wait_js(cdp, f"!document.querySelector({js(selector)})",
                   timeout=timeout, label=f"!{selector}")


def count(cdp: Cdp, selector: str) -> int:
    try:
        return int(cdp.evaluate(f"document.querySelectorAll({js(selector)}).length") or 0)
    except CdpError:
        return 0


def text_of(cdp: Cdp, selector: str) -> str:
    try:
        return (cdp.evaluate(
            f"(document.querySelector({js(selector)}) || {{}}).innerText || ''") or "").strip()
    except CdpError:
        return ""


def scroll(cdp: Cdp, times: int = 1, delta: int = 900, pause: tuple[float, float] = (0.8, 1.8)):
    """整页滚动（时间线懒加载靠它）。"""
    import random
    for _ in range(max(1, times)):
        cdp.evaluate(f"window.scrollBy(0, {int(delta)});")
        time.sleep(random.uniform(*pause))


def shot(cdp: Cdp, path: str) -> bool:
    return cdp.screenshot(path)
