"""调试：正式号上手动走一遍「打开通知→上滑→输入→提交」，把每步状态打出来。"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage
from xauto import input as xi


def main() -> int:
    with XPage() as p:
        c = p.cdp
        me = (p.whoami().get("handle") or "").lstrip("@")
        print("账号:", me, "| 页面:", c.url())
        if not p.goto_notifications():
            print("[!] 通知页打不开")
            return 1
        items = p.read_notifications(limit=10, me=me)
        print("可回复通知:", len(items))
        target = None
        for it in items:
            if "GIF" not in it["text"]:
                target = it
                break
        if not target:
            print("没有合适的通知")
            return 1
        print("目标:", target["text"][:80])

        cell = ("[...document.querySelectorAll('[data-testid=\"cellInnerDiv\"]')]"
                f".find(c => [...c.querySelectorAll('a[href*=\"/status/{target['id']}\"]')].length)"
                "?.querySelector('a[href*=\"/status/\"]') || null")
        print("单元格存在:", p.eval(f"return !!({cell});"))
        print("点击单元格:", p._click_expr_human(cell, settle=(1.0, 2.0)))
        time.sleep(2.5)
        print("进去后 url:", c.url())
        print("可用性:", p.post_available())

        p.scroll_context_up(4)
        detail = p.read_tweets(limit=3)
        print("上下文条数:", len(detail))
        post = detail[0] if detail else {"text": target["text"]}
        print("主帖文本:", (post.get("text") or "")[:80])

        text = "看到你这条了，我先记下这个角度，回头细看再回你"
        print("编辑前 reply_available:", json.dumps(p.reply_available(), ensure_ascii=False))
        try:
            typed = p.fill_editor(text)
            print("输入读回:", repr(typed))
        except Exception as e:
            print("输入异常:", type(e).__name__, e)
            return 1
        time.sleep(0.5)
        print("提交按钮状态:", json.dumps(p.submit_state(), ensure_ascii=False))
        print("点击提交:", p._click_submit())
        time.sleep(2.0)
        print("toast:", repr(p.wait_toast(timeout=3)))
        print("编辑器是否清空:", p._editor_cleared())
        print("页面是否出现我们的回复:", c.evaluate(
            "(() => (document.body.innerText || '').includes(%s))()"
            % json.dumps("我先记下这个角度")))
        print("截图:", p.shot("debug-reply"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
