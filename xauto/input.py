# ============ 输入通道：默认走「真实 OS 鼠标键盘」（原生 SendInput）============
# 用户的硬要求（2026-11-16）：
#   1. 鼠标轨迹、点击、滚轮都要像真人 → 走 xauto/wininput.py 的 SendInput 实现
#   2. 不许用「输入网址 / location 跳转 / history.back」来换页
#      → 所有页面跳转必须点界面元素（左栏 Home、帖子正文、详情页返回箭头）
#   3. 滚动必须是滚轮事件，不能用 window.scrollBy 那种跳变
#
# 硬约束（os 通道）：窗口必须【前台】且可见，否则点击会落到别的窗口上。
# 每次操作前先 focus_window 并验证 GetForegroundWindow，拿不到就返回失败，绝不盲点。
#
# 坐标口径：CDP 给的是视口 CSS 像素，真实鼠标要【屏幕物理像素】：
#   (window.screenX + 浏览器边框 + 视口偏移) × dpr
#   进程必须已声明 DPI 感知（wininput 里做了），否则 Windows 会做坐标虚拟化导致点偏。

from __future__ import annotations

import os
import random
import time

import pyperclip

from xauto import bootstrap  # noqa: F401  —— 接上只读仓库
from core.cdp import Cdp, CdpError
from core import human as os_human
from xauto import wininput as wi

MODE = os.environ.get("XAUTO_INPUT", "").lower()   # "os" | "cdp"


def _init_mode() -> str:
    """优先级：环境变量 XAUTO_INPUT > UI 设置文件 settings.json > 默认 os。"""
    global MODE
    if MODE in ("os", "cdp"):
        return MODE
    try:
        from xauto import settings as _settings
        MODE = _settings.input_mode()
    except Exception:
        MODE = "os"
    return MODE


_init_mode()

_browser_exe: str | None = None


def set_mode(mode: str) -> str:
    global MODE
    MODE = "cdp" if str(mode).strip().lower() == "cdp" else "os"
    return MODE


def describe() -> dict:
    """给 UI/日志用：当前通道是什么、会不会占用真实鼠标。"""
    return {"mode": MODE,
            "takes_mouse": MODE == "os",
            "note": ("真实鼠标键盘（SendInput）：会移动你的光标、需要窗口在前台"
                     if MODE == "os" else
                     "后台合成事件：不动真实光标、不抢焦点；窗口需保持可见（不能最小化）")}


def _sleep(a: float, b: float):
    time.sleep(random.uniform(a, b))


# ---------------- 前台窗口 ----------------

def ensure_foreground(cdp: Cdp) -> bool:
    """把脚本所连的那个浏览器窗口提到前台。返回是否真的成了前台窗口。"""
    global _browser_exe
    try:
        if not _browser_exe:
            ua = cdp.evaluate("navigator.userAgent") or ""
            _browser_exe = os_human.browser_exe_from_ua(ua)
            os_human.set_target_browser(_browser_exe)
        title = ""
        try:
            title = cdp.title() or ""
        except CdpError:
            pass
        return os_human.focus_window(title_hint=title or None, prefer_exe=_browser_exe)
    except Exception:
        return False


# ---------------- 坐标换算：视口 CSS → 屏幕物理 ----------------

_SCREEN_JS = r"""
const el = %s;
if (!el) return null;
el.scrollIntoView({block: 'center', inline: 'nearest'});
const r = el.getBoundingClientRect();
const dpr = window.devicePixelRatio || 1;
const chromeX = (window.outerWidth  - window.innerWidth)  || 0;
const chromeY = (window.outerHeight - window.innerHeight) || 0;
return {
  x: Math.round((window.screenX + chromeX + r.left + r.width  / 2) * dpr),
  y: Math.round((window.screenY + chromeY + r.top  + r.height / 2) * dpr),
  vx: Math.round(r.left + r.width / 2),
  vy: Math.round(r.top  + r.height / 2),
  w: Math.round(r.width), h: Math.round(r.height), dpr: dpr,
};
"""

_VIEWPORT_CENTER_JS = r"""
const dpr = window.devicePixelRatio || 1;
const chromeX = (window.outerWidth  - window.innerWidth)  || 0;
const chromeY = (window.outerHeight - window.innerHeight) || 0;
return {
  x: Math.round((window.screenX + chromeX + window.innerWidth  * 0.5) * dpr),
  y: Math.round((window.screenY + chromeY + window.innerHeight * 0.45) * dpr),
};
"""


def screen_point(cdp: Cdp, expr: str) -> dict | None:
    try:
        return cdp.evaluate("(() => {" + (_SCREEN_JS % expr) + "})()")
    except CdpError:
        return None


def viewport_center(cdp: Cdp) -> dict | None:
    """视口中心点的屏幕物理坐标（滚轮前把光标放这儿，像人把鼠标移到内容上）。"""
    try:
        return cdp.evaluate("(() => {" + _VIEWPORT_CENTER_JS + "})()")
    except CdpError:
        return None


