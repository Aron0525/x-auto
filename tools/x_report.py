"""周复盘（SOP 第 13 节）。

SOP 要求的复盘项，这里能自动统计的自动统计，需要人判断的列成问题：
  · 有效往返：哪些评论引出了讨论（我们没取回帖数，先按「评论成功条数」+ 通知里别人回我）
  · 关注是否相关：新关注的人是否还值得留在时间线（列出名单供人工判断）
  · 输入输出是否失衡：评论条数 vs 原创条数（SOP 点名的失衡信号）
  · 收藏是否被用上：收藏总数 vs 已消化数
  · 安全与边界：需人工回顾（是否点过风险链接、是否卷进争论）

用法：python tools/x_report.py [--days 7]
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xauto import config, limits, store


def within(ts: str, days: int) -> bool:
    try:
        t = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    except Exception:
        return False
    return t >= datetime.now() - timedelta(days=days)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    d = json.loads(Path(store.config.STATE_FILE).read_text(encoding="utf-8"))
    replies = [v for v in d.get("replied_tweets", {}).values()
               if within(v.get("at", ""), a.days)]
    likes = [v for v in d.get("liked", {}).values() if within(v.get("at", ""), a.days)]
    follows = [(k, v) for k, v in d.get("followed", {}).items()
               if within(v.get("at", ""), a.days)]
    posts = [p for p in d.get("posted", []) if within(p.get("at", ""), a.days)]

    try:
        import tools.x_bookmarks as bm
        books = bm.load()
    except Exception:
        books = []
    books_open = [b for b in books if b.get("status") == "open"]
    books_used = [b for b in books if b.get("status") == "used"]

    rep = {
        "window_days": a.days,
        "replies": len(replies),
        "likes": len(likes),
        "follows": len(follows),
        "original_posts": len(posts),
        "bookmarks": {"total": len(books), "open": len(books_open),
                      "used": len(books_used)},
        "limits": limits.load(),
    }
    ratio = (rep["replies"] / rep["original_posts"]) if rep["original_posts"] else None
    rep["reply_vs_original_ratio"] = round(ratio, 2) if ratio else None

    print("═" * 48)
    print(f"近 {a.days} 天复盘（SOP 第 13 节）")
    print("═" * 48)
    print(f"  评论 {rep['replies']} 条 ｜ 点赞 {rep['likes']} ｜ 关注 {rep['follows']} ｜ 原创 {rep['original_posts']}")
    if ratio is not None and ratio >= 5:
        print(f"  ⚠ 输入输出失衡：评论是原创的 {ratio} 倍（SOP 点名的失衡信号）")
    elif ratio is not None:
        print(f"  评论/原创 = {ratio}")
    print(f"  收藏：共 {rep['bookmarks']['total']}，待消化 {rep['bookmarks']['open']}，"
          f"已消化 {rep['bookmarks']['used']}")
    if books_open:
        print("  待消化收藏（拿去用，不要只收藏不看）：")
        for b in books_open[:5]:
            print(f"    · [{b.get('category')}] {(b.get('text') or '')[:60]}")
    if follows:
        print("  新关注（下周复盘：是否真的出现在你愿意读完的时间线里）：")
        for h, v in follows[:10]:
            print(f"    · @{h}  {v.get('reason', '')[:40]}")
    print("  需要人工回顾：有没有点开风险链接 / 卷进争论 / 误用举报")
    print("═" * 48)
    if a.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
