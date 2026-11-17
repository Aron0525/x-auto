"""自动回复「别人对我的回复 / 提及」—— 从通知页进去，逐条回复。

用户口径（2026-11-16）：自动回复别人的评论（回复我的，再 notifications）。

流程（全程点界面，不输网址）：
    点左栏「通知」→ 抽通知列表里「回复了你 / 提到了你」的条目
    → 点进那条帖子 → 读原帖内容 → LLM 生成回应 → 在详情页回复 → 回原位

用法：
    python tools/x_notif.py                # 只看：列出谁回复了我、准备回什么（不写）
    python tools/x_notif.py --yes -n 3     # 真的回 3 条
    python tools/x_notif.py --yes --kind mention   # 只回「提到我」的
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage, XPageError
from xauto import comment as comment_gen
from xauto import config, limits, store

# 每天回通知的上限走 xauto/data/limits.json（UI 可改）


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=3)
    ap.add_argument("--kind", choices=("reply", "mention", "both"), default="both")
    ap.add_argument("--yes", action="store_true", help="真的发出去（默认只看）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    report: dict = {"ok": True, "seen": [], "done": []}
    with XPage() as p:
        p.require_login()
        if not p.goto_notifications():
            print("[!] 打不开通知页", file=sys.stderr)
            return 5
        items = p.read_notifications(limit=20)
        report["seen"] = items
        print(f"[i] 通知里找到 {len(items)} 条「回复我/提到我」", file=sys.stderr)

        todo = []
        for it in items:
            if a.kind != "both" and it["kind"] != a.kind:
                continue
            if store.seen_tweet(it["id"]):
                continue
            todo.append(it)
            if len(todo) >= a.n:
                break

        if not todo:
            print("[=] 没有需要回复的新通知")
            print(json.dumps(report, indent=2, ensure_ascii=False) if a.json else "")
            return 0

        if a.yes and store.budget_left("reply", limits.get("mention")) <= 0:
            print("[x] 今天回复通知的额度用完了", file=sys.stderr)
            return 10

        for idx, it in enumerate(todo, 1):
            print(f"\n[{idx}/{len(todo)}] @{it['handle']} 的 {it['kind']}：{it['text'][:80]}")
            # 从通知页点进那条帖子（点单元格里的链接）
            cell = ("[...document.querySelectorAll('[data-testid=\"cellInnerDiv\"]')]"
                    f".find(c => [...c.querySelectorAll('a[href*=\"/status/{it['id']}\"]')].length"
                    f" && /replied to you|回复了你|mentioned you|提到了你/i"
                    f"  .test((c.innerText || '')))"
                    "?.querySelector('a[href*=\"/status/\"]') || null")
            opened = False
            if p.eval(f"return !!({cell});"):
                p._click_expr_human(cell, settle=(0.9, 1.8))
                opened = p.cdp.evaluate(
                    f"location.pathname.includes({json.dumps(it['id'])})") is True
            if not opened:
                opened = p.open_tweet(it["href"])
            if not opened:
                print("    [x] 打不开这条，跳过", file=sys.stderr)
                p.goto_notifications()
                continue

            detail = p.read_tweets(limit=1)
            post = detail[0] if detail else {"text": it["text"]}
            gen = comment_gen.generate({**post, "author": it["handle"]})
            text = (gen.get("text") or "").strip()
            print(f"    回应：{text[:90]}")
            if not a.yes:
                report["done"].append({"id": it["id"], "dry_run": True, "comment": text})
                p.goto_notifications()
                continue
            try:
                r = p.reply_current(text)
            except XPageError as e:
                r = {"ok": False, "error": str(e)}
            report["done"].append({"id": it["id"], "result": r, "comment": text})
            if r.get("ok"):
                store.mark_tweet(it["id"], {"href": it["href"], "text": text[:120],
                                            "via": "notification"})
                print("    ✓ 已回复")
            else:
                print(f"    ✗ 回复失败：{r.get('error')}", file=sys.stderr)
            p.goto_notifications()          # 回通知页继续下一条
            time.sleep(random.uniform(3.0, 8.0))

    ok = sum(1 for d in report["done"] if d.get("dry_run") or (d.get("result") or {}).get("ok"))
    print(f"\n[=] 处理 {ok}/{len(todo)} 条（{'dry-run' if not a.yes else '已发送'}）")
    if a.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if ok == len(todo) else 6


if __name__ == "__main__":
    raise SystemExit(main())
