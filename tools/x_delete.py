"""删除帖子：把自己主页上最近的 N 条帖子删掉（默认 dry-run）。

用法：
    python tools/x_delete.py --n 3            # 只看会删哪几条
    python tools/x_delete.py --n 3 --yes      # 真删
    python tools/x_delete.py --text 关键词 --yes   # 只删正文含关键词的

安全：单次最多 10 条，删完会核对「帖子已不存在」。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--text", help="只删正文包含该关键词的帖子")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    n = max(1, min(10, a.n))
    done: list[dict] = []
    with XPage() as p:
        p.require_login()
        if not p.open_profile():
            print("[!] 进不去主页", file=sys.stderr)
            return 5
        time.sleep(1.5)
        tweets = p.wait_tweets(timeout=20.0, minimum=1)
        me = (p.whoami().get("handle") or "").lower()
        cands = [t for t in tweets
                 if (not me or (t.get("handle") or "").lower() == me)
                 and (not a.text or a.text in (t.get("text") or ""))]
        print(f"[i] 主页读到 {len(tweets)} 条，可删候选 {len(cands)} 条", file=sys.stderr)

        for tw in cands[:n]:
            print(f"\n→ {tw['text'][:70]}")
            if not a.yes:
                done.append({"id": tw["id"], "text": tw["text"][:80], "dry_run": True})
                continue
            if not p.open_tweet_by_click(tw["href"]):
                done.append({"id": tw["id"], "ok": False, "error": "打不开详情"})
                continue
            r = p.delete_tweet(tw["href"])
            done.append({"id": tw["id"], "ok": r.get("ok"), "error": r.get("error")})
            print(f"   {'✓ 已删除' if r.get('ok') else '✗ ' + str(r.get('error'))}")
            p.ensure_home()
            p.open_profile()
            time.sleep(random.uniform(2.0, 5.0))

    print(f"\n[=] {'预览' if not a.yes else '删除'} {len(done)} 条")
    if a.json:
        print(json.dumps(done, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
