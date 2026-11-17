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
import sys
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

def _has_focus(cdp: Cdp) -> bool:
    try:
        return cdp.evaluate("document.hasFocus()") is True
    except CdpError:
        return False


def _browser_hwnds() -> list[tuple[int, str]]:
    """枚举可见的浏览器窗口：[(hwnd, title), ...]（msedge/chrome）。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    out: list[tuple[int, str]] = []

    def _proc_name(hwnd: int) -> str:
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = k.OpenProcess(0x1000, False, pid.value)     # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(1024)
            if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return buf.value.lower()
        finally:
            k.CloseHandle(h)
        return ""

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if not u.IsWindowVisible(hwnd):
            return True
        exe = _proc_name(hwnd)
        if not exe.endswith(("msedge.exe", "chrome.exe")):
            return True
        buf = ctypes.create_unicode_buffer(512)
        u.GetWindowTextW(hwnd, buf, 512)
        t = buf.value.strip()
        if t:
            out.append((hwnd, t))
        return True

    u.EnumWindows(cb, 0)
    return out


def _os_foreground_title() -> str:
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    hwnd = u.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(512)
    u.GetWindowTextW(hwnd, buf, 512)
    return buf.value.strip()


def ensure_foreground(cdp: Cdp) -> bool:
    """把**脚本所连的那个浏览器窗口**提到 OS 前台，并验证它真的是前台窗口。

    2026-11-17 两次踩坑（都表现为「点了没反应」）：
      ① 双实例时按 exe+标题找窗口，两个 Edge 标题一样 → 提到了错的窗口；
      ② 只用 `document.hasFocus()` 验收不够：某些情况下标签页自认为有焦点，
         但 OS 前台其实是别的程序（实测是我们自己的聊天窗口），
         于是真实鼠标全点在别处。所以这里以 **GetForegroundWindow** 为准。
    """
    title = ""
    try:
        title = cdp.title() or ""
    except CdpError:
        pass

    wins = _browser_hwnds()

    # 1) 按标题精确/包含匹配，直接激活那个窗口
    cands = [h for h, t in wins if title and (t == title or title in t or t in title)]
    if not cands:
        cands = [h for h, _ in wins]
    for hwnd in cands:
        try:
            if os_human._activate(hwnd):          # ShowWindow + 前台 + 校验
                if _os_foreground_title() == title or title in _os_foreground_title():
                    return True
        except Exception:
            continue

    # 2) 兜底：CDP 前置 + 再验收 OS 前台标题
    try:
        cdp.call("Page.bringToFront")
        time.sleep(0.35)
    except Exception:
        pass
    fg = _os_foreground_title()
    if title and (title in fg or fg in title):
        return True
    # 3) 最后再看页面自己是否认为有焦点（单窗口场景通常够）
    return _has_focus(cdp) and bool(title) and fg == title


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
return {
  vx: Math.round(window.innerWidth * 0.5),
  vy: Math.round(window.innerHeight * 0.45),
  dpr: dpr,
};
"""


def screen_point(cdp: Cdp, expr: str) -> dict | None:
    """视口坐标 → 屏幕物理像素。

    用「窗口原点绝对标定」换算：x = ox + vx*dpr，y = oy + vy*dpr。
    标定见 calibrate_window()：用左栏两个锚点互相验证，结果绝对保存、不累加。
    """
    try:
        raw = cdp.evaluate("(() => {" + (_SCREEN_JS % expr) + "})()")
    except CdpError:
        return None
    if not raw:
        return None
    off = calibrate_window(cdp)
    if not off:
        return None
    dpr = float(raw.get("dpr") or 1)
    raw["x"] = int(off[0] + raw["vx"] * dpr)
    raw["y"] = int(off[1] + raw["vy"] * dpr)
    raw["calib"] = off
    return raw


def viewport_center(cdp: Cdp) -> dict | None:
    """视口中心点的屏幕物理坐标（滚轮前把光标放这儿，像人把鼠标移到内容上）。"""
    try:
        raw = cdp.evaluate("(() => {" + _VIEWPORT_CENTER_JS + "})()")
    except CdpError:
        return None
    if not raw:
        return None
    off = calibrate_window(cdp)
    if not off:
        return None
    dpr = float(raw.get("dpr") or 1)
    raw["x"] = int(off[0] + raw["vx"] * dpr)
    raw["y"] = int(off[1] + raw["vy"] * dpr)
    raw["calib"] = off
    return raw


