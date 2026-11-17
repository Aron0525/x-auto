# ============ 原生 Win32 输入层（SendInput）============
# 为什么不用 pyautogui 的封装/JS 滚动：
#   用户要求「尽可能像真实键鼠」「尽可能底层原生」。所以这里直接调 user32.SendInput：
#     · 鼠标移动：MOUSEEVENTF_MOVE + MOUSEEVENTF_ABSOLUTE，逐点发送（约 60~90Hz），
#       轨迹用二次贝塞尔 + easeOut，带 ±1px 抖动和偶发微停顿 —— 和真人手移动一致
#     · 点击：LEFTDOWN → 按住 40~120ms → LEFTUP（真实按压时长）
#     · 滚动：MOUSEEVENTF_WHEEL，按「滚轮格」发（每格 120），
#       带不等间隔 —— 这就是人手滚鼠标滚轮产生的事件，不是 window.scrollBy 那种跳变
#     · 键盘：KEYBDINPUT（ASCII 用 KEYEVENTF_UNICODE 发 WM_CHAR，中文留剪贴板）
#
# 注意：本进程必须声明 DPI 感知，否则 Windows 会做坐标虚拟化，点偏（见 _dpi_aware）。
from __future__ import annotations

import ctypes
import random
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

# ---------------- 常量 ----------------
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD),
                ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _dpi_aware() -> None:
    """声明 DPI 感知：不做这一步，SendInput 的坐标和浏览器报的 CSS 像素对不上。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      # PER_MONITOR_AWARE
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


_dpi_aware()

_screen = None


def screen_size() -> tuple[int, int]:
    """主屏（虚拟桌面）宽高，物理像素。"""
    global _screen
    if _screen is None:
        w = user32.GetSystemMetrics(78)      # SM_CXVIRTUALSCREEN
        h = user32.GetSystemMetrics(79)      # SM_CYVIRTUALSCREEN
        if not w or not h:
            w = user32.GetSystemMetrics(0)
            h = user32.GetSystemMetrics(1)
        _screen = (w, h)
    return _screen


def _sleep(a: float, b: float):
    time.sleep(random.uniform(a, b))


# ---------------- 发送 ----------------

def _send(*inputs: INPUT) -> bool:
    if not inputs:
        return False
    arr = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    return sent == len(inputs)


def _mouse_input(dx: int, dy: int, data: int, flags: int) -> INPUT:
    mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return INPUT(type=INPUT_MOUSE, u=_INPUTUNION(mi=mi))


def _abs_xy(x: int, y: int) -> tuple[int, int]:
    """屏幕物理像素 → SendInput 的 0..65535 归一化绝对坐标。"""
    w, h = screen_size()
    nx = int(round((x * 65535) / max(1, w - 1)))
    ny = int(round((y * 65535) / max(1, h - 1)))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def move_to(x: int, y: int, duration: float | None = None, steps: int | None = None) -> None:
    """沿一条「像人手」的曲线移到 (x,y)。

    轨迹：从当前光标位置起，控制点带随机偏移的二次贝塞尔 + easeOut 采样；
    每步再叠 ±1px 抖动，间隔 8~22ms（约 45~120Hz，接近真实鼠标上报率）。
    """
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    sx, sy = pt.x, pt.y
    dist = max(1, int(((x - sx) ** 2 + (y - sy) ** 2) ** 0.5))
    steps = steps or max(8, min(60, dist // 18 + random.randint(6, 14)))
    duration = duration or random.uniform(0.22, 0.55) * (0.6 + dist / 1200.0)

    # 控制点：垂直于直线的随机偏移，形成人手那种弧线
    mx, my = (sx + x) / 2, (sy + y) / 2
    bend = random.uniform(-0.18, 0.18) * dist
    cx = mx + (y - sy) / max(1, dist) * bend
    cy = my - (x - sx) / max(1, dist) * bend

    for i in range(1, steps + 1):
        t = i / steps
        e = 1 - (1 - t) ** 2                      # easeOut
        bx = (1 - e) ** 2 * sx + 2 * (1 - e) * e * cx + e ** 2 * x
        by = (1 - e) ** 2 * sy + 2 * (1 - e) * e * cy + e ** 2 * y
        px = int(bx + random.uniform(-1.0, 1.0))
        py = int(by + random.uniform(-1.0, 1.0))
        nx, ny = _abs_xy(px, py)
        _send(_mouse_input(nx, ny, 0,
                           MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK))
        time.sleep(duration / steps * random.uniform(0.7, 1.3))
        if random.random() < 0.04:                # 偶尔手一顿
            _sleep(0.03, 0.09)


def click(x: int | None = None, y: int | None = None, button: str = "left",
          hover: float | None = None) -> bool:
    """移动（可选）→ 悬停 → 按下 → 按住 → 松开。"""
    if x is not None and y is not None:
        move_to(int(x), int(y))
    _sleep(*(hover, hover) if hover else (0.08, 0.28))
    down = MOUSEEVENTF_LEFTDOWN if button == "left" else MOUSEEVENTF_RIGHTDOWN
    up = MOUSEEVENTF_LEFTUP if button == "left" else MOUSEEVENTF_RIGHTUP
    if not _send(_mouse_input(0, 0, 0, down)):
        return False
    _sleep(0.045, 0.13)                            # 真实按压时长
    return _send(_mouse_input(0, 0, 0, up))


def wheel(notches: int, interval: tuple[float, float] = (0.05, 0.18)) -> None:
    """滚动鼠标滚轮。notches > 0 向上，< 0 向下（一格 = 系统 120 单位）。"""
    step = 1 if notches > 0 else -1
    for _ in range(abs(int(notches))):
        _send(_mouse_input(0, 0, step * 120, MOUSEEVENTF_WHEEL))
        _sleep(*interval)


# ---------------- 键盘 ----------------

def key(vk: int, down: bool = True, scan: int = 0) -> bool:
    ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=(0 if down else KEYEVENTF_KEYUP),
                    time=0, dwExtraInfo=0)
    return _send(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=ki)))


def press(vk: int, hold: tuple[float, float] = (0.03, 0.09)) -> None:
    key(vk, True)
    _sleep(*hold)
    key(vk, False)


def hotkey(*vks: int) -> None:
    for vk in vks:
        key(vk, True)
        _sleep(0.02, 0.06)
    for vk in reversed(vks):
        key(vk, False)
        _sleep(0.02, 0.05)


def type_unicode(text: str, cpm: int = 260) -> None:
    """逐字符发 WM_CHAR（KEYEVENTF_UNICODE）。适合 ASCII/符号，像人一个字一个字敲。"""
    base = 60.0 / max(1, cpm)
    for ch in text:
        code = ord(ch)
        ki = KEYBDINPUT(wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE, time=0, dwExtraInfo=0)
        _send(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=ki)))
        ki_up = KEYBDINPUT(wVk=0, wScan=code,
                           dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time=0, dwExtraInfo=0)
        _send(INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=ki_up)))
        time.sleep(base * random.uniform(0.6, 1.6))


VK = {
    "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "enter": 0x0D, "esc": 0x1B, "backspace": 0x08, "tab": 0x09,
    "space": 0x20, "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "a": 0x41, "v": 0x56, "c": 0x43, "l": 0x4C, "r": 0x52,
}
