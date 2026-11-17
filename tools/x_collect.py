"""从评论里收集个人主页：打开一条帖子（或已在详情页），把回复区里的作者收集成 CSV。

用法：
    python tools/x_collect.py --from-timeline 0     # 已在详情页：直接收集回复区
    python tools/x_collect.py --from-timeline 1     # 从首页点开第一条帖子再收集

产出：xauto/data/exports/repliers-*.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage
from xauto import config

REPLIERS_JS = r"""
const clean = t => (t || '').replace(/\s+/g, ' ').trim();
const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
const out = [];
arts.forEach((a, idx) => {
  const links = [...a.querySelectorAll('[data-testid="User-Name"] a[role="link"]')]
    .map(x => x.getAttribute('href') || '')
    .filter(h => h.startsWith('/') && !h.slice(1).includes('/'));
  const handle = (links[0] || '').replace('/', '');
  if (!handle) return;
  const txt = clean((a.querySelector('[data-testid="tweetText"]') || {}).innerText);
  out.push({handle: handle, text: txt.slice(0, 200), order: idx});
});
return [...new Map(out.map(o => [o.handle, o])).values()];
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-timeline", type=int, default=0,
                    help="1=先回首页点开一条帖子；0=假设已在详情页")
    ap.add_argument("--scrolls", type=int, default=10)
    ap.add_argument("--max", type=int, default=300)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    with XPage() as p:
        p.require_login()
        if a.from_timeline:
            if not p.ensure_home():
                print("[!] 回不到首页", file=sys.stderr)
                return 5
            tweets = [t for t in p.wait_tweets(timeout=12.0, minimum=1)
                      if (t.get("text") or "").strip()]
            if not tweets:
                print("[!] 时间线没有帖子", file=sys.stderr)
                return 5
            if not p.open_tweet_by_click(tweets[0]["href"]):
                print("[!] 点不开帖子", file=sys.stderr)
                return 5

        rows: dict[str, dict] = {}
        for _ in range(max(1, a.scrolls)):
            for u in (p.eval(REPLIERS_JS) or []):
                rows.setdefault(u["handle"], u)
            if len(rows) >= a.max:
                break
            p.browse_scroll(1)
            time.sleep(0.7)
        print(f"[i] 回复区收集到 {len(rows)} 个作者", file=sys.stderr)

    config.ensure_dirs()
    out_dir = config.DATA_DIR / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"repliers-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["handle", "text"])
        w.writeheader()
        for u in list(rows.values())[:a.max]:
            w.writerow({"handle": u["handle"], "text": u.get("text", "")})
    print(f"[=] 已导出 {len(rows)} 行 → {path}")
    if a.json:
        print(json.dumps({"file": str(path), "count": len(rows)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
