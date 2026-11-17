"""关注 / 取关（SOP 第 5 节）。

SOP 明确的两条：
  · 关注前看：简介能不能辨认方向、近期几篇是不是认真写的、能不能说出关注理由
  · 不要批量关注再批量取关，也不要靠「互关/新朋友」关键词找人（那是互动交换）

所以：
  follow   → 从当前时间线按**内容质量**挑人，点进主页看简介 + 近期 5 条，能说出理由才关注
  unfollow → 从自己的关注列表逐个取关（数量必须显式指定，且很小）

用法：
    python tools/x_follow.py --follow 1 --yes
    python tools/x_follow.py --unfollow 2 --yes
    python tools/x_follow.py --status
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
from xauto import limits, runner, sop, store

UNFOLLOW_HARD_CAP = 3          # 单次最多取关几个（SOP 5.2：不要批量）


def follow_by_quality(p: XPage, n: int, dry: bool) -> list[dict]:
    out: list[dict] = []
    if store.budget_left("follow", limits.get("follow")) <= 0:
        print("[!] 今日关注额度已用完", file=sys.stderr)
        return out
    if not p.ensure_home():
        return out
    tweets = p.wait_tweets(timeout=12.0, minimum=1)
    ranked = sorted(tweets, key=sop.quality_score, reverse=True)
    for tw in ranked:
        if len(out) >= n:
            break
        handle = (tw.get("handle") or "").strip()
        if not handle or store.followed(handle):
            continue
        q = sop.quality_score(tw)
        if q < 2.0:
            continue
        art = p.article_expr(tw["href"])
        link = f"({art}).querySelector('[data-testid=\"User-Name\"] a[role=\"link\"]')"
        if not p.eval(f"return !!({link});"):
            continue
        if dry:
            print(f"  [dry] 会先看 @{handle} 主页（质量分 {q:.1f}）再决定是否关注")
            out.append({"handle": handle, "dry_run": True})
            continue
        p._click_expr_human(link, settle=(0.8, 1.6))
        time.sleep(2.0)
        profile = p.cdp.evaluate_json("""
        const T = document.body.innerText || '';
        const m = T.match(/@[\\w_]+\\n([^\\n]{0,140})/);
        return {bio: (m ? m[1] : '').trim()};
        """) or {}
        recent = p.read_tweets(limit=5)
        ok, reason = sop.should_follow(profile, recent, f"近期内容具体（质量分 {q:.1f}）")
        if not ok:
            print(f"  不关注 @{handle}：{reason}")
            p.ensure_home()
            continue
        if p.profile_follow_state() == "following":
            store.mark_follow(handle, {"href": tw["href"], "state": "already"})
            p.ensure_home()
            continue
        btn = p._pick_expr('[data-testid$="-follow"]')
        p._click_expr_human(btn, settle=(0.8, 1.6))
        followed = p.profile_follow_state() == "following"
        out.append({"handle": handle, "ok": followed, "reason": reason})
        if followed:
            store.mark_follow(handle, {"href": tw["href"], "reason": reason[:60]})
            print(f"  ✓ 关注 @{handle}（{reason}）")
        else:
            print(f"  ✗ @{handle} 关注未生效")
        p.ensure_home()
        time.sleep(random.uniform(3.0, 7.0))
    return out


def unfollow_some(p: XPage, n: int, dry: bool) -> list[dict]:
    out: list[dict] = []
    n = max(1, min(UNFOLLOW_HARD_CAP, n))
    if not p.open_profile():
        return out
    link = "[...document.querySelectorAll('a[href$=\"/following\"]')].pop() || null"
    if not p.eval(f"return !!({link});"):
        print("[!] 找不到 Following 入口", file=sys.stderr)
        return out
    p._click_expr_human(link, settle=(0.8, 1.6))
    time.sleep(2.5)
    for _ in range(n):
        btn = ("[...document.querySelectorAll('[data-testid$=\"-unfollow\"]')]"
               ".filter(b => b.getBoundingClientRect().width > 8).pop() || null")
        if not p.eval(f"return !!({btn});"):
            p.browse_scroll(1)
            if not p.eval(f"return !!({btn});"):
                break
        who = (p.eval(f"const b = {btn}; return (b.closest('[data-testid=\"UserCell\"]')"
                      f" || b.parentElement || {{}}).innerText || '';") or "")
        who = " ".join(str(who).split())[:40]
        if dry:
            print(f"  [dry] 会取关：{who}")
            out.append({"who": who, "dry_run": True})
            continue
        p._click_expr_human(btn, settle=(0.8, 1.6))
        if p.count('[data-testid="confirmationSheetConfirm"]'):
            p.click('[data-testid="confirmationSheetConfirm"]')
        print(f"  ✓ 取关：{who}（SOP 5.2：有理由才减，别批量）")
        out.append({"who": who, "ok": True})
        time.sleep(random.uniform(3.0, 6.0))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--follow", type=int, default=0)
    ap.add_argument("--unfollow", type=int, default=0)
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rep: dict = {"dry_run": not a.yes}
    tracker = runner.FailureTracker()
    with XPage() as p:
        p.require_login()
        tracker.page = p
        if a.status:
            p.open_profile()
            stats = p.cdp.evaluate_json("""
            const T = document.body.innerText || '';
            const m = T.match(/([\\d,]+)\\s*Following/); const f = T.match(/([\\d,]+)\\s*Follower/);
            return {following: m ? m[1] : '', followers: f ? f[1] : ''};
            """)
            print(json.dumps({"profile": stats, **store.summary()}, indent=2, ensure_ascii=False))
            return 0
        try:
            if a.follow:
                rep["follow"] = follow_by_quality(p, a.follow, not a.yes)
            if a.unfollow:
                rep["unfollow"] = unfollow_some(p, a.unfollow, not a.yes)
        except runner.StopTask as e:
            print(f"[x] {e}", file=sys.stderr)
            rep["stopped"] = str(e)
        except Exception as e:
            print(f"[x] {type(e).__name__}: {e}", file=sys.stderr)
            tracker.fail(str(e))
    if a.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