# ---------------- 坐标标定（每个窗口几何只做一次，绝对保存、不累加）----------------
#
# 踩坑记录（2026-11-17，用户反馈「鼠标一直偏移」）：
#   上一版每次点击前做局部搜索，并把修正量**累加**进偏移缓存。
#   hover 校验偶尔假阴性（悬停太快/高亮有延迟），修正被反复叠加 → 越点越偏。
# 现在的规矩：
#   1. 标定一次，结果绝对保存（ox, oy），不累加
#   2. 两个锚点（Home / Explore）互相验证，都命中才采用
#   3. 点击前只校验一次；不命中就重标定一次；仍不命中 → 放弃点击（绝不盲点）

_CALIB: dict[str, tuple[int, int]] = {}

# 锚点同时支持 data-testid 与 href：详情页 / 窄窗口下左栏会收起，testid 可能不存在
_CALIB_ANCHORS = (
    '[data-testid="AppTabBar_Home_Link"]',
    'a[href="/home"]',
    '[data-testid="AppTabBar_Explore_Link"]',
    'a[href="/explore"]',
    '[data-testid="AppTabBar_Notifications_Link"]',
    'a[href="/notifications"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="AppTabBar_Profile_Link"]',
)


def reset_calibration() -> None:
    _CALIB.clear()


def _hover_leaf(cdp: Cdp) -> str:
    try:
        # 返回整条悬停链上的所有 key（testid 与 href 都要），用 | 连接：
        # 目标是容器（如 User-Name）时，真正被悬停的是里面的 <a href="/handle">，
        # 只取「最近的第一个 key」会漏掉外层 testid，导致误判坐标不可信。
        return str(cdp.evaluate(
            "(() => {const hs=[...document.querySelectorAll(':hover')];"
            "const keys=[];"
            "for (const e of hs) { const k=e.getAttribute && (e.getAttribute('data-testid')||e.getAttribute('href'));"
            "  if (k && keys[keys.length-1]!==k) keys.push(k); }"
            "return keys.length ? keys.join('|') : '-';})()") or "-")
    except CdpError:
        return "-"


def _target_key(expr: str) -> str:
    """从 JS 表达式里抠出 data-testid / href，用于悬停比对。

    只对「简单选择器」可靠；像 `[...].find(c => ...)` 这种复合表达式，
    抠出来的 testid 往往不是真正被点的元素（实测会把 cellInnerDiv 当目标），
    这种情况下直接返回空 → 跳过悬停校验，避免误判「坐标不可信」。
    """
    import re
    if any(tok in expr for tok in (".find(", ".pop(", "[0]", "=>", "querySelectorAll(")):
        return ""
    m = (re.search(r'data-testid="([^"]+)"', expr)
         or re.search(r'href="([^"]+)"', expr)
         or re.search(r"data-testid='([^']+)'", expr))
    return m.group(1) if m else ""


def _hover_hits(cdp: Cdp, key: str, settle: float = 0.35) -> bool:
    if not key:
        return True
    time.sleep(settle)
    chain = _hover_leaf(cdp)
    if not chain or chain == "-":
        return False
    if key in chain:
        return True
    # href 型 key（"/home"）允许与链上的完整 href 精确相等
    return any(seg == key for seg in chain.split("|"))


def _scan_axis(cdp: Cdp, key: str, x0: int, y0: int, dx: int, dy: int,
               span: int, step: int) -> int | None:
    """沿一个方向找 key 的命中区间，返回区间中点（不是第一条命中线）。

    为什么要中点：元素有高度（导航行 ~50px），第一条命中是**上边缘**，
    拿边缘当中心会让偏移量系统性偏 ~20px —— 大元素看不出来，
    小元素（作者名链接 ~20px 高）直接点空。
    """
    first = None
    last = None
    t = -span
    while t <= span:
        wi.move_to(x0 + dx * t, y0 + dy * t)
        if _hover_hits(cdp, key, 0.22):
            if first is None:
                first = t
            last = t
        elif first is not None and t > last + step:
            break
        t += step
    if first is None:
        return None
    return (first + last) // 2


def _scan_hit(cdp: Cdp, key: str, base_x: int, base_y: int,
              span: int = 150, step: int = 10) -> tuple[int, int] | None:
    """先竖扫找 y 区间中点，再横扫找 x 区间中点，返回绝对屏幕坐标。"""
    my = _scan_axis(cdp, key, base_x, base_y, 0, 1, span, step)
    if my is None:
        return None
    mx = _scan_axis(cdp, key, base_x, base_y + my, 1, 0, span, step)
    if mx is None:
        mx = 0
    return base_x + mx, base_y + my


