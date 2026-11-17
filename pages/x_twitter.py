# ============ X / 推特 页面对象层 ============
# 架构约束（和 pages/zhipin.py 同一套铁律，别破）：
#   1. 读页面一律走 core.cdp.Cdp.evaluate —— 只 Runtime.evaluate，绝不 *.enable
#   2. 点击/输入走 core.cdpinput（CDP 派发事件）：不占真实鼠标、不抢前台
#      窗口必须「可见」（可被遮住，不能最小化），否则浏览器会丢弃输入事件
#   3. 编辑器是 contenteditable（Draft.js）：整段文本用 Input.insertText 注入
#   4. 一切写入都要「发前校验 + 发后取证」，不一致就中止，绝不盲发
#
# 三个已踩过的坑（别踩回去）：
#   ① [data-testid^="tweetTextarea_"] 前缀会命中 _label / _RichTextInputContainer 包裹层，
#      placeholder 就在 _label 里 —— 只按前缀取第一个，读回来永远是 "What's happening?"。
#      → 必须限定 div[contenteditable="true"]。
#   ② tweetButton 与 tweetButtonInline 会同时存在于 DOM（一个在弹层、一个在页内），
#      且可能都「有宽高」。按 querySelector 取第一个 = 赌运气。
#      → 用「离编辑器最近的祖先里那个按钮」定位（_submit_expr）。
#   ③ 首页本来就有一个内联发帖框。不先看它就去点左栏 Post，会多开一个弹层，
#      之后 editor 到底指哪个就变得不可控。→ open_composer 先复用已有可见编辑器。
from __future__ import annotations

import json
import os
import random
import time
from typing import Any

from xauto import bootstrap as _bootstrap  # noqa: F401  —— 先接好只读依赖路径
from core.cdp import Cdp, CdpError
from core import cdpinput as ui
from xauto import config, dom, typing as humanize
from xauto import input as xinput
from xauto.session import XSession

S = config.SEL


def _sleep(a: float, b: float):
    time.sleep(random.uniform(a, b))


def step_delay():
    _sleep(*config.STEP_DELAY)


class XPageError(RuntimeError):
    pass


