"""功能①：在 X 上发一条帖子。

用法：
  python tools/x_post.py --text "你好 X" --dry-run      # 只填不点（默认就是 dry-run，保险）
  python tools/x_post.py --text "你好 X" --yes          # 真的发出去
  python tools/x_post.py --file post.txt --yes
  python tools/x_post.py --verify                       # 核对主页上最新一条

为什么要 --yes：发帖是「对外可见、不可撤回」的动作，命令必须显式授权。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage, XPageError


def verify_latest(page: XPage) -> dict:
    """去自己主页看第一条帖子，确认内容。点左栏 Profile 进去，不输网址、不刷新。"""
    me = page.whoami()
    handle = (me.get("handle") or "").lstrip("/")
    if not handle:
        return {"ok": False, "error": "拿不到当前账号 handle"}
    if not page.open_profile():
        return {"ok": False, "error": "点不进自己的主页"}
    page.dismiss_blockers()
    for _ in range(3):
        tweets = page.wait_tweets(timeout=20.0, minimum=1)
        if tweets:
            first = tweets[0]
            return {"ok": True, "handle": handle, "text": first.get("text", ""),
                    "href": first.get("href", ""), "at": first.get("at", "")}
        page.browse_scroll(1)
        time.sleep(1.2)
    return {"ok": False, "error": "主页帖子列表没渲染出来（新号限速时常见）"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--file")
    ap.add_argument("--yes", action="store_true", help="真的发出去（默认 dry-run）")
    ap.add_argument("--verify", action="store_true", help="只核对主页最新一条")
    ap.add_argument("--selftest", action="store_true",
                    help="全链路自检到「提交前一步」，绝不发布")
    ap.add_argument("--delete", help="删掉一条：给 URL，或给正文片段（在自己主页里找）")
    ap.add_argument("--home", action="store_true",
                    help="走首页内联发帖框（人打开 X 直接在顶部框里打字），不开弹层")
    ap.add_argument("--topic", help="给主题让模型写文案（SOP 10：自己的问题/过程/观察）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    text = a.text or ""
    if a.file:
        text = Path(a.file).read_text(encoding="utf-8")
    text = text.strip()

    gen_meta = None
    if a.topic and not text:
        try:
            from tools.x_autopost_gen import generate_post
        except Exception:
            from tools import x_autopost_gen as _m
            generate_post = _m.generate_post
        gen_meta = generate_post(a.topic)
        text = (gen_meta or {}).get("text", "").strip()
        print(f"[文案] {text}", file=sys.stderr)
        if not text:
            print(f"[x] 生成失败：{(gen_meta or {}).get('error')}", file=sys.stderr)
            return 3

    with XPage() as page:
        if a.selftest:
            r = page.selftest(text or "自检：这条不会发出去")
            print(json.dumps(r, indent=2, ensure_ascii=False))
            return 0 if r.get("ok") else 9

        if a.delete:
            href = a.delete
            if not href.startswith("http") and not href.startswith("/"):
                found = page.find_own_tweet(a.delete)
                if not found:
                    print(f"[x] 主页上没找到包含「{a.delete}」的帖子", file=sys.stderr)
                    return 7
                href = found["href"]
                print(f"[i] 命中：{found['text'][:60]}  {href}")
            r = page.delete_tweet(href)
            print(json.dumps(r, indent=2, ensure_ascii=False))
            return 0 if r.get("ok") else 8

        if a.verify:
            r = verify_latest(page)
            print(json.dumps(r, indent=2, ensure_ascii=False) if a.json else r)
            return 0 if r.get("ok") else 1

        if not text:
            print("[x] 没给正文：用 --text 或 --file", file=sys.stderr)
            return 2
        try:
            r = (page.post_on_home(text, dry_run=not a.yes) if a.home
                 else page.post(text, dry_run=not a.yes))
        except XPageError as e:
            print(f"[x] {e}", file=sys.stderr)
            return 3
        print(json.dumps(r, indent=2, ensure_ascii=False))
        if r.get("ok") and not r.get("dry_run"):
            v = verify_latest(page)
            print("\n[verify] " + json.dumps(v, indent=2, ensure_ascii=False))
        return 0 if r.get("ok") else 4


if __name__ == "__main__":
    raise SystemExit(main())