def _anchor_rect(cdp: Cdp, selector: str) -> dict | None:
    import json as _json
    try:
        return cdp.evaluate_json(
            "return (() => {"
            " const list = [...document.querySelectorAll(%s)];"
            " for (const e of list) {"
            "   const r = e.getBoundingClientRect();"
            "   if (r.width <= 0 || r.height <= 0) continue;"
            "   const key = e.getAttribute('data-testid') || (e.getAttribute('href') || '');"
            "   if (!key) continue;"
            "   return {vx: Math.round(r.left + r.width/2),"
            "           vy: Math.round(r.top + r.height/2), key: key};"
            " }"
            " return null; })()" % _json.dumps(selector))
    except CdpError:
        return None


def _seed_from_js(raw: dict, rc: dict) -> tuple[int, int]:
    dpr = float(raw.get("dpr") or 1)
    return int(raw["sx"] + rc["vx"] * dpr), int(raw["sy"] + rc["vy"] * dpr)


def _client_origin_of(title: str) -> tuple[int, int] | None:
    """按窗口标题找浏览器窗口，返回其客户区左上角的屏幕坐标（物理像素）。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    wins = _browser_hwnds()
    cands = [h for h, t in wins if title and (t == title or title in t or t in title)]
    if not cands:
        cands = [h for h, _ in wins]
    for hwnd in cands:
        pt = wintypes.POINT(0, 0)
        if u.ClientToScreen(hwnd, ctypes.byref(pt)):
            return int(pt.x), int(pt.y)
    return None


def bring_window_on_screen(title: str, x: int = 60, y: int = 40,
                           w: int = 1320, h: int = 900) -> bool:
    """把浏览器窗口挪回屏幕可见区域（被停到 -32000 时真实鼠标点不到，必须先拉回）。"""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    wins = _browser_hwnds()
    cands = [hw for hw, t in wins if title and (t == title or title in t or t in title)]
    if not cands:
        cands = [hw for hw, _ in wins]
    for hwnd in cands:
        r = wintypes.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(r))
        if r.left > -1000 and r.top > -1000 and r.right > 50 and r.bottom > 50:
            return True                                     # 已经在屏幕内
        u.ShowWindow(hwnd, 9)                               # SW_RESTORE
        u.SetWindowPos(hwnd, 0, x, y, w, h, 0x0040)          # SWP_SHOWWINDOW
        time.sleep(0.6)
        u.GetWindowRect(hwnd, ctypes.byref(r))
        if r.left > -1000 and r.top > -1000:
            return True
    return False


def calibrate_window(cdp: Cdp, force: bool = False) -> tuple[int, int] | None:
    """标定「视口坐标 → 屏幕坐标」的窗口原点偏移，返回 (ox, oy)。

    步骤：窗口拉回屏幕 → 取前台 → 用 Win32 客户区原点当种子 →
    在页面上能找到的锚点里挑 1~2 个用悬停扫描确认 → 结果绝对保存（不累加）。
    """
    try:
        raw = cdp.evaluate_json(
            "return {dpr: devicePixelRatio || 1, iw: innerWidth, ih: innerHeight,"
            " sx: screenX || 0, sy: screenY || 0};")
    except CdpError:
        return None
    if not raw:
        return None
    key = f"{raw['dpr']}|{raw['iw']}x{raw['ih']}|{raw['sx']},{raw['sy']}"
    if not force and key in _CALIB:
        return _CALIB[key]
    if MODE != "os":
        return (0, 0)

    title = ""
    try:
        title = cdp.title() or ""
    except CdpError:
        pass
    bring_window_on_screen(title)
    if not ensure_foreground(cdp):
        print("[!] 标定失败：拿不到浏览器前台窗口", file=sys.stderr)
        return None

    dpr = float(raw["dpr"])
    origin = _client_origin_of(title)

    def _unique(selector: str) -> dict | None:
        """只接受页面上**唯一**的可见匹配；同名 href 有多个（顶栏+左栏）会互相干扰。"""
        try:
            n = int(cdp.evaluate(
                "document.querySelectorAll(%s).length"
                % __import__("json").dumps(selector)) or 0)
        except CdpError:
            return None
        if n != 1:
            return None
        rc = _anchor_rect(cdp, selector)
        return rc if (rc and rc.get("key")) else None

    results: list[tuple[int, int]] = []
    used: list[str] = []
    for selector in _CALIB_ANCHORS:
        rc = _unique(selector)
        if not rc:
            continue
        if origin:
            seed_x = origin[0] + int(rc["vx"] * dpr)
            seed_y = origin[1] + int(rc["vy"] * dpr)
        else:
            seed_x, seed_y = _seed_from_js(raw, rc)
        hit = _scan_hit(cdp, str(rc["key"]), seed_x, seed_y, span=150, step=10)
        if hit:
            results.append((hit[0] - int(rc["vx"] * dpr), hit[1] - int(rc["vy"] * dpr)))
            used.append(str(rc["key"]))
            if len(results) >= 2:
                break

    if not results:
        print("[!] 标定失败：没有唯一可见锚点命中，坐标不可信", file=sys.stderr)
        return None
    if len(results) > 1:
        (ox0, oy0) = results[0]
        if any(abs(r[0] - ox0) > 12 or abs(r[1] - oy0) > 12 for r in results[1:]):
            print(f"[!] 标定结果不一致（已丢弃）：{results}", file=sys.stderr)
            results = results[:1]        # 只信第一个唯一锚点，不用坏数据
            used = used[:1]
    ox, oy = results[0]
    _CALIB[key] = (ox, oy)
    print(f"[i] 坐标已标定：ox={ox} oy={oy}（dpr={dpr}，锚点 {used}）", file=sys.stderr)
    return (ox, oy)


# ---------------- 点击 ----------------

def scroll_into_view(cdp: Cdp, expr: str, settle: float = 1.2) -> dict | None:
    """把元素滚进视口中部，等 X 的惯性滚动停下来，返回稳定后的视口矩形。

    为什么必须等：目标在视口外/边缘时，鼠标移过去会触发页面自动滚动，
    滚动过程中读到的坐标全是过渡值 —— 点下去就偏（实测偏 1200px）。
    """
    ok = cdp.evaluate(
        "(() => { const e = %s; if (!e) return false;"
        " e.scrollIntoView({block: 'center', behavior: 'instant'}); return true; })()" % expr)
    if not ok:
        return None
    time.sleep(0.45)
    last = None
    deadline = time.time() + settle
    while time.time() < deadline:
        rc = cdp.evaluate_json(
            "return (() => { const e = %s; if (!e) return null;"
            " const r = e.getBoundingClientRect();"
            " return {vx: Math.round(r.left + r.width/2),"
            "         vy: Math.round(r.top + r.height/2),"
            "         w: Math.round(r.width), h: Math.round(r.height)}; })()" % expr)
        if rc and last and rc.get("vx") == last.get("vx") and rc.get("vy") == last.get("vy"):
            return rc
        last = rc
        time.sleep(0.25)
    return last


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
    # 目标在视口外/边缘时先滚进视口中部并等滚动稳定（否则坐标是过渡值，必偏）
    _rc0 = cdp.evaluate_json(
        "return (() => { const e = %s; if (!e) return null;"
        " const r = e.getBoundingClientRect();"
        " if (r.width <= 0 || r.top < 8 || r.bottom > innerHeight - 8) return {need: true};"
        " return {need: false}; })()" % expr)
    if _rc0 is None:
        return {"ok": False, "mode": "os", "state": "not-found"}
    if _rc0.get("need"):
        scroll_into_view(cdp, expr)
    pt = screen_point(cdp, expr)
    # 点击前只校验一次：不命中就重新标定一次；仍不命中就放弃（绝不盲点）
    if pt:
        tkey = _target_key(expr)
        wi.move_to(int(pt["x"]), int(pt["y"]))
        if not _hover_hits(cdp, tkey):
            print(f"[i] 坐标未命中 {tkey}，重新标定…", file=sys.stderr)
            if calibrate_window(cdp, force=True):
                scroll_into_view(cdp, expr)
                pt = screen_point(cdp, expr)
            if pt:
                wi.move_to(int(pt["x"]), int(pt["y"]))
            if pt and not _hover_hits(cdp, tkey):
                print(f"[!] 重标定后仍不命中 {tkey}，放弃这次点击", file=sys.stderr)
                return {"ok": False, "mode": "os", "state": "coord-unreliable"}
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
        # 一律逐字符真实按键（含中文）：KEYEVENTF_UNICODE 每字发一次 WM_CHAR，
        # 间隔按 behavior.typing_ms（默认 130ms）。不再用剪贴板整段粘贴 —— 那样不是"打字"。
        wi.type_unicode(text, cpm=max(20, int(60000 / per_char_ms)))
        return "os-perchar"
    except Exception as e:
        return f"failed({e})"


def send_submit_shortcut(cdp: Cdp) -> None:
    """Ctrl+Enter 提交（X 原生快捷键）。os 走真实按键，cdp 走派发事件。"""
    if MODE == "cdp":
        base = {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13,
                "nativeVirtualKeyCode": 13, "modifiers": 2}
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "rawKeyDown"})
        _sleep(0.05, 0.12)
        cdp.call("Input.dispatchKeyEvent", {**base, "type": "keyUp", "text": ""})
        return
    ensure_foreground(cdp)
    wi.hotkey(wi.VK["ctrl"], wi.VK["enter"])


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
