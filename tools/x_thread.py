"""从回复页互动原帖：在一条帖子的回复列表里，顺手把「原帖」点赞 + 评论。

场景（用户口径）：刷到别人的回复 / 通知里的回复，点进去看到的是回复列表，
真正值得互动的往往是那一串里的原帖 —— 这个工具就干这件事：
    定位主帖（第一条 article）→ 点赞 → 生成评论 → 回复 → 返回

用法：
    python tools/x_thread.py                  # 处理当前打开的这个帖子
    python tools/x_thread.py --from-home      # 先回首页点开一条帖子再处理
    python tools/x_thread.py --yes            # 真的点赞+评论
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage, XPageError
from xauto import comment as comment_gen
from xauto import config, limits, runner, store


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-home", action="store_true")
    ap.add_argument("--no-like", action="store_true")
    ap.add_argument("--no-reply", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    out: dict = {"dry_run": not a.yes}
    tracker = runner.FailureTracker()
    with XPage() as p:
        p.require_login()
        tracker.page = p
        if a.from_home:
            if not p.ensure_home():
                print("[!] 回不到首页", file=sys.stderr)
                return 5
            tweets = [t for t in p.wait_tweets(timeout=12.0, minimum=1)
                      if (t.get("text") or "").strip()]
            if not tweets:
                print("[!] 时间线没帖子", file=sys.stderr)
                return 5
            if not p.open_tweet_by_click(tweets[0]["href"]):
                print("[!] 点不开帖子", file=sys.stderr)
                return 5

        detail = p.read_tweets(limit=1)
        if not detail:
            print("[!] 当前页没有主帖", file=sys.stderr)
            return 5
        post = detail[0]
        out["post"] = {"href": post.get("href"), "text": (post.get("text") or "")[:160]}

        try:
            if not a.no_like and store.budget_left("like", limits.get("like")) > 0:
                if a.yes:
                    out["like"] = p.like()
                    if (out["like"] or {}).get("ok"):
                        store.mark_like(post["id"], {"href": post.get("href")})
                else:
                    out["like"] = {"dry_run": True, "would": "like"}
            if not a.no_reply:
                gen = comment_gen.generate(post)
                out["comment"] = gen
                if store.budget_left("reply", limits.get("reply")) <= 0:
                    out["reply"] = {"ok": False, "skipped": "今日评论额度用完"}
                elif a.yes:
                    out["reply"] = p.reply_current(gen.get("text", ""))
                    if (out["reply"] or {}).get("ok"):
                        store.mark_tweet(post["id"], {"href": post.get("href"),
                                                      "text": gen.get("text", "")[:120]})
                        runner.reply_gap()
                else:
                    out["reply"] = {"dry_run": True, "would_send": gen.get("text", "")}
        except XPageError as e:
            out["error"] = str(e)
            tracker.fail(str(e))
        except runner.StopTask as e:
            out["stopped"] = str(e)

    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if not out.get("error") else 6


if __name__ == "__main__":
    raise SystemExit(main())