# ---------------- 点击 ----------------

def click_expr(cdp: Cdp, expr: str, settle=(0.4, 1.0)) -> dict:
    """点一个 DOM 元素。os 走真实鼠标（曲线移动 + 按压），cdp 走合成事件。"""
    if MODE == "cdp":
        from core import cdpinput as ui
        from xauto import typing as humanize
        info = ui.viewport_point(cdp, expr)
        if not info:
            return {"ok": False, "mode": "cdp", "state": "not-visible"}
        ok = humanize.click_like_human(cdp, info["x"], info["y"], settle=settle)
        return {"ok": ok, "mode": "cdp", "point": (info["x"], info["y"])}

    if not ensure_foreground(cdp):
        return {"ok": False, "mode": "os", "state": "no-foreground"}
    pt = screen_point(cdp, expr)
    if not pt:
        return {"ok": False, "mode": "os", "state": "not-found"}
    _sleep(0.12, 0.4)                      # 定位后先看一眼再点（人的反应时间）
    if not wi.click(pt["x"], pt["y"]):
        return {"ok": False, "mode": "os", "state": "sendinput-failed"}
    _sleep(*settle)
    return {"ok": True, "mode": "os", "point": (pt["x"], pt["y"]), "dpr": pt.get("dpr")}


# ---------------- 滚轮 ----------------

def scroll_wheel(cdp: Cdp, notches: int,
                 anchor_expr: str | None = None,
                 interval: tuple[float, float] = (0.06, 0.22)) -> dict:
    """用真实滚轮滚动。notches>0 向上，<0 向下。

    先把鼠标移到内容区（帖子正文或视口中心），再一格一格滚 —— 这样页面收到的
    就是标准 wheel 事件，和人手滚轮完全一致（不是 scrollTo/scrollBy 的跳变）。
    """
    if not ensure_foreground(cdp):
        return {"ok": False, "state": "no-foreground"}
    pt = None
    if anchor_expr:
        pt = screen_point(cdp, anchor_expr)
    if not pt:
        pt = viewport_center(cdp)
    if not pt:
        return {"ok": False, "state": "no-point"}
    wi.move_to(pt["x"], pt["y"])           # 像人一样先把鼠标挪到内容上
    _sleep(0.1, 0.3)
    wi.wheel(int(notches), interval=interval)
    return {"ok": True, "notches": int(notches), "point": (pt["x"], pt["y"])}


# ---------------- 输入 ----------------

def clear_field(cdp: Cdp) -> None:
    """清空当前焦点输入框（真实 Ctrl+A → Backspace）。"""
    ensure_foreground(cdp)
    wi.hotkey(wi.VK["ctrl"], wi.VK["a"])
    _sleep(0.12, 0.28)
    wi.press(wi.VK["backspace"])
    _sleep(0.2, 0.4)


def type_text(cdp: Cdp, text: str) -> str:
    """把文字打进当前焦点输入框。

    打字速度由行为设置 behavior.typing_ms 控制（每个字符多少毫秒，默认 150ms）。
    中文：剪贴板 Ctrl+V（真人写中文要么输入法上屏、要么粘贴，事件形态都等价）
    短 ASCII：逐字符 WM_CHAR（KEYEVENTF_UNICODE），一个字母一个字母敲
    """
    from xauto import behavior
    per_char_ms = max(10, int(behavior.get("typing_ms") or 150))

    if MODE == "cdp":
        from xauto import typing as humanize
        return humanize.type_like_human(cdp, text, per_char_ms=per_char_ms)

    if not ensure_foreground(cdp):
        return "failed(no-foreground)"
    try:
        if all(ord(c) < 128 for c in text) and len(text) <= 60:
            wi.type_unicode(text, cpm=max(20, int(60000 / per_char_ms)))
            return "os-unicode"
        pyperclip.copy(text)
        _sleep(0.2, 0.5)
        wi.hotkey(wi.VK["ctrl"], wi.VK["v"])
        _sleep(0.35, 0.8)
        return "os-paste"
    except Exception as e:
        return f"failed({e})"


def press_enter(cdp: Cdp) -> None:
    if MODE == "cdp":
        from core import cdpinput as ui
        ui.press_enter(cdp)
        return
    ensure_foreground(cdp)
    wi.press(wi.VK["enter"])


def press_key(cdp: Cdp, key: str) -> None:
    if MODE == "cdp":
        vk = {"Escape": 27, "Backspace": 8}.get(key, 0)
        base = {"key": key, "code": key, "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk}
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "rawKeyDown"})
        _sleep(0.05, 0.1)
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyUp", "text": ""})
        return
    ensure_foreground(cdp)
    wi.press(wi.VK.get(key.lower(), 0x1B))
