"""关掉草稿：清空编辑框 → 点关闭 → 若弹「保存草稿」就选「不保存/放弃」。"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage
from xauto import input as xinput

DISCARD_TEXTS = ("不保存", "放弃", "丢弃", "Discard", "Don't save", "Do not save")


def discard_dialog(p: XPage) -> str:
    """如果出现「保存草稿？」弹窗，选不保存。返回点到的按钮文案。"""
    expr = ("[...document.querySelectorAll('[role=\"button\"], button')]"
            f".find(b => {list(DISCARD_TEXTS)!r}.some(t => "
            "(b.innerText || '').trim().toLowerCase().includes(t.toLowerCase())))"
            " || null")
    if p.eval(f"return !!({expr});"):
        label = p.eval(f"const b = {expr}; return (b.innerText||'').trim();")
        p._click_expr_human(expr, settle=(0.6, 1.2))
        return str(label or "?")
    return ""


def main() -> int:
    with XPage() as p:
        c = p.cdp
        print("当前页面:", c.url())
        p.dismiss_blockers()

        if "/compose" in (c.url() or ""):
            # 1) 清空草稿内容
            p.clear_editor()
            print("已清空编辑框:", repr(p.editor_text())[:40])
            # 2) 点关闭
            close_expr = ("[...document.querySelectorAll("
                          "'[data-testid=\"app-bar-close\"], [aria-label=\"Close\"], [aria-label=\"关闭\"]')]"
                          ".filter(b => b.getBoundingClientRect().width > 8).pop() || null")
            if p.eval(f"return !!({close_expr});"):
                p._click_expr_human(close_expr, settle=(0.8, 1.6))
                time.sleep(1.2)
                label = discard_dialog(p)
                if label:
                    print("弹窗选择了:", label)
                time.sleep(1.0)
        url = c.url()
        print("现在页面:", url, "| 还在 compose:", "/compose" in (url or ""))
        if "/compose" in (url or ""):
            # 兜底：ESC 关弹层
            xinput.press_key(c, "Escape")
            time.sleep(1.0)
            label = discard_dialog(p)
            if label:
                print("ESC 后弹窗选择了:", label)
            print("最终页面:", c.url())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
