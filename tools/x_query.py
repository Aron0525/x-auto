"""X 数据查询：查自己 / 查某个用户 / 查当前这条帖子的数据。

用法：
    python tools/x_query.py                     # 查自己主页数据
    python tools/x_query.py --user elonmusk     # 搜索并打开某人主页，读数据
    python tools/x_query.py --current           # 读当前页面这条帖子的互动数
全程点界面（搜索框打字、点左栏），不输网址。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage

PROFILE_JS = r"""
const T = document.body.innerText || '';
const g = re => { const m = T.match(re); return m ? m[1] : ''; };
return {
  name: (T.split('\n').find(l => l.trim()) || '').slice(0, 40),
  following: g(/([\d,]+)\s*Following/),
  followers: g(/([\d,]+)\s*Follower/),
  posts: g(/([\d,]+)\s*posts/),
  joined: g(/Joined\s+([A-Za-z]+\s+\d{4})/),
  bio: ((T.match(/@[\w_]+\n([^\n]{0,120})/) || [])[1] || '').trim(),
};
"""

CURRENT_JS = r"""
const nums = t => {
  const m = (t || '').replace(/\s+/g, '');
  if (!m) return null;
  if (/^\d+$/.test(m)) return Number(m);
  const mm = m.match(/^(\d+(?:\.\d+)?)([KM万])$/i);
  if (!mm) return null;
  const base = Number(mm[1]);
  const unit = mm[2].toUpperCase();
  if (unit === 'K') return Math.round(base * 1000);
  if (unit === 'M') return Math.round(base * 1e6);
  if (mm[2] === '万') return Math.round(base * 1e4);
  return null;
};
const a = document.querySelector('article[data-testid="tweet"]');
if (!a) return null;
const bar = a.querySelector('[role="group"]') || a;
const btn = tid => {
  const b = bar.querySelector(`[data-testid="${tid}"]`);
  return b ? nums((b.innerText || '').trim()) : null;
};
const txt = (a.querySelector('[data-testid="tweetText"]') || {}).innerText || '';
const tm = a.querySelector('time');
return {
  text: (txt || '').replace(/\s+/g, ' ').slice(0, 200),
  reply: btn('reply'), repost: btn('retweet'), like: btn('like'),
  views: btn('analytics') || btn('app-text-transition-container'),
  at: tm ? tm.getAttribute('datetime') : '',
};
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", help="查某个用户（会走搜索）")
    ap.add_argument("--current", action="store_true", help="查当前这条帖子")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    out: dict = {}
    with XPage() as p:
        p.require_login()
        if a.current:
            out["tweet"] = p.cdp.evaluate_json(CURRENT_JS)
        elif a.user:
            if not p.ensure_home() or not p.search(a.user):
                print("[!] 搜索失败", file=sys.stderr)
                return 5
            time.sleep(1.5)
            cell = ("[...document.querySelectorAll('[data-testid=\"UserCell\"] a[href=\"/"
                    + a.user.lstrip("@")
                    + "\"]')].pop() || null")
            if p.eval(f"return !!({cell});"):
                p._click_expr_human(cell, settle=(0.9, 1.8))
                time.sleep(2.5)
            out["user"] = a.user
            out["profile"] = p.cdp.evaluate_json(PROFILE_JS)
            out["url"] = p.cdp.url()
        else:
            if not p.open_profile():
                print("[!] 进不去主页", file=sys.stderr)
                return 5
            time.sleep(1.5)
            out["profile"] = p.cdp.evaluate_json(PROFILE_JS)
            out["me"] = p.whoami()

    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
