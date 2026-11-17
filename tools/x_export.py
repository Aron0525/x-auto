"""导出：把「关注列表」或「当前页面的用户」导成 CSV。

用法：
    python tools/x_export.py --following               # 导出自己的关注列表
    python tools/x_export.py --page                    # 导出当前页里出现的用户
    python tools/x_export.py --following --max 300

产出：xauto/data/exports/*.csv（列：handle, name, bio, source）
全程点界面：先点左栏 Profile → 点 Following 链接 → 滚轮加载 → 边滚边收集。
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

USER_CELLS_JS = r"""
const clean = t => (t || '').replace(/\s+/g, ' ').trim();
const out = [];
for (const c of document.querySelectorAll('[data-testid="UserCell"], div[data-testid="cellInnerDiv"]')) {
  const link = c.querySelector('a[href^="/"][role="link"]:not([href*="/status/"])');
  const href = link ? link.getAttribute('href') : '';
  if (!href || href.split('/').length !== 2) continue;
  const handle = href.slice(1);
  const text = clean(c.innerText);
  if (!handle || !text) continue;
  out.push({handle: handle, text: text.slice(0, 160)});
}
return [...new Map(out.map(o => [o.handle, o])).values()];
"""


def write_csv(rows: list[dict], kind: str) -> Path:
    config.ensure_dirs()
    out_dir = config.DATA_DIR / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["handle", "text", "source"])
        w.writeheader()
        for r in rows:
            w.writerow({"handle": r.get("handle", ""), "text": r.get("text", ""),
                        "source": kind})
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--following", action="store_true", help="导出自己的关注列表")
    ap.add_argument("--page", action="store_true", help="导出当前页出现的用户")
    ap.add_argument("--max", type=int, default=200)
    ap.add_argument("--scrolls", type=int, default=12, help="最多滚几屏加载更多")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if not (a.following or a.page):
        print("[x] 需要 --following 或 --page", file=sys.stderr)
        return 2

    rows: dict[str, dict] = {}
    with XPage() as p:
        p.require_login()
        if a.following:
            if not p.open_profile():
                print("[!] 进不去主页", file=sys.stderr)
                return 5
            link = "[...document.querySelectorAll('a[href$=\"/following\"]')].pop() || null"
            if not p.eval(f"return !!({link});"):
                print("[!] 找不到 Following 入口", file=sys.stderr)
                return 5
            p._click_expr_human(link, settle=(0.8, 1.6))
            time.sleep(2.5)
        for i in range(max(1, a.scrolls)):
            for u in (p.eval(USER_CELLS_JS) or []):
                rows.setdefault(u["handle"], u)
            if len(rows) >= a.max:
                break
            p.browse_scroll(1)
            time.sleep(0.8)
        print(f"[i] 收集到 {len(rows)} 个用户", file=sys.stderr)

    data = list(rows.values())[:a.max]
    path = write_csv(data, "following" if a.following else "page-users")
    print(f"[=] 已导出 {len(data)} 行 → {path}")
    if a.json:
        print(json.dumps({"file": str(path), "count": len(data)},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
