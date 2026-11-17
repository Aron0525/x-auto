"""功能③：「我的消息」（私信）里回复别人。

用法（默认 dry-run）：
  python tools/x_dm.py --list                                # 看会话列表（谁发来、未读标记）
  python tools/x_dm.py --read -n 3                           # 看每个会话最后几条消息
  python tools/x_dm.py --template "收到，稍后细聊～" --unread-only -n 3 --yes

安全阀：去重簿（已回过的会话不重复回）+ 每日限额（limits.json）+ 冷却。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage, XPageError
from xauto import config, store
from xauto.session import random_sleep


def build_reply(tpl: str, conv: dict) -> str:
    return (tpl or "").replace("{name}", conv.get("text", "")[:20]).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--read", action="store_true", help="列出会话并读最后几条消息")
    ap.add_argument("-n", type=int, default=config.DEFAULT_BATCH)
    ap.add_argument("--template", default="")
    ap.add_argument("--unread-only", action="store_true")
    ap.add_argument("--yes", action="store_true", help="真的发出去（默认 dry-run）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    with XPage() as page:
        page.require_login()
        if not page.goto_messages():
            print("[!] 私信页没就位（选择器可能要更新：跑 x_probe --status 看当前页）",
                  file=sys.stderr)
            return 5

        convs = page.dm_conversations(limit=max(a.n * 3, 12))
        if a.list or a.read or not a.template:
            print(json.dumps(convs, indent=2, ensure_ascii=False))
        if a.list:
            return 0

        if a.read:
            for c in convs[:a.n]:
                if not c.get("key"):
                    continue
                page.dm_open(c["key"])
                msgs = page.dm_last_messages(limit=4)
                print(f"\n=== {c.get('text','')[:60]} ({c['key'][:12]}) ===")
                print(json.dumps(msgs, indent=2, ensure_ascii=False))
            return 0

        if not a.template:
            print("[x] 需要 --template。先 --read 看清对话再定话术。", file=sys.stderr)
            return 2

        todo = []
        for c in convs:
            if len(todo) >= a.n:
                break
            if not c.get("key"):
                continue
            if a.unread_only and not c.get("unread"):
                continue
            if store.seen_dm(c["key"]):
                continue
            todo.append(c)

        print(f"[i] 读到 {len(convs)} 个会话，待回 {len(todo)} 个", file=sys.stderr)
        results = []
        for i, c in enumerate(todo, 1):
            text = build_reply(a.template, c)
            print(f"\n[{i}/{len(todo)}] {c.get('text','')[:60]}")
            print(f"  回复: {text[:120]}")
            try:
                r = page.dm_reply(c["key"], text, dry_run=not a.yes)
            except XPageError as e:
                r = {"ok": False, "error": str(e), "key": c["key"]}
            results.append(r)
            if r.get("ok"):
                store.mark_dm(c["key"], {"text": text[:120], "dry_run": not a.yes})
            if i < len(todo):
                d = random_sleep(*config.ACTION_DELAY)
                print(f"  ...冷却 {d:.1f}s", file=sys.stderr)

        ok = sum(1 for r in results if r.get("ok"))
        print(f"\n[=] 完成 {ok}/{len(results)}（dry_run={not a.yes}）")
        if a.json:
            print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0 if ok == len(results) else 6


if __name__ == "__main__":
    raise SystemExit(main())
