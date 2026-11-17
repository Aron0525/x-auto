# ============ 拟人输入层：绕开「整段文本瞬间注入」这类机器特征 ============
# 为什么不用 Input.insertText 一把梭（2026-11-16 实测后换掉的方案）：
#   insertText 会在一次输入事件里塞进整段文本：
#     · beforeinput 的 inputType 是 insertText，data 长度 = 全文长度
#     · 前后没有任何 keydown/keypress/composition 事件
#     · Draft.js 那边一次 input 就把内容全填上
#   真人写中文是「输入法组合 → 提交」，英文是逐字 keydown。上面那种形态在
#   X 的风险模型里属于显著异常，配合随后的快速导航/刷新，很容易被判定为脚本。
#
# 本模块的做法：
#   1. 中文/混合文本：走 IME 组合提交（Input.imeSetComposition + Input.insertText），
#      每 3~6 字提交一次，中间随机停顿 —— 这就是真人用拼音输入法上屏的样子
#   2. 纯 ASCII 短串：逐字 dispatchKeyEvent（keyDown 带 text → 浏览器自己发 keypress）
#   3. 鼠标：先从当前位置做缓动轨迹（多段 mouseMoved + 抖动），再按下/松开
# 全部仍然只用 CDP 的 Input.* 域，不引入任何自动化框架。

from __future__ import annotations

import random
import time

from core.cdp import Cdp, CdpError

# 上一次鼠标落点，用来让轨迹连续（像人一样从上一个位置移过去）
_last_pos: tuple[int, int] | None = None


def _sleep(a: float, b: float):
    time.sleep(random.uniform(a, b))


def is_ascii(text: str) -> bool:
    return all(ord(c) < 128 for c in text)


# ---------------- 键盘 ----------------

def _key_char(cdp: Cdp, ch: str) -> bool:
    """一个 ASCII 字符：keyDown(带 text) + keyUp。浏览器据此生成 keypress/input。"""
    code = f"Key{ch.upper()}" if ch.isalpha() else ("Digit" + ch if ch.isdigit()
                                                   else {" ": "Space", ".": "Period",
                                                         ",": "Comma", "!": "Digit1",
                                                         "?": "Slash"}.get(ch, ""))
    vk = ord(ch.upper()) if (ch.isalpha() or ch.isdigit()) else {
        " ": 32, ".": 190, ",": 188, "!": 49, "?": 191}.get(ch, 0)
    base = {"key": ch, "code": code or ch, "text": ch, "unmodifiedText": ch,
            "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
    try:
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyDown"})
        _sleep(0.01, 0.03)
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyUp", "text": ""})
    except CdpError:
        return False
    return True


def _ime_commit(cdp: Cdp, chunk: str) -> bool:
    """模拟输入法上屏：先组合（带下划线候选），再提交。

    imeSetComposition 让页面先看到 composition 事件，随即 insertText 提交，
    这正是真实中文输入的 DOM 事件序列。
    """
    try:
        cdp.call("Input.imeSetComposition", {
            "text": chunk, "selectionStart": len(chunk), "selectionEnd": len(chunk),
        })
        _sleep(0.08, 0.2)
        cdp.call("Input.insertText", {"text": chunk})
    except CdpError:
        return False
    return True


def _clipboard_paste(cdp: Cdp, text: str) -> bool:
    """兜底：写系统剪贴板 + Ctrl+V。

    真人复制粘贴是很正常的行为，X 不会因此判定异常；
    比「一次 insertText 灌入整段」自然得多。
    """
    try:
        import pyperclip
        pyperclip.copy(text)
    except Exception:
        return False
    _sleep(0.15, 0.35)
    try:
        cdp.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown", "key": "v", "code": "KeyV",
            "windowsVirtualKeyCode": 86, "nativeVirtualKeyCode": 86, "modifiers": 2})
        _sleep(0.05, 0.12)
        cdp.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "v", "code": "KeyV",
            "windowsVirtualKeyCode": 86, "nativeVirtualKeyCode": 86, "modifiers": 2,
            "text": ""})
    except CdpError:
        return False
    _sleep(0.3, 0.7)
    return True


def type_like_human(cdp: Cdp, text: str, chunk: tuple[int, int] = (3, 6),
                    per_char_ms: int = 150) -> str:
    """把 text 写成「人打字」的样子。返回实际使用的方式（日志用）。

    策略：中文（或中英混排）走 IME 分块提交；纯 ASCII 走逐字按键。
    节奏由 per_char_ms 决定（UI 默认 150ms/字符）：IME 每提交一块，就按块内字数
    乘以每字间隔停顿 —— 长句自然更慢，短句更快，和真人手速分布接近。
    """
    if not text:
        return "empty"
    per_char = max(0.01, per_char_ms / 1000.0)
    mode = "ascii-keys" if is_ascii(text) else "ime-chunks"
    i = 0
    while i < len(text):
        n = 1 if mode == "ascii-keys" else random.randint(*chunk)
        part = text[i:i + n]
        if mode == "ascii-keys":
            ok = True
            for ch in part:
                ok = _key_char(cdp, ch)
                if not ok:
                    break
                time.sleep(per_char * random.uniform(0.7, 1.3))
            if not ok:
                if not _clipboard_paste(cdp, text[i:]):
                    return "failed"
                return mode + "+paste"
        else:
            if not _ime_commit(cdp, part):
                if not _clipboard_paste(cdp, text[i:]):
                    return "failed"
                return mode + "+paste"
            time.sleep(per_char * len(part) * random.uniform(0.7, 1.2))
        i += n
    return mode


# ---------------- 鼠标 ----------------

def _move_to(cdp: Cdp, x: int, y: int, steps: int = 9) -> bool:
    """从上次落点到目标点做一条缓动轨迹（带 1~2px 抖动）。"""
    global _last_pos
    sx, sy = _last_pos or (x - random.randint(60, 160), y - random.randint(30, 120))
    for k in range(1, steps + 1):
        t = k / steps
        ease = 1 - (1 - t) ** 2                     # easeOutQuad
        px = int(sx + (x - sx) * ease + random.uniform(-1.5, 1.5))
        py = int(sy + (y - sy) * ease + random.uniform(-1.5, 1.5))
        try:
            cdp.call("Input.dispatchMouseEvent",
                     {"type": "mouseMoved", "x": px, "y": py, "button": "none"})
        except CdpError:
            return False
        _sleep(0.012, 0.045)
    _last_pos = (x, y)
    return True


def click_like_human(cdp: Cdp, x: float, y: float,
                     settle: tuple[float, float] = (0.35, 0.9)) -> bool:
    """缓动移动 → 悬停 → 按下 → 松开。不用瞬移点击。"""
    x, y = int(x), int(y)
    if not _move_to(cdp, x, y):
        return False
    _sleep(0.15, 0.5)                                # 悬停反应时间
    base = {"x": x, "y": y, "button": "left", "clickCount": 1}
    try:
        cdp.call("Input.dispatchMouseEvent", {**base, "type": "mousePressed", "buttons": 1})
        _sleep(0.05, 0.13)                           # 按压时长
        cdp.call("Input.dispatchMouseEvent", {**base, "type": "mouseReleased", "buttons": 0})
    except CdpError:
        return False
    _sleep(*settle)
    return True
