"""连续会话（多轮）：每轮 = 一次 SOP 浏览会话，轮间隔 40 分钟 ± 10 分钟。

按《X 新人浏览互动 SOP》调整后的结构：
  · 一轮就是一次「时间盒会话」（默认 25 分钟，到点就停，对应 SOP 2.5）
  · 会话内部顺序：通知 → 关注时间线 → 推荐（SOP 2.3）
  · **不再搜「互关/新朋友」关键词去回关** —— SOP 0.5 / 4.7 禁止互动交换
  · 关注改为「内容质量驱动」：点开主页看简介 + 近期几条，看得出值得才关注，每轮最多 1~2 个
  · 轮与轮之间按配置间隔（默认 40 分钟 ±600 秒）随机等

用法：
    python tools/x_repeat.py --cycles 3 --yes        # 跑 3 轮
    python tools/x_repeat.py --yes                   # 一直跑（Ctrl+C 停）
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
from xauto import behavior, limits, runner, sop, store


def log(msg: str) -> None:
    print(f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)


# ---------------- 内容质量驱动的关注（SOP 第 5 节）----------------

def follow_by_quality(p: XPage, max_follows: int, dry: bool) -> list[dict]:
    """从当前时间线里挑「内容看着靠谱」的作者，先看主页再决定关注。

    SOP 5.1：看简介、看近期多篇、看回复质量，并且能说出关注理由；
    不许批量关注，也不许因为一条爆帖就关注。
    """
    out: list[dict] = []
    if store.budget_left("follow", limits.get("follow")) <= 0:
        log("  今日关注额度已用完")
        return out
    if not p.ensure_home():
        return out
    tweets = p.wait_tweets(timeout=12.0, minimum=1)
    ranked = sorted(tweets, key=sop.quality_score, reverse=True)   # 按内容质量，不按互动量
    for tw in ranked:
        if len(out) >= max_follows:
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
            log(f"  [dry] 会先看 @{handle} 主页（质量分 {q:.1f}）再决定关注")
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
            log(f"  不关注 @{handle}：{reason}")
            p.ensure_home()
            continue
        if p.profile_follow_state() == "following":
            store.mark_follow(handle, {"href": tw["href"], "state": "already"})
            p.ensure_home()
            continue
        btn = p._pick_expr('[data-testid$="-follow"]')
        clicked = p._click_expr_human(btn, settle=(0.8, 1.6))
        followed = p.profile_follow_state() == "following"
        out.append({"handle": handle, "ok": followed, "clicked": clicked, "reason": reason})
        if followed:
            store.mark_follow(handle, {"href": tw["href"], "reason": reason[:60]})
            log(f"  ✓ 关注 @{handle}（{reason}）")
        else:
            log(f"  ✗ @{handle} 关注未生效")
        p.ensure_home()
        time.sleep(random.uniform(3.0, 7.0))
    return out


# ---------------- 一轮 ----------------

def one_round(p: XPage, a) -> dict:
    import tools.x_session as session_mod

    rep: dict = {"at": time.strftime("%Y-%m-%d %H:%M:%S")}
    log("── 新一轮开始（SOP 会话）──")
    runner.wait_out_daily_rest()

    try:
        rep["follows"] = follow_by_quality(
            p, int(behavior.get("follow_per_session") or 1), not a.yes)
    except Exception as e:
        log(f"  关注阶段异常：{type(e).__name__}: {e}")
        rep["follows"] = []

    try:
        argv_backup = sys.argv
        sys.argv = ["x_session.py"] + (["--yes"] if a.yes else []) + \
                   (["--minutes", str(int(behavior.get("session_minutes") or 25))])
        try:
            rep["session_exit"] = session_mod.main()
        finally:
            sys.argv = argv_backup
    except Exception as e:
        log(f"  会话异常：{type(e).__name__}: {e}")
        rep["session_error"] = f"{type(e).__name__}: {e}"

    log("── 本轮结束 ──")
    return rep


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--cycles", type=int, default=0, help="0 = 一直跑")
    ap.add_argument("--base-min", type=float, default=40.0)
    ap.add_argument("--jitter", type=int, default=600)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rounds = 1 if a.once else (a.cycles or 10 ** 9)
    reps = []
    with XPage() as p:
        p.require_login()
        for i in range(rounds):
            try:
                reps.append(one_round(p, a))
            except Exception as e:
                log(f"[x] 本轮异常：{type(e).__name__}: {e}")
                reps.append({"error": f"{type(e).__name__}: {e}"})
                try:
                    p.ensure_home()
                except Exception:
                    pass
            if i + 1 >= rounds:
                break
            wait = a.base_min * 60 + random.uniform(-a.jitter, a.jitter)
            wait = max(300, wait)
            log(f"下一轮 {wait/60:.1f} 分钟后（{int(wait)}s）")
            time.sleep(wait)

    if a.json:
        print(json.dumps(reps, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