class XPage:
    """一个 X 页面的可操作对象。所有方法都假设已 connect。"""

    def __init__(self, session: XSession | None = None):
        self.s = session or XSession()
        self.cdp: Cdp | None = None

    # ---------------- 生命周期 ----------------

    def __enter__(self) -> "XPage":
        self.cdp = self.s.connect()
        self.guard_account()
        return self

    def __exit__(self, *a):
        self.s.disconnect()
        return False

    def guard_account(self) -> None:
        """账号闸门（xauto/account.py）：窗口里登录的号 ≠ 本档位期望的号 → 抛 AccountMismatch。

        宁可不跑，也不把测试动作发到正式号上（或者反过来）。
        调试时想跳过：$env:XAUTO_NO_GATE=1（只在你知道自己在干什么的时候用）。
        """
        if os.environ.get("XAUTO_NO_GATE"):
            return
        from xauto import account
        account.require(self)

    # ---------------- 元素定位（统一口径）----------------

    @staticmethod
    def _pick_expr(base_sel: str, last: bool = True, need_visible: bool = True) -> str:
        """目标元素的 JS 表达式。last=True 取文档里最后一个。

        过滤条件的三条来历（2026-11-16 实测）：
          · 宽高 > 0    —— 隐藏/懒渲染节点留在 DOM 里，点它会命中 (0,0)
          · 高度 > 8px  —— 排除 1px 占位壳
          · 与视口相交  —— 只在「同一元素有多个拷贝」时用来挑对的那个

        但「与视口相交」不能当硬条件：详情页里主帖可能高达 1275px，
        操作栏（点赞 ❤️）和回复框都在视口外，硬要求可见就会误判成「没有按钮」。
        所以需要滚动才能操作的元素，用 need_visible=False，交给点击前 scrollIntoView。
        """
        cond = "r.width > 0 && r.height > 8"
        if need_visible:
            cond += " && r.bottom > 0 && r.top < (window.innerHeight || 1)"
        filt = (f"[...document.querySelectorAll({dom.js(base_sel)})]"
                ".filter(e => { const r = e.getBoundingClientRect();"
                f" return {cond}; }})")
        return filt + (".pop() || null" if last else "[0] || null")

    def eval(self, body: str) -> Any:
        assert self.cdp
        return self.cdp.evaluate("(() => {" + body + "})()")

    def count(self, selector: str) -> int:
        assert self.cdp
        return dom.count(self.cdp, selector)

    def exist(self, selector: str) -> bool:
        return self.eval(f"return !!({self._pick_expr(selector)});") is True

    def click(self, selector: str, settle=(0.4, 1.0), required: bool = True) -> bool:
        """点一个「可见的」元素：先验证命中，再拟人轨迹点击。

        命中验证（2026-11-16 踩坑）：X 的浮层关掉后偶尔留下透明 mask 覆盖全页，
        这时按钮 rect 正常、坐标也对，但 elementFromPoint 命中的是 mask，
        点了没反应 —— 表现为「发帖按钮被锁定」。所以点之前先做命中测试，
        不通过就先清浮层。
        """
        assert self.cdp
        expr = self._pick_expr(selector)
        info = ui.viewport_point(self.cdp, expr)
        if not info:
            if required:
                raise XPageError(f"要找的元素不存在或不可见：{selector}")
            return False
        if not self._hit_test(info["x"], info["y"], expr):
            cleared = self.dismiss_mask()
            if cleared not in ("none", "stuck"):
                _sleep(0.4, 0.9)
                info = ui.viewport_point(self.cdp, expr) or info
        ok = humanize.click_like_human(self.cdp, info["x"], info["y"], settle=settle)
        if not ok and required:
            raise XPageError(f"点击失败（被遮挡/不可见）：{selector}")
        return ok

    def _hit_test(self, x: float, y: float, expr: str) -> bool:
        """(x,y) 处最顶层的元素，是否就是目标元素本身或它的子孙。

        坑：别写成 `return` + 换行 + 后面的语句 —— JS 的自动分号插入会把它变成
        `return;`，函数恒定返回 undefined，于是「永远判定被遮挡」，
        还会连累后面的 rect 点击逻辑去反复清浮层。这里整段作为函数体传进去。
        """
        assert self.cdp
        js = (f"const t = {expr};"
              f"if (!t) return false;"
              f"const hit = document.elementFromPoint({int(x)}, {int(y)});"
              f"return !!hit && (hit === t || t.contains(hit));")
        return self.eval(js) is True

    def dismiss_mask(self) -> str:
        """清掉覆盖全页的透明 mask 浮层。返回处理动作，便于日志判断根因。

        三条路径按「侵入性从低到高」排：
          1. 点浮层自己的关闭按钮（最像人）
          2. 点遮罩本身（X 里点遮罩=关闭当前层）
          3. ESC
        都不行就报告 stuck，让调用方别硬点 —— 硬点只会把风控喂饱。
        """
        assert self.cdp
        mask = self._pick_expr('[data-testid="mask"]')
        if not self.eval(f"return !!({mask});"):
            return "none"

        close_expr = ("[...document.querySelectorAll("
                      "'[data-testid=\"app-bar-close\"], [aria-label=\"Close\"], [aria-label=\"关闭\"]')]"
                      ".filter(b => { const r = b.getBoundingClientRect();"
                      " return r.width > 8 && r.height > 8; }).pop() || null")
        if self.eval(f"return !!({close_expr});"):
            self._click_expr_human(close_expr, settle=(0.8, 1.5))
            if not self.eval(f"return !!({mask});"):
                return "close-button"

        info = ui.viewport_point(self.cdp, mask)
        if info and self.click_point(info["x"], info["y"], settle=(0.8, 1.5)):
            if not self.eval(f"return !!({mask});"):
                return "mask-click"

        self._key("Escape", "Escape", 27)
        _sleep(0.5, 1.0)
        if not self.eval(f"return !!({mask});"):
            return "esc"
        return "stuck"

    def click_point(self, x: float, y: float, settle=(0.4, 1.0)) -> bool:
        assert self.cdp
        return humanize.click_like_human(self.cdp, x, y, settle=settle)

    def _click_expr_human(self, expr: str, settle=(0.4, 1.0)) -> bool:
        """点一个元素。默认走真实 OS 鼠标（RPA），失败再退回 CDP 合成事件。

        为什么要分两档：OS 通道需要窗口在前台，偶尔会被别的窗口抢走；
        这时退回 CDP 至少能保证流程不卡死，但会在返回值里标注降级，便于统计。
        """
        assert self.cdp
        r = xinput.click_expr(self.cdp, expr, settle=settle)
        if r.get("ok"):
            return True
        if r.get("mode") == "os":                     # OS 没点成 → 记下来，再试 CDP
            self.input_fallbacks = getattr(self, "input_fallbacks", []) + [r.get("state")]
            info = ui.viewport_point(self.cdp, expr)
            if info:
                return humanize.click_like_human(self.cdp, info["x"], info["y"], settle=settle)
        return False

    def shot(self, name: str) -> str:
        assert self.cdp
        config.ensure_dirs()
        p = config.SHOT_DIR / f"{name}-{time.strftime('%H%M%S')}.png"
        self.cdp.screenshot(str(p))
        return str(p)

    # ---------------- 遮挡物清理 ----------------

    # X 会不定时弹这些浮层，盖住编辑器/按钮，导致点击落空：
    #   「Unlock more on X / Got it」——新号 graduated access 提示
    #   「开启通知」「看看新功能」之类的一次性提示
    DISMISS_TEXTS = ("Got it", "知道了", "明白", "Okay", "OK", "知道了。",
                     "Not now", "暂时不要", "关闭", "Dismiss")

    def dismiss_blockers(self, tries: int = 3) -> list[str]:
        """按掉挡在编辑器/按钮前面的浮层。返回按掉了哪些东西（便于日志）。"""
        assert self.cdp
        done: list[str] = []
        # 先处理「透明 mask 吃指针」这种最阴的情况
        m = self.dismiss_mask()
        if m not in ("none",):
            done.append(f"mask:{m}")
        for _ in range(max(1, tries)):
            expr = f"""(() => {{
              const texts = {json.dumps(list(self.DISMISS_TEXTS), ensure_ascii=False)};
              const nodes = [...document.querySelectorAll(
                  '[role="button"], [data-testid="app-bar-close"], [data-testid$="-close"]')]
                .filter(b => {{ const r = b.getBoundingClientRect();
                               return r.width > 8 && r.height > 8 &&
                                      r.bottom > 0 && r.top < innerHeight; }});
              const hit = nodes.find(b => texts.includes((b.innerText || '').trim()));
              return hit || null;
            }})()"""
            if not self.eval(f"return !!({expr});"):
                break
            label = self.eval(
                f"const b = {expr}; return b ? (b.innerText || b.getAttribute('aria-label') || '').trim() : '';")
            if not self._click_expr_human(expr, settle=(0.7, 1.4)):
                break
            done.append(label or "?")
            _sleep(0.5, 1.1)
        return done

    # ---------------- 登录 / 账号 ----------------

    def require_login(self) -> None:
        assert self.cdp
        if not self.s.is_logged_in():
            raise XPageError(
                f"当前实例（档位 {config.INSTANCE}，端口 {config.CDP_PORT}）没登录 X。"
                f"请在对应的浏览器窗口里登录一次（profile: {config.PROFILE_DIR}），然后重跑。")

    def whoami(self) -> dict:
        js = """
        const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        if (!btn) return null;
        const spans = [...btn.querySelectorAll('span')].map(s => (s.innerText || '').trim()).filter(Boolean);
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return {
          handle: link ? (link.getAttribute('href') || '').replace('/', '') : '',
          name: spans[0] || '',
          handle_text: spans.find(s => s.startsWith('@')) || '',
        };
        """
        return self.eval(js) or {}

    # ---------------- 编辑器通用 ----------------

    def editor_expr(self, selector: str | None = None, last: bool = True) -> str:
        """编辑器表达式：优先视口内的那个（避免拿到离屏副本），没有就退回任意一个。

        为什么要退而求其次：帖子详情页里回复框常在视口下方（主帖很长），
        硬要求「可见」会把「有回复框」误判成「作者不让回复」。
        """
        base = selector or S["editor"]
        visible = self._pick_expr(base, last=last, need_visible=True)
        any_one = self._pick_expr(base, last=last, need_visible=False)
        return f"(({visible}) || ({any_one}))"

    def has_editor(self, selector: str | None = None) -> bool:
        return self.eval(f"return !!({self.editor_expr(selector)});") is True

    def editor_text(self, selector: str | None = None) -> str:
        """读编辑器里的真实内容（已排除 Draft.js 的 placeholder 节点）。"""
        assert self.cdp
        expr = self.editor_expr(selector)
        js = f"""
        const el = {expr};
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.public-DraftEditorPlaceholder-root, [aria-hidden="true"]')
             .forEach(n => n.remove());
        return (clone.innerText || '').replace(/\\u00a0/g, ' ').trim();
        """
        return (self.eval(js) or "").strip()

    def _key(self, key: str, code: str, vk: int, modifiers: int = 0, raw: bool = True):
        """派发一次真实键盘事件（raw=True 走 rawKeyDown，组合键必须这样发）。"""
        assert self.cdp
        base = {"key": key, "code": code, "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk, "modifiers": modifiers}
        self.cdp.call("Input.dispatchKeyEvent",
                      {**base, "type": "rawKeyDown" if raw else "keyDown"})
        _sleep(0.04, 0.10)
        self.cdp.call("Input.dispatchKeyEvent",
                      {**base, "type": "keyUp", "text": ""})

    def clear_editor(self, selector: str | None = None, tries: int = 3) -> bool:
        """清空编辑器。返回是否真的空了。

        为什么不只用 execCommand('delete')：Draft.js（X 的编辑器）自己维护一份
        EditorState，DOM 选区删除偶尔会留下零散文本节点（实测残留一个 emoji）。
        Ctrl+A → Backspace 是走浏览器原生编辑命令，Draft.js 的 beforeinput 能收到，
        状态跟着一起清，残留率明显低。两条路径叠加 + 读回校验才敢往下走。
        """
        assert self.cdp
        expr = self.editor_expr(selector)
        for i in range(max(1, tries)):
            if not self.eval(f"const el = {expr}; if (!el) return false; el.focus(); return true;"):
                return False
            _sleep(0.15, 0.3)
            if not self.editor_text(selector):
                return True
            # 路径 A（os 通道）：真实 Ctrl+A → Backspace
            if xinput.MODE == "os":
                xinput.clear_field(self.cdp)
                _sleep(0.25, 0.5)
                if not self.editor_text(selector):
                    return True
            # 路径 B：CDP 原生全选 + 删除
            self._key("a", "KeyA", 65, modifiers=2)      # Ctrl+A
            _sleep(0.1, 0.25)
            self._key("Backspace", "Backspace", 8)
            _sleep(0.2, 0.4)
            if not self.editor_text(selector):
                return True
            # 路径 C：DOM 选区 + execCommand
            self.eval(f"""
            const el = {expr};
            const r = document.createRange(); r.selectNodeContents(el);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
            document.execCommand('delete', false, null);
            return true;
            """)
            _sleep(0.2, 0.4)
            if not self.editor_text(selector):
                return True
        return not self.editor_text(selector)

    def fill_editor(self, text: str, selector: str | None = None) -> str:
        """写进编辑器并读回校验。返回读回的内容（调用方负责比对）。

        输入通道由 xauto/input.py 决定：
          · os  —— 真实键盘：中文走剪贴板粘贴（等价输入法上屏），短英文逐字打
          · cdp —— IME 分块提交 + 逐字按键（不占真实键盘）
        """
        assert self.cdp
        if not self.clear_editor(selector):
            raise XPageError("编辑器清不干净（残留草稿），宁可不发 —— 先手动清一下")
        expr = self.editor_expr(selector)
        self.eval(f"const el = {expr}; if (el) el.focus(); return true;")
        _sleep(0.35, 0.9)                       # 点开编辑器后先「想一下」
        mode = xinput.type_text(self.cdp, text)
        if str(mode).startswith("failed"):
            raise XPageError(f"输入失败（{mode}）")
        self.last_typing_mode = mode
        _sleep(0.6, 1.6)                        # 打完看一眼再提交
        return self.editor_text(selector)

    # ---------------- 提交按钮（就近祖先定位）----------------

    def _submit_expr(self, selector: str | None = None) -> str:
        """离当前编辑器最近的、可见的提交按钮。

        从编辑器往上爬祖先，第一个「包含可见提交按钮」的祖先里就取它：
        页内输入框 → tweetButtonInline；弹层 → tweetButton。不会跨到另一处去。
        """
        ed = self.editor_expr(selector)
        return f"""(() => {{
          const ed = {ed};
          if (!ed) return null;
          let node = ed;
          while (node && node !== document.body) {{
            const btns = [...node.querySelectorAll({dom.js(S["submit"])})]
              .filter(b => {{ const r = b.getBoundingClientRect();
                              return r.width > 0 && r.height > 0; }});
            if (btns.length) return btns[btns.length - 1];
            node = node.parentElement;
          }}
          return null;
        }})()"""

    def submit_state(self, selector: str | None = None) -> dict:
        js = f"""
        const b = {self._submit_expr(selector)};
        if (!b) return {{found: false}};
        const r = b.getBoundingClientRect();
        return {{
          found: true,
          testid: b.getAttribute('data-testid'),
          aria_disabled: b.getAttribute('aria-disabled'),
          disabled: b.disabled === true,
          text: (b.innerText || '').replace(/\\s+/g, ' ').trim(),
          x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width), h: Math.round(r.height),
        }};
        """
        return self.eval(js) or {"found": False}

    def _wait_enabled(self, selector: str | None = None, timeout: float = 10.0) -> bool:
        assert self.cdp
        deadline = time.time() + timeout
        while time.time() < deadline:
            st = self.submit_state(selector)
            if st.get("found") and st.get("aria_disabled") != "true" and not st.get("disabled"):
                _sleep(0.25, 0.6)
                return True
            time.sleep(0.4)
        return False

    def _click_submit(self, selector: str | None = None) -> bool:
        """点提交按钮：先把按钮滚进视口，再按拟人轨迹点。

        不能直接用 submit_state 里的坐标 —— 详情页回复框在视口下方时，
        那对坐标是「屏幕外」的，点下去会落空。
        """
        assert self.cdp
        expr = self._submit_expr(selector)
        if not self.eval(f"return !!({expr});"):
            return False
        return self._click_expr_human(expr, settle=(0.6, 1.2))

    def wait_toast(self, timeout: float = 6.0) -> str:
        """X 发送成功后会弹一条提示（role=alert）。拿不到不算失败，只是没取证。"""
        assert self.cdp
        deadline = time.time() + timeout
        while time.time() < deadline:
            t = self.eval(
                "const el = document.querySelector('[role=\"alert\"], "
                "[data-testid=\"toast\"]');"
                "if (!el) return ''; return (el.innerText || '').replace(/\\s+/g,' ').trim();")
            if t:
                return t
            time.sleep(0.4)
        return ""

    # ---------------- 发帖（功能①）----------------

    def open_composer(self, timeout: float = 12.0) -> bool:
        """准备一个可用的发帖编辑器。

        顺序：已有可见编辑器（首页内联框直接复用）→ 点左栏发帖 → 快捷键 n。
        """
        assert self.cdp
        if self.has_editor():
            return True
        if self.count(S["nav_post"]):
            try:
                self.click(S["nav_post"])
            except XPageError:
                pass
            if dom.wait_js(self.cdp, f"({self.editor_expr()} || 0) !== 0",
                           timeout=6.0):
                return True
        # 兜底：键盘 n（X 内置快捷键）
        self.cdp.evaluate("document.body.focus();")
        key = {"key": "n", "code": "KeyN", "text": "n",
               "windowsVirtualKeyCode": 78, "nativeVirtualKeyCode": 78}
        self.cdp.call("Input.dispatchKeyEvent", {**key, "type": "keyDown"})
        _sleep(0.05, 0.12)
        self.cdp.call("Input.dispatchKeyEvent", {**key, "type": "keyUp", "text": ""})
        return dom.wait_js(self.cdp, f"({self.editor_expr()} || 0) !== 0", timeout=timeout)

    def post(self, text: str, dry_run: bool = False) -> dict:
        """发一条帖子。返回 {ok, posted, typed, toast, shots, error}。

        dry_run=True：只填不点，用来确认选择器和编辑器都通（默认行为）。
        """
        assert self.cdp
        self.require_login()
        text = (text or "").strip()
        if not text:
            raise XPageError("正文是空的")
        if len(text) > 280:
            raise XPageError(f"正文 {len(text)} 字，超过 X 单条 280 上限")

        out: dict = {"ok": False, "posted": False, "text": text, "shots": []}
        out["dismissed"] = self.dismiss_blockers()
        if not self.open_composer():
            raise XPageError("打不开发帖编辑器（页内框、左栏按钮、快捷键 n 都失败）")

        typed = self.fill_editor(text)
        out["typed"] = typed
        out["typing_mode"] = getattr(self, "last_typing_mode", "")
        out["shots"].append(self.shot("1-composer-filled"))
        if _norm(typed) != _norm(text):
            out["error"] = f"编辑器内容与预期不一致：读回 {typed[:60]!r}"
            return out

        if dry_run:
            out["ok"] = True
            out["dry_run"] = True
            out["button"] = self.submit_state()
            try:
                self.clear_editor()          # dry-run 不留草稿（否则下次打开就带着）
            except Exception:
                pass
            return out

        if not self._wait_enabled():
            out["error"] = "提交按钮一直不可用"
            out["button"] = self.submit_state()
            return out

        _sleep(1.8, 4.2)          # 提交前停一下：真人写完会扫一眼再点
        res = self._submit_and_confirm(text)
        out.update(res)
        out["shots"].extend(res.get("shots", []))
        out["posted"] = bool(res.get("cleared") or res.get("toast"))
        out["ok"] = out["posted"]
        if not out["ok"]:
            out.setdefault("error", "点了提交但没有任何成功证据（没 toast、编辑器没清空）")
        return out

    # ---------------- 提交 + 取证（发帖/回复共用）----------------

    def _editor_cleared(self, selector: str | None = None) -> bool:
        """编辑器是否已被清空/关闭 —— 这是「X 接受了这条内容」最硬的证据。"""
        assert self.cdp
        expr = self.editor_expr(selector)
        return self.eval(
            f"const el = {expr};"
            f"if (!el) return true;"
            f"return ((el.innerText || '').trim() === '');") is True

    def _submit_and_confirm(self, text: str, selector: str | None = None,
                            confirm: float = 15.0) -> dict:
        """点提交并等证据；只有在「能证明没发出去」时才允许重试一次。

        为什么不无条件重试：发帖是不可撤回动作。点了没证据有两种可能——
          (a) 真没发出去（遮罩吞了点击 / 按钮没响应）
          (b) 发出去了，只是 toast 没来得及抓、编辑器清空慢
        只有「编辑器里我们那段文字还在」才能排除 (b)，此时重试才安全。
        拿不到这个证据就停手报告 unknown，宁可让人看一眼截图，也不冒双发的险。
        """
        assert self.cdp
        res: dict = {"cleared": False, "toast": "", "clicked": 0, "shots": []}
        norm = _norm(text)

        for attempt in (1, 2):
            # 每次点击前：先把按钮滚进视口，再做命中测试（遮罩随时可能冒出来）
            sub_expr = self._submit_expr(selector)
            if not self.eval(f"return !!({sub_expr});"):
                res["error"] = "找不到提交按钮"
                return res
            self._scroll_into_view(sub_expr)
            st = self.submit_state(selector)
            if not st.get("found"):
                res["error"] = "找不到提交按钮"
                return res
            if not self._hit_test(st["x"], st["y"], sub_expr):
                cleared = self.dismiss_mask()
                res.setdefault("mask_handled", []).append(f"{attempt}:{cleared}")
                if cleared == "stuck":
                    res["error"] = "提交按钮被遮罩挡住且清不掉"
                    return res
                st = self.submit_state(selector)
                if not st.get("found"):
                    res["error"] = "清完浮层后提交按钮不见了"
                    return res

            self._click_submit(selector)
            res["clicked"] = attempt
            res["shots"].append(self.shot(f"submit-{attempt}"))

            deadline = time.time() + confirm
            while time.time() < deadline:
                toast = self.wait_toast(timeout=0.8)
                if toast:
                    res["toast"] = toast
                if self._editor_cleared(selector):
                    res["cleared"] = True
                    break
                time.sleep(0.5)

            if res["cleared"] or res["toast"]:
                return res

            # 没有成功证据：先确认「文字还在编辑器里」，确认不了就不重试
            still = _norm(self.editor_text(selector))
            res["text_still_there"] = bool(still)
            if still != norm:
                res["error"] = "点了提交但既无证据、正文也变了 —— 状态不确定，停止重试"
                res["shots"].append(self.shot("submit-unknown"))
                return res
            if attempt == 1:
                res["shots"].append(self.shot("submit-retry"))
                _sleep(2.0, 3.5)
        res.setdefault("error", "两次点击都没有成功证据")
        return res

    # ---------------- 自检：全链路走到「提交前一步」就停 ----------------

    def close_composer(self) -> str:
        """关掉发帖弹层（不发布）。返回关掉它的方式。"""
        assert self.cdp
        close_expr = ("[...document.querySelectorAll("
                      "'[data-testid=\"app-bar-close\"], [aria-label=\"Close\"], [aria-label=\"关闭\"]')]"
                      ".filter(b => { const r = b.getBoundingClientRect();"
                      " return r.width > 8 && r.height > 8; }).pop() || null")
        if self.eval(f"return !!({close_expr});"):
            self._click_expr_human(close_expr, settle=(0.9, 1.6))
            _sleep(0.6, 1.2)
            if not self.count(S["editor"]) or self.editor_text() == "":
                return "close-button"
        self._key("Escape", "Escape", 27)
        _sleep(0.6, 1.2)
        return "esc"

    def selftest(self, text: str = "自检：这条不会发出去") -> dict:
        """把发帖链路完整跑一遍，但**不点提交**。

        检查项：能不能打开编辑器、输入是否逐字落对、按钮是否可用、按钮是否真的能点中。
        跑完清空草稿并关掉弹层，不留垃圾。
        """
        assert self.cdp
        self.require_login()
        out: dict = {"ok": False, "text": text, "steps": {}, "shots": []}
        out["dismissed"] = self.dismiss_blockers()

        opened = self.open_composer()
        out["steps"]["open_composer"] = opened
        if not opened:
            out["error"] = "编辑器打不开"
            out["shots"].append(self.shot("selftest-no-composer"))
            return out

        typed = self.fill_editor(text)
        out["typed"] = typed
        out["typing_mode"] = getattr(self, "last_typing_mode", "")
        out["steps"]["text_match"] = _norm(typed) == _norm(text)
        out["shots"].append(self.shot("selftest-filled"))

        st = self.submit_state()
        out["button"] = st
        out["steps"]["button_enabled"] = bool(
            st.get("found") and st.get("aria_disabled") != "true" and not st.get("disabled"))
        if st.get("found"):
            out["steps"]["button_hittable"] = self._hit_test(
                st["x"], st["y"], self._submit_expr())
        else:
            out["steps"]["button_hittable"] = False

        # 清理：清草稿 + 关弹层
        out["steps"]["cleared"] = self.clear_editor()
        out["closed"] = self.close_composer()
        out["ok"] = all(out["steps"].get(k) for k in
                        ("open_composer", "text_match", "button_enabled", "button_hittable"))
        if not out["ok"]:
            out["error"] = "；".join(f"{k}=False" for k, v in out["steps"].items() if v is False)
        return out

    # ---------------- 首页浏览 / 点赞（功能④）----------------
    #
    # 铁律（用户要求）：不许用 location 跳转 / history.back / 输入网址来换页。
    # 所有位置变化都必须来自「点界面元素」：左栏 Home、帖子正文、详情页返回箭头。
    # 滚动也必须是滚轮事件（SendInput WHEEL），不是 scrollBy 那种跳变。

    def on_home(self) -> bool:
        """真的在首页吗。只认 URL 路径 —— 详情页也有 article，用条数判断会误判。"""
        assert self.cdp
        try:
            return self.cdp.evaluate("location.pathname === '/home'") is True
        except CdpError:
            return False

    def go_home(self, wait: float = 1.5, tries: int = 3) -> bool:
        """回首页：只点左栏 Home，并用 URL 路径验证。

        踩坑记录（2026-11-16）：旧版用「页面里有没有 article」当成功条件，
        可详情页也有 article，于是点进帖子后再 go_home 会假成功 ——
        人还留在详情页，接着滚动自然「划不动」，返回也只退了一层。
        """
        assert self.cdp
        if self.on_home() and self.count(S["tweet"]) > 0:
            return True
        for _ in range(max(1, tries)):
            expr = self._pick_expr('[data-testid="AppTabBar_Home_Link"]')
            if self.eval(f"return !!({expr});"):
                self._click_expr_human(expr, settle=(0.5, 1.1))
                time.sleep(wait)
                if self.on_home():
                    dom.wait_js(self.cdp,
                                "document.querySelectorAll('article[data-testid=\"tweet\"]').length > 0",
                                timeout=10.0)
                    return True
            _sleep(0.6, 1.2)
        return self.on_home()

    def ensure_home(self, tries: int = 4) -> bool:
        """不管当前在第几层详情页，都用「点左栏 Home」回到首页。

        详情页可以嵌套（帖子里的引用帖还能再点进去），所以返回箭头一次不一定够；
        左栏 Home 是唯一稳定的回首页入口。
        """
        assert self.cdp
        for _ in range(max(1, tries)):
            if self.on_home():
                return True
            if self.go_home():
                return True
            _sleep(0.8, 1.6)
        return self.on_home()

    def browse_scroll(self, times: int = 1, direction: str = "down") -> int:
        """像人一样滚轮往下刷：格数随机、间隔随机，偶尔停下来多看一眼。

        一次「刷屏」= 4~9 格滚轮（每格 3 行左右，约 300~700px），
        比之前 window.scrollBy(600~1400) 更接近真实手感 —— 真实滚轮是连续小步。
        """
        assert self.cdp
        for _ in range(max(1, times)):
            notches = random.randint(4, 9)
            if direction == "up":
                notches = -notches
            # 人不会一口气滚到底：一次「刷」里滚 1~3 段，段间停一下
            for _ in range(random.randint(1, 3)):
                xinput.scroll_wheel(self.cdp, -notches if direction == "down" else notches,
                                    interval=(0.05, 0.16))
                _sleep(0.15, 0.6)
            _sleep(*config.BROWSE_SCROLL_DELAY)
            if random.random() < 0.35:            # 偶尔停在半路「看一会儿」
                _sleep(*config.BROWSE_SKIM_PAUSE)
        return times

    def _scoped_expr(self, scope_js: str, sel: str, last: bool = False) -> str:
        """在某段作用域（求值为元素）里找目标元素，避免点到别的帖子的按钮上。

        不做「与视口相交」过滤：主帖很长时操作栏在视口外，滚动交给点击前处理。
        """
        filt = (f"[...({scope_js}).querySelectorAll({dom.js(sel)})]"
                ".filter(e => { const r = e.getBoundingClientRect();"
                " return r.width > 0 && r.height > 8; })")
        return filt + (".pop() || null" if last else "[0] || null")

    def _scroll_into_view(self, scope_expr: str) -> bool:
        """把作用域元素滚到视口里（顶部对齐）。

        为什么必须有这一步：从刷过低的信息流点进详情页时，SPA 会保留之前的滚动位置，
        主帖被顶到屏幕上方（实测 like 按钮 top=-1461、回复框 top=-2312）。
        这时「可见元素」筛选一个都命中不了，表现就是「没有点赞按钮 / 没有回复框」。
        """
        assert self.cdp
        ok = self.eval(
            f"const a = {scope_expr};"
            f"if (!a) return false;"
            f"a.scrollIntoView({{block: 'start', inline: 'nearest'}});"
            f"return true;") is True
        if ok:
            _sleep(0.4, 0.9)
        return ok

    def open_tweet_by_click(self, href: str, wait: float = 2.5) -> bool:
        """点进帖子详情：只点界面元素，不做任何 URL 跳转。

        两条真人路径，按顺序试：
          1. 点正文（tweetText）—— 最常见
          2. 点时间戳链接（那条帖子的 <time> 所在的 a）—— 正文被图片/引用占满时用
        """
        assert self.cdp
        status_id = href.rstrip("/").split("/")[-1]
        art = self.article_expr(href)
        if not self.eval(f"return !!({art});"):
            return False

        candidates = [
            f"({art}).querySelector('[data-testid=\"tweetText\"]')",
            f"({art}).querySelector('a[href*=\"/status/{status_id}\"] time')",
            f"({art}).querySelector('[data-testid=\"User-Name\"]')",
        ]
        for expr in candidates:
            if not self.eval(f"return !!({expr});"):
                continue
            self._click_expr_human(expr, settle=(0.8, 1.5))
            if dom.wait_js(self.cdp, f"location.pathname.includes({dom.js(status_id)})",
                           timeout=8.0):
                time.sleep(wait)
                rendered = dom.wait_js(
                    self.cdp,
                    "document.querySelectorAll('article[data-testid=\"tweet\"]').length > 0",
                    timeout=12.0)
                if rendered:
                    self._scroll_into_view(self.main_article_expr())
                return rendered
        return False

    def main_article_expr(self) -> str:
        """详情页里「主帖」那一篇（第一条 article），点赞/回复都以它为作用域。"""
        return "document.querySelectorAll('article[data-testid=\"tweet\"]')[0]"

    def article_expr(self, href: str) -> str:
        """在时间线里按帖子链接定位那一篇 article（首页/列表页用）。"""
        return f"""(() => {{
          const art = [...document.querySelectorAll('article[data-testid="tweet"]')]
            .find(a => [...a.querySelectorAll('a[href*="/status/"]')]
              .some(x => (x.getAttribute('href') || '').startsWith({dom.js(href)})));
          return art || null;
        }})()"""

    def _like_in_scope(self, scope_expr: str, timeout: float = 10.0) -> dict:
        """在给定作用域里点赞（作用域可以是详情页主帖，也可以是时间线里的某一条）。"""
        assert self.cdp
        out: dict = {"ok": False, "already": False}
        self._scroll_into_view(scope_expr)          # 先保证能看见，才谈得上点

        liked_expr = self._scoped_expr(scope_expr, '[data-testid="unlike"]')
        if self.eval(f"return !!({liked_expr});"):
            out["already"] = True
            out["ok"] = True
            out["state"] = "already-liked"
            return out

        like_expr = self._scoped_expr(scope_expr, '[data-testid="like"]')
        if not self.eval(f"return !!({like_expr});"):
            out["state"] = "no-like-button"
            return out

        info = ui.viewport_point(self.cdp, like_expr)
        if not info:
            out["state"] = "not-visible"
            return out
        if not self._hit_test(info["x"], info["y"], like_expr):
            cleared = self.dismiss_mask()
            out["mask_handled"] = cleared
            if cleared == "stuck":
                out["state"] = "blocked"
                return out
        out["clicked"] = self._click_expr_human(like_expr, settle=(0.5, 1.1))

        ok = dom.wait_js(self.cdp, f"!!({liked_expr})", timeout=timeout)
        out["ok"] = ok
        out["state"] = "liked" if ok else "unknown"
        return out

    def like(self, timeout: float = 10.0) -> dict:
        """给当前打开的详情页主帖点赞。"""
        assert self.cdp
        return self._like_in_scope(self.main_article_expr(), timeout=timeout)

    def like_in_timeline(self, href: str, timeout: float = 10.0) -> dict:
        """在首页信息流里直接给某条帖子点赞（不点进去）。"""
        assert self.cdp
        scope = self.article_expr(href)
        if not self.eval(f"return !!({scope});"):
            self.browse_scroll(1)                 # 可能已经滚出视口，补刷一屏再试
            if not self.eval(f"return !!({scope});"):
                return {"ok": False, "state": "article-not-found"}
        return self._like_in_scope(scope, timeout=timeout)

    def bookmark(self, timeout: float = 10.0) -> dict:
        """收藏当前详情页主帖（SOP 第 6 节：留给以后用得上的内容）。"""
        assert self.cdp
        scope = self.main_article_expr()
        self._scroll_into_view(scope)
        done_expr = self._scoped_expr(scope, '[data-testid="removeBookmark"]')
        if self.eval(f"return !!({done_expr});"):
            return {"ok": True, "already": True, "state": "already-bookmarked"}
        btn = self._scoped_expr(scope, '[data-testid="bookmark"]')
        if not self.eval(f"return !!({btn});"):
            return {"ok": False, "state": "no-bookmark-button"}
        ok = self._click_expr_human(btn, settle=(0.5, 1.1))
        saved = dom.wait_js(self.cdp, f"!!({done_expr})", timeout=timeout)
        return {"ok": bool(saved), "clicked": ok,
                "state": "bookmarked" if saved else "unknown"}

    def go_back(self, wait: float = 1.5) -> bool:
        """从详情页退一层：点左上角返回箭头；退不干净就用左栏 Home 兜底。

        判定同样只认 URL（不再用 article 条数）：
        详情页里也有关联帖，条数判断会把「还在详情页」误判成「已回到首页」。
        """
        assert self.cdp
        back = self._pick_expr('[data-testid="app-bar-back"], [aria-label="Back"], [aria-label="返回"]')
        if self.eval(f"return !!({back});"):
            self._click_expr_human(back, settle=(0.5, 1.1))
            time.sleep(wait)
            try:
                path = self.cdp.evaluate("location.pathname") or ""
            except CdpError:
                path = ""
            if "/status/" not in path:
                return True
        return self.ensure_home()

    # ---------------- 读帖子（功能②）----------------

    READ_TWEETS_JS = """
    const n = %d;
    const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const seen = new Set();
    const out = [];
    for (const a of arts) {
      if (out.length >= n) break;
      const tx = a.querySelector('[data-testid="tweetText"]');
      const link = a.querySelector('a[href*="/status/"]');
      let href = link ? link.getAttribute('href') : '';
      if (!href) continue;
      const id = (href.match(/\\/status\\/(\\d+)/) || [])[1] || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const userBlock = a.querySelector('[data-testid="User-Name"]');
      // handle 只能从「形如 /username」的链接里取：搜索结果里 User-Name 下还有一个
      // 指向 /user/status/id 的时间链接，按「取最后一个」会拿到 "abc/status/123" 这种脏值。
      const handleLinks = [...a.querySelectorAll('[data-testid="User-Name"] a[role="link"]')]
        .map(x => x.getAttribute('href') || '')
        .filter(h => h.startsWith('/') && !h.slice(1).includes('/'));
      const handle = (handleLinks[0] || '').replace('/', '');
      const tm = a.querySelector('time');
      out.push({
        id: id,
        href: href.split('?')[0].replace(/\\/photo\\/\\d+$/, ''),
        author: clean(userBlock && userBlock.innerText).slice(0, 90),
        handle: handle,
        text: clean(tx && tx.innerText).slice(0, 400),
        at: tm ? tm.getAttribute('datetime') : '',
        social: clean((a.querySelector('[data-testid="socialContext"]') || {}).innerText).slice(0, 40),
        reply_btn: !!a.querySelector('[data-testid="reply"]'),
      });
    }
    return out;
    """

    def wait_tweets(self, timeout: float = 30.0, minimum: int = 1) -> list[dict]:
        """等时间线把帖子渲染出来。

        新号会被 X 限速：页面框架先出来，"正在加载"的转圈要等好几秒甚至更久。
        所以读帖前必须轮询等渲染，不能读一次空列表就判定「没有了」。
        """
        assert self.cdp
        deadline = time.time() + timeout
        last: list[dict] = []
        while time.time() < deadline:
            last = self.read_tweets(limit=20)
            if len(last) >= minimum:
                return last
            time.sleep(1.5)
        return last

    def read_tweets(self, limit: int = 10, scroll_times: int = 0) -> list[dict]:
        """抽当前页可见的帖子（时间线 / 搜索结果 / 详情页都适用）。

        需要往下看就滚滚轮（scroll_times），不使用 window.scrollBy 那种跳变。
        """
        assert self.cdp
        if scroll_times:
            self.browse_scroll(scroll_times)
        return self.eval(self.READ_TWEETS_JS % max(1, limit)) or []

    def open_tweet(self, href: str, wait: float = 2.5) -> bool:
        """打开帖子详情：只走「点时间线里的帖子」，不输入网址、不做 location 跳转。

        找不到就返回 False（调用方换一条帖子），绝不用 URL 绕过 —— 这是硬要求。
        """
        assert self.cdp
        if href.startswith("http"):
            href = "/" + href.split("/", 3)[-1]
        for _ in range(3):                          # 允许滚动找一下
            if self.open_tweet_by_click(href, wait=wait):
                return dom.wait_js(self.cdp, f"({self.editor_expr()} || 0) !== 0",
                                   timeout=10.0)
            self.browse_scroll(1)
        return False

    def _ensure_editor_visible(self, selector: str | None = None) -> bool:
        """确保编辑器在视口里。不在就滚过去 —— 而不是直接判定「没有回复框」。"""
        assert self.cdp
        if self.has_editor(selector):
            return True
        any_expr = (f"[...document.querySelectorAll({dom.js(selector or S['editor'])})]"
                    ".pop() || null")
        if not self.eval(f"return !!({any_expr});"):
            return False
        self._scroll_into_view(any_expr)
        return self.has_editor(selector)

    def reply_available(self) -> dict:
        """这篇帖子能不能回：有没有回复框 + 是否被作者限制了回复。"""
        assert self.cdp
        return self.eval(f"""
        const ed = {self.editor_expr()};
        const body = document.body.innerText || '';
        return {{
          has_editor: !!ed,
          restricted_hint: /谁可以回复|Who can reply/.test(body),
        }};
        """) or {"has_editor": False}

    def reply_current(self, text: str, dry_run: bool = False) -> dict:
        """在当前已打开的帖子详情页里回复（不再跳转，用于「点进去→评论」流程）。"""
        assert self.cdp
        self.require_login()
        text = (text or "").strip()
        if not text:
            raise XPageError("回复正文是空的")
        if len(text) > 280:
            raise XPageError(f"回复 {len(text)} 字，超过 280 上限")

        out: dict = {"ok": False, "posted": False, "text": text,
                     "href": self.cdp.url(), "shots": []}
        self._scroll_into_view(self.main_article_expr())     # 回复框滚进视口
        st = self.reply_available()
        if not st.get("has_editor"):
            self.dismiss_blockers()
            st = self.reply_available()
        out["reply_available"] = st
        if not st.get("has_editor"):
            out["error"] = "没有可用的回复框（作者限制回复，或页面结构变了）"
            out["shots"].append(self.shot("reply-no-editor"))
            return out

        typed = self.fill_editor(text)
        out["typed"] = typed
        out["typing_mode"] = getattr(self, "last_typing_mode", "")
        out["shots"].append(self.shot("1-reply-filled"))
        if _norm(typed) != _norm(text):
            out["error"] = f"回复框内容与预期不一致：读回 {typed[:60]!r}"
            return out

        if dry_run:
            out["ok"] = True
            out["dry_run"] = True
            out["button"] = self.submit_state()
            self.clear_editor()                 # 别留下草稿
            return out

        if not self._wait_enabled():
            out["error"] = "回复按钮一直不可用"
            out["button"] = self.submit_state()
            return out

        before = self.count(S["tweet"])
        _sleep(1.5, 3.5)                        # 写完扫一眼再点
        res = self._submit_and_confirm(text)
        out.update(res)
        out["shots"].extend(res.get("shots", []))
        out["tweets_before"] = before
        out["tweets_after"] = self.count(S["tweet"])
        out["posted"] = bool(res.get("cleared") or res.get("toast")
                            or out["tweets_after"] > before)
        out["ok"] = out["posted"]
        if not out["ok"]:
            out.setdefault("error", "点了回复但没有任何成功证据")
        return out

    def reply(self, href: str, text: str, dry_run: bool = False) -> dict:
        """在帖子详情页回一条。"""
        assert self.cdp
        self.require_login()
        text = (text or "").strip()
        if not text:
            raise XPageError("回复正文是空的")
        if len(text) > 280:
            raise XPageError(f"回复 {len(text)} 字，超过 280 上限")

        out: dict = {"ok": False, "posted": False, "href": href, "text": text, "shots": []}
        if not self.open_tweet(href):
            out["error"] = "帖子详情页没打开（可能被删/限流/结构变化）"
            return out

        st = self.reply_available()
        out["reply_available"] = st
        if not st.get("has_editor"):
            self.dismiss_blockers()
            if not self.reply_available().get("has_editor"):
                out["error"] = "这篇没有可用的回复框（作者限制回复，或页面结构变了）"
                out["shots"].append(self.shot("reply-no-editor"))
                return out

        typed = self.fill_editor(text)
        out["typed"] = typed
        out["shots"].append(self.shot("1-reply-filled"))
        if _norm(typed) != _norm(text):
            out["error"] = f"回复框内容与预期不一致：读回 {typed[:60]!r}"
            return out

        if dry_run:
            out["ok"] = True
            out["dry_run"] = True
            out["button"] = self.submit_state()
            return out

        if not self._wait_enabled():
            out["error"] = "回复按钮一直不可用"
            out["button"] = self.submit_state()
            return out

        before = self.count(S["tweet"])
        self._click_submit()
        out["shots"].append(self.shot("2-after-reply"))
        out["toast"] = self.wait_toast()
        _sleep(1.0, 2.0)
        after = self.count(S["tweet"])
        out["tweets_before"] = before
        out["tweets_after"] = after
        out["posted"] = after > before or bool(out["toast"])
        out["ok"] = out["posted"]
        if not out["posted"]:
            out["error"] = "点了回复但帖子数没变化，也没拿到 toast"
        return out

    # ---------------- 搜索 / 回关（互关用）----------------

    def search(self, query: str, wait: float = 3.0) -> bool:
        """用搜索框搜索（真人方式：点搜索框 → 打字 → 回车），不拼 URL。"""
        assert self.cdp
        box = self._pick_expr('input[data-testid="SearchBox_Search_Input"]')
        if not self.eval(f"return !!({box});"):
            return False
        self._click_expr_human(box, settle=(0.4, 0.9))
        _sleep(0.3, 0.7)
        # 清掉旧关键词（真实 Ctrl+A → Backspace）
        xinput.clear_field(self.cdp)
        _sleep(0.2, 0.4)
        if str(xinput.type_text(self.cdp, query)).startswith("failed"):
            return False
        _sleep(0.5, 1.2)
        xinput.press_enter(self.cdp)
        ok = dom.wait_js(self.cdp, "location.pathname.startsWith('/search')", timeout=12.0)
        if ok:
            time.sleep(wait)
            dom.wait_js(self.cdp,
                        "document.querySelectorAll('article[data-testid=\"tweet\"]').length > 0",
                        timeout=15.0)
        return ok

    def profile_follow_state(self) -> str:
        """当前主页关注按钮的状态：'following' / 'follow' / 'none'。"""
        assert self.cdp
        following = self._pick_expr('[data-testid$="-unfollow"]')
        if self.eval(f"return !!({following});"):
            return "following"
        follow = self._pick_expr('[data-testid$="-follow"]')
        if self.eval(f"return !!({follow});"):
            return "follow"
        return "none"

    def follow_author_of(self, tweet_href: str, wait: float = 2.2) -> dict:
        """点开这条帖子作者的主页，然后关注他（互关动作）。全程点界面。"""
        assert self.cdp
        out: dict = {"ok": False, "href": tweet_href}
        art = self.article_expr(tweet_href)
        if not self.eval(f"return !!({art});"):
            out["state"] = "article-gone"
            return out

        link = (f"({art}).querySelector('[data-testid=\"User-Name\"] a[role=\"link\"]')")
        if not self.eval(f"return !!({link});"):
            out["state"] = "no-author-link"
            return out
        out["profile"] = self.eval(
            f"const a = {link}; return a.getAttribute('href') || '';") or ""

        self._click_expr_human(link, settle=(0.8, 1.6))
        time.sleep(wait)
        state = self.profile_follow_state()
        out["state_before"] = state
        if state == "following":
            out["ok"] = True
            out["state"] = "already-following"
        elif state == "follow":
            btn = self._pick_expr('[data-testid$="-follow"]')
            out["clicked"] = self._click_expr_human(btn, settle=(0.8, 1.6))
            out["ok"] = dom.wait_js(
                self.cdp, f"!!({self._pick_expr('[data-testid$=\"-unfollow\"]')})", timeout=10.0)
            out["state"] = "followed" if out["ok"] else "follow-click-no-effect"
        else:
            out["state"] = "no-follow-button"
        return out

    # ---------------- 首页内联发帖（不发弹层）----------------

    def scroll_to_top(self, tries: int = 14) -> bool:
        """用滚轮把页面滚回顶部（不刷新、不跳转）。"""
        assert self.cdp
        for _ in range(max(1, tries)):
            try:
                if (self.cdp.evaluate("Math.round(window.scrollY)") or 0) <= 0:
                    return True
            except CdpError:
                pass
            self.browse_scroll(1, direction="up")
        return True

    def post_on_home(self, text: str, dry_run: bool = False) -> dict:
        """在【首页的内联发帖框】发一条 —— 就是人打开 X 直接在顶部那个框里打字。

        和 post() 的区别：post() 可能点左栏 Post 打开弹层；这里强制走首页内联框，
        所以先把页面滚回顶部，让那个框出现在视口里。
        """
        assert self.cdp
        self.require_login()
        out: dict = {"ok": False, "posted": False, "text": text, "where": "home-inline"}
        if not self.ensure_home():
            out["error"] = "回不到首页"
            return out
        self.scroll_to_top()
        out["dismissed"] = self.dismiss_blockers()
        if not self.has_editor():
            # 首页顶部没有内联框（A/B 实验），退回通用发帖路径
            out["where"] = "composer-fallback"
            return self.post(text, dry_run=dry_run)
        res = self.post(text, dry_run=dry_run)      # open_composer 会直接复用这个内联框
        res["where"] = "home-inline"
        return res

    # ---------------- 通知：谁回复/提到了我 ----------------

    def goto_notifications(self, wait: float = 2.5) -> bool:
        """点左栏「通知」。（不输网址）"""
        assert self.cdp
        expr = self._pick_expr('[data-testid="AppTabBar_Notifications_Link"]')
        if not self.eval(f"return !!({expr});"):
            return False
        self._click_expr_human(expr, settle=(0.7, 1.4))
        time.sleep(wait)
        self.dismiss_blockers()
        return dom.wait_js(self.cdp, "location.pathname.startsWith('/notifications')",
                           timeout=12.0)

    def read_notifications(self, limit: int = 20) -> list[dict]:
        """抽通知列表：谁回复了我 / 谁提到了我。

        X 的通知单元格没有稳定的 data-testid，所以用「文本特征 + 里面的帖子链接」判断：
          · 回复我 = 文案含 "replied to you" / "回复了你"
          · 提到我 = 文案含 "mentioned you" / "提到了你"
        """
        assert self.cdp
        js = """
        const n = %d;
        const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
        const cells = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')];
        const out = [];
        for (const c of cells) {
          const text = clean(c.innerText);
          if (!text) continue;
          const link = c.querySelector('a[href*="/status/"]');
          const href = link ? link.getAttribute('href').split('?')[0] : '';
          const isReply = /replied to you|回复了你/i.test(text);
          const isMention = /mentioned you|提到了你/i.test(text);
          if (!isReply && !isMention) continue;
          const handle = (href.match(/^\\/([^\\/]+)\\/status\\//) || [])[1] || '';
          const id = (href.match(/\\/status\\/(\\d+)/) || [])[1] || '';
          if (!id) continue;
          out.push({id: id, href: href, handle: handle, kind: isReply ? 'reply' : 'mention',
                    text: text.slice(0, 260)});
          if (out.length >= n) break;
        }
        return [...new Map(out.map(o => [o.id, o])).values()];
        """ % max(1, limit)
        return self.eval(js) or []

    # ---------------- 删帖（清理测试内容用）----------------

    def open_profile(self, wait: float = 2.5) -> bool:
        """进自己主页：点左栏 Profile（不输网址）。"""
        assert self.cdp
        expr = self._pick_expr('[data-testid="AppTabBar_Profile_Link"]')
        if not self.eval(f"return !!({expr});"):
            return False
        self._click_expr_human(expr, settle=(0.7, 1.4))
        time.sleep(wait)
        return dom.wait_js(self.cdp,
                           "document.querySelectorAll('article[data-testid=\"tweet\"]').length > 0",
                           timeout=15.0)

    def find_own_tweet(self, text_substr: str, limit: int = 20) -> dict | None:
        """在自己主页时间线里按正文片段找一条帖子（全程点+滚轮，不走 URL）。"""
        assert self.cdp
        if not self.open_profile():
            return None
        self.dismiss_blockers()
        for _ in range(4):
            for tw in self.wait_tweets(timeout=20.0, minimum=1):
                if text_substr in (tw.get("text") or ""):
                    return tw
            self.browse_scroll(1)
            _sleep(0.8, 1.8)
        return None

    def delete_tweet(self, href: str) -> dict:
        """删掉自己的一条帖子（只用来清测试内容，不做批量删除）。"""
        assert self.cdp
        self.require_login()
        out: dict = {"ok": False, "href": href, "shots": []}
        if not self.open_tweet(href):
            out["error"] = "详情页没打开"
            out["shots"].append(self.shot("delete-no-page"))
            return out
        self.dismiss_blockers()
        if not self.count('[data-testid="caret"]'):
            out["error"] = "找不到帖子右上角的更多菜单（可能不是自己的帖子）"
            out["shots"].append(self.shot("delete-no-caret"))
            return out
        self.click('[data-testid="caret"]')
        time.sleep(0.9)

        menu_expr = ("[...document.querySelectorAll('[role=\"menuitem\"]')]"
                     ".find(e => /^(Delete|删除)$/.test((e.innerText || '').trim())) || null")
        if not self.eval(f"return !!({menu_expr});"):
            out["error"] = "菜单里没有 Delete 项"
            out["shots"].append(self.shot("delete-no-menu"))
            return out
        self._click_expr_human(menu_expr, settle=(0.6, 1.2))
        time.sleep(0.9)
        if self.count('[data-testid="confirmationSheetConfirm"]'):
            self.click('[data-testid="confirmationSheetConfirm"]')
        else:
            out["confirm_missing"] = True
        gone = dom.wait_js(
            self.cdp,
            "/This post was deleted|此帖子已被删除|this page doesn.t exist|此页面不存在/i"
            ".test(document.body.innerText || '')",
            timeout=12.0)
        out["gone"] = gone
        out["ok"] = bool(gone)
        out["shots"].append(self.shot("after-delete"))
        if not gone:
            out["error"] = "点完删除但没看到删除成功的提示"
        return out

    # ---------------- 我的消息 / 私信（功能③）----------------

    def goto_messages(self, wait: float = 3.0) -> bool:
        """进「消息」页：点左栏私信入口（不输网址）。"""
        assert self.cdp
        expr = self._pick_expr(
            '[data-testid="AppTabBar_DirectMessage_Link"], a[href="/messages"], a[href="/i/chat"]')
        if not self.eval(f"return !!({expr});"):
            return False
        self._click_expr_human(expr, settle=(0.8, 1.6))
        time.sleep(wait)
        self.dismiss_blockers()
        return dom.wait_element(self.cdp, S["dm_conversation"], timeout=15.0)

    DM_LIST_JS = """
    const n = %d;
    const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
    const cells = [...document.querySelectorAll('div[data-testid="conversation"]')];
    return cells.slice(0, n).map(c => {
      const a = c.querySelector('a[href^="/messages/"]') || c.closest('a[href^="/messages/"]');
      const href = a ? a.getAttribute('href') : '';
      const aria = (c.getAttribute('aria-label') || '') + ' ' + (a ? a.getAttribute('aria-label') || '' : '');
      return {
        href: href,
        text: clean(c.innerText).slice(0, 220),
        unread: /未读|unread/i.test(aria) || !!c.querySelector('[data-testid="message-unread-badge"]'),
      };
    });
    """

    def dm_conversations(self, limit: int = 10) -> list[dict]:
        rows = self.eval(self.DM_LIST_JS % max(1, limit)) or []
        for r in rows:
            h = r.get("href") or ""
            r["key"] = h.split("/messages/")[-1] if "/messages/" in h else ""
        return rows

    def dm_open(self, key: str, wait: float = 2.5) -> bool:
        """打开某个私信会话：点列表里的那一行（不输网址）。"""
        assert self.cdp
        key = str(key).split("/messages/")[-1].lstrip("/")
        cell = (f"[...document.querySelectorAll('div[data-testid=\"conversation\"]')]"
                f".find(c => [...c.querySelectorAll('a[href*=\"/messages/\"]')]"
                f"  .some(a => (a.getAttribute('href') || '').includes({dom.js('/' + key)})))"
                f" || null")
        if not self.eval(f"return !!({cell});"):
            return False
        self._click_expr_human(cell, settle=(0.8, 1.6))
        time.sleep(wait)
        ok = dom.wait_js(self.cdp, f"({self.editor_expr(S['dm_input'])} || 0) !== 0",
                         timeout=15.0)
        if not ok:
            self.dismiss_blockers()
            ok = dom.wait_js(self.cdp, f"({self.editor_expr(S['dm_input'])} || 0) !== 0",
                             timeout=8.0)
        return ok

    def dm_last_messages(self, limit: int = 5) -> list[dict]:
        js = """
        const n = %d;
        const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
        const cells = [...document.querySelectorAll(
            'div[data-testid="messageEntry"], div[data-testid="messageEntryText"]')];
        return cells.slice(-n).map(c => ({
          text: clean(c.innerText).slice(0, 300),
          tid: c.getAttribute('data-testid'),
        }));
        """ % max(1, limit)
        return self.eval(js) or []

    def dm_reply(self, key: str, text: str, dry_run: bool = False) -> dict:
        assert self.cdp
        self.require_login()
        text = (text or "").strip()
        if not text:
            raise XPageError("私信正文是空的")
        out: dict = {"ok": False, "posted": False, "key": key, "text": text, "shots": []}
        if not self.dm_open(key):
            out["error"] = "私信会话打不开（输入框没出现）"
            out["shots"].append(self.shot("dm-no-input"))
            return out

        typed = self.fill_editor(text, selector=S["dm_input"])
        out["typed"] = typed
        out["shots"].append(self.shot("1-dm-filled"))
        if _norm(typed) != _norm(text):
            out["error"] = f"私信输入框内容与预期不一致：读回 {typed[:60]!r}"
            return out

        if dry_run:
            out["ok"] = True
            out["dry_run"] = True
            out["button"] = self.submit_state(S["dm_input"])
            return out

        # 有发送按钮就点它（私信靠按钮，不靠回车：回车在私信里也可能换行）
        expr = self._pick_expr(S["dm_send"])
        if self.eval(f"return !!({expr});"):
            self._click_expr_human(expr, settle=(0.5, 1.2))
        else:
            ui.press_enter(self.cdp)

        out["shots"].append(self.shot("2-after-dm"))
        cleared = dom.wait_js(
            self.cdp,
            f"!({self.editor_expr(S['dm_input'])}) || "
            f"(({{t: ({self.editor_expr(S['dm_input'])} || {{innerText:''}}).innerText || ''}}).t.trim() === '')",
            timeout=12.0)
        out["cleared"] = cleared
        out["posted"] = bool(cleared)
        out["ok"] = bool(cleared)
        if not cleared:
            out["error"] = "点了发送但输入框没清空"
        return out


# ---------------- 文本比对 ----------------

def _norm(s: str) -> str:
    """归一化：统一空白、去掉零宽字符，避免「看起来一样但比对不等」。"""
    s = (s or "").replace("\u200b", "").replace("\u00a0", " ")
    lines = [" ".join(line.split()) for line in s.splitlines()]
    return " ".join(x for x in lines if x).strip()
