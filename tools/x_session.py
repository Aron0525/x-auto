"""浏览会话：严格按《X 新人浏览互动 SOP》执行。

SOP 的四个关键点，这个脚本逐条落实：

1. **浏览顺序（2.3）**：通知 → 关注时间线（Following）→ 推荐（For You）→（需要时）搜索
   而不是一进首页就在推荐里滑。
2. **三层阅读（2.2）**：大多数帖子只扫读（不点进去）；长帖/图文/引用/回复才展开；
   命中「互关诱饵、抽奖、套模板引流、来源不明链接」直接滑过。
3. **动作各自独立（0.2 / 14 节）**：点赞、评论、收藏分别独立判断，
   可以只赞、只评、只藏，也可以什么都不做。没有「先赞再评再关」的链条。
4. **时间盒（2.5）**：默认 25 分钟，到点就停。

用法：
    python tools/x_session.py                  # 只读浏览 + 独立的赞/评/藏（默认 dry-run）
    python tools/x_session.py --yes            # 真的执行
    python tools/x_session.py --yes --minutes 20
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage, XPageError
from xauto import behavior, comment as comment_gen, config, limits, runner, sop, store


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def handle_tweet(p: XPage, tw: dict, a, stats: dict, tracker) -> dict:
    """对一条帖子走一遍 SOP 决策树（14 节），每一步都可以「不做」。"""
    rec: dict = {"href": tw.get("href"), "text": (tw.get("text") or "")[:100]}

    skip, why = sop.should_skip(tw)
    if skip:
        rec["skip"] = why
        stats["skipped"] += 1
        return rec

    expand = sop.should_expand(tw)
    rec["expand"] = expand
    post = tw
    if expand:
        if not p.open_tweet_by_click(tw["href"]):
            rec["error"] = "详情打不开"
            tracker.fail("open")
            return rec
        detail = p.read_tweets(limit=1)
        post = detail[0] if detail else tw
        stats["expanded"] += 1

    # ---- 点赞：读懂且认可才赞（独立判断）----
    ok_like, why_like = sop.should_like(post)
    if ok_like and store.budget_left("like", limits.get("like")) > 0:
        if a.yes:
            r = p.like() if expand else p.like_in_timeline(tw["href"])
            rec["like"] = r
            if r.get("ok"):
                store.mark_like(tw["id"], {"href": tw["href"]})
                stats["liked"] += 1
                tracker.ok()
        else:
            rec["like"] = {"dry_run": True, "why": why_like}
            stats["liked"] += 1
    else:
        rec["like"] = {"skipped": why_like}

    # ---- 评论：先说得出「只有看过原帖才写得出来」的一句（独立判断）----
    ok_c, why_c = sop.should_comment(post)
    if ok_c and store.budget_left("reply", limits.get("reply")) > 0:
        gen = comment_gen.generate(post)
        rec["comment"] = gen
        text = (gen.get("text") or "").strip()
        if not text:
            rec["reply"] = {"skipped": gen.get("error") or "没有合格文案"}
        elif not expand:
            rec["reply"] = {"skipped": "扫读阶段不评论（SOP：没读完不评）"}
        elif a.yes:
            try:
                r = p.reply_current(text)
            except XPageError as e:
                r = {"ok": False, "error": str(e)}
            rec["reply"] = r
            if r.get("ok"):
                store.mark_tweet(tw["id"], {"href": tw["href"], "text": text[:120]})
                stats["commented"] += 1
                tracker.ok()
                runner.reply_gap()
                runner.rest_if_needed(stats["commented"])
        else:
            rec["reply"] = {"dry_run": True, "text": text}
            stats["commented"] += 1
    else:
        rec["reply"] = {"skipped": why_c}

    # ---- 收藏：只留给以后会用到的（独立判断）----
    ok_b, why_b = sop.should_bookmark(post)
    if ok_b and expand and a.yes:
        r = p.bookmark()
        rec["bookmark"] = r
        if r.get("ok"):
            stats["bookmarked"] += 1
            try:                                  # 记进收藏簿，供事后消化
                import tools.x_bookmarks as bm
                add = bm.add(tw["id"], post.get("text", ""), tw.get("href", ""))
                rec["bookmark"]["saved"] = add
            except Exception as e:
                rec["bookmark"]["save_error"] = str(e)
    else:
        rec["bookmark"] = {"dry_run": not a.yes, "why": why_b
                           if not ok_b else "需要展开页", "would": ok_b and expand}

    # ---- 关注：能说出理由才关（SOP 第 5 节，独立判断）----
    handle = (post.get("handle") or tw.get("handle") or "").strip()
    cap = int(behavior.get("follow_per_session") or 1)
    if not expand:
        rec["follow"] = {"skipped": "没读完（展开后才考虑关注）"}
    elif not handle:
        rec["follow"] = {"skipped": "拿不到作者 handle"}
    elif store.followed(handle):
        rec["follow"] = {"skipped": "已经关注过"}
    elif stats.get("followed", 0) >= cap:
        rec["follow"] = {"skipped": f"本次会话关注已达上限 {cap}"}
    elif sop.quality_score(post) < 2.0:
        rec["follow"] = {"skipped": "质量分不够，不值得关注"}
    elif store.budget_left("follow", limits.get("follow")) <= 0:
        rec["follow"] = {"skipped": "今日关注额度用完"}
    elif not a.yes:
        rec["follow"] = {"dry_run": True, "would": True}
    else:
        r = _try_follow_author(p, handle)
        rec["follow"] = r
        if r.get("ok"):
            store.mark_follow(handle, {"href": tw["href"], "reason": (r.get("reason") or "")[:60]})
            stats["followed"] = stats.get("followed", 0) + 1
            log(f"  ✓ 关注 @{handle}（{r.get('reason', '')[:40]}）")
            runner.reply_gap()
        else:
            log(f"  不关注 @{handle}：{r.get('reason') or r.get('state')}")

    # ---- 留档：读过什么、表过什么态（给以后 AI 复盘用）----
    try:
        acts: dict = {}
        if isinstance(rec.get("like"), dict) and rec["like"].get("ok"):
            acts["like"] = True
        if isinstance(rec.get("reply"), dict) and rec["reply"].get("ok"):
            acts["comment"] = ((rec.get("comment") or {}).get("text") or "")[:120]
        if isinstance(rec.get("bookmark"), dict) and rec["bookmark"].get("ok"):
            acts["bookmark"] = True
        if isinstance(rec.get("follow"), dict) and rec["follow"].get("ok"):
            acts["follow"] = handle
        if rec.get("skip"):
            acts["skip"] = rec["skip"]
        store.record_tweet(post if expand else tw, acts)
    except Exception:
        pass

    if expand:
        p.go_back()
        p.ensure_home()
    return rec


def _try_follow_author(p, handle: str) -> dict:
    """详情页点进作者主页：看简介 + 近期 5 条，SOP 校验通过才关注，然后返回详情页。"""
    out: dict = {"ok": False}
    link = "document.querySelector('[data-testid=\"User-Name\"] a[role=\"link\"]') || null"
    if not p.eval(f"return !!({link});"):
        out["state"] = "no-author-link"
        return out
    p._click_expr_human(link, settle=(0.8, 1.6))
    time.sleep(2.0)
    bio = p.eval(
        "(() => { const e = document.querySelector('[data-testid=\"ProfileBio\"]');"
        " return e ? e.innerText : ''; })()") or ""
    recent = p.read_tweets(limit=5)
    ok, reason = sop.should_follow({"bio": bio, "handle": handle}, recent,
                                   "浏览时质量分已达标")
    state = p.profile_follow_state()
    if state == "following":
        out.update(ok=True, state="already-following", reason="已关注")
        p.go_back()
        return out
    if not ok or state != "follow":
        out["state"] = "sop-reject" if not ok else "no-follow-button"
        out["reason"] = reason if not ok else "页面上没有关注按钮"
        p.go_back()
        return out
    btn = p._pick_expr('[data-testid$="-follow"]')
    p._click_expr_human(btn, settle=(0.8, 1.6))
    out["ok"] = p.profile_follow_state() == "following"
    out["state"] = "followed" if out["ok"] else "click-no-effect"
    out["reason"] = reason
    p.go_back()          # 回详情页（外层 handle_tweet 收尾还会再回主页）
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=None, help="时间盒（默认读行为设置）")
    ap.add_argument("--yes", action="store_true", help="真的执行写操作")
    ap.add_argument("--no-notif", action="store_true", help="跳过通知")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    minutes = a.minutes or float(behavior.get("session_minutes") or 25)
    start = time.time()
    deadline = start + minutes * 60
    # SOP 第 11 节的时间分配，按比例换算成这一段会话的预算
    p_notif = start + minutes * 60 * 0.20          # 0~20%：通知
    p_following = start + minutes * 60 * 0.60      # 20~60%：关注时间线
    p_foryou = start + minutes * 60 * 0.85         # 60~85%：推荐
    # 85%~100%：消化收藏 / 记原创角度
    stats = {"read": 0, "expanded": 0, "liked": 0, "commented": 0,
             "bookmarked": 0, "skipped": 0, "followed": 0}
    actions: list[dict] = []
    tracker = runner.FailureTracker()

    with XPage() as p:
        p.require_login()
        tracker.page = p
        log(f"SOP 会话开始：时间盒 {minutes:.0f} 分钟 ｜ {runner.summary_line()}")
        log(f"  动作独立性：点赞独立、评论独立、收藏独立；没有可做的就跳过")
        if not p.ensure_home():
            log("[!] 回不到首页")
            return 5

        # ---- 1) 通知优先（SOP 2.3 / 4.8）----
        me_h = (p.whoami().get("handle") or "").lstrip("@")
        if not a.no_notif and time.time() < deadline:
            runner.wait_out_daily_rest()
            try:
                if p.goto_notifications():
                    items = p.read_notifications(limit=15, me=me_h)
                    todo = []
                    for it in items:
                        need, why = sop.notification_needs_reply(it.get("text", ""))
                        if need and not store.seen_tweet(it["id"]):
                            todo.append(it)
                    log(f"通知：{len(items)} 条提及/回复，其中 {len(todo)} 条值得回")
                    for it in todo[:3]:
                        if time.time() >= min(deadline, p_notif):
                            log("  通知阶段时间到（SOP 11：通知只占前 20%）")
                            break
                        if not p.eval("return !!document.querySelector('[data-testid=\"cellInnerDiv\"]');"):
                            break
                        if not a.yes:
                            log(f"  [dry] 会回复 @{it['handle']}：{it['text'][:50]}")
                            continue
                        cell = ("[...document.querySelectorAll('[data-testid=\"cellInnerDiv\"]')]"
                                f".find(c => [...c.querySelectorAll('a[href*=\"/status/{it['id']}\"]')].length)"
                                "?.querySelector('a[href*=\"/status/\"]') || null")
                        if not p.eval(f"return !!({cell});"):
                            continue
                        p._click_expr_human(cell, settle=(0.9, 1.8))
                        detail = p.read_tweets(limit=1)
                        gen = comment_gen.generate(detail[0] if detail else {"text": it["text"]})
                        text = (gen.get("text") or "").strip()
                        if not text:
                            log(f"  [跳过] 没有合格回应：{gen.get('error')}")
                        else:
                            r = p.reply_current(text)
                            if r.get("ok"):
                                store.mark_tweet(it["id"], {"href": it.get("href"),
                                                            "text": text[:120],
                                                            "via": "notification"})
                                log(f"  ✓ 回复 @{it['handle']}：{text[:40]}")
                                runner.reply_gap()
                        p.goto_notifications()
            except Exception as e:
                log(f"通知处理异常：{type(e).__name__}: {e}")
                tracker.fail("notif")

        # ---- 2) 关注时间线 → 3) 推荐（SOP 2.3：先看已关注的人，再看推荐）----
        feed_deadline = {"following": p_following, "foryou": p_foryou}
        for feed in ("following", "foryou"):
            if time.time() >= min(deadline, feed_deadline[feed]):
                continue
            runner.wait_out_daily_rest()
            try:
                if not p.ensure_home():
                    break
                # 切到对应 tab（点界面，不输网址）
                tab_sel = ('[role="tab"]' if feed == "following" else '[role="tab"]')
                tab_expr = (f"[...document.querySelectorAll({tab_sel})]"
                            f".find(t => /Following/i.test(t.innerText || ''))"
                            if feed == "following" else
                            f"[...document.querySelectorAll({tab_sel})]"
                            f".find(t => /For you/i.test(t.innerText || ''))")
                if p.eval(f"return !!({tab_expr});"):
                    p._click_expr_human(tab_expr, settle=(0.8, 1.6))
                    time.sleep(2.0)
                log(f"—— 浏览 {('关注时间线' if feed == 'following' else '推荐 For You')} ——")

                seen: set[str] = set()
                while time.time() < min(deadline, feed_deadline[feed]):
                    tweets = p.read_tweets(limit=12)
                    fresh = [t for t in tweets if t["id"] not in seen]
                    if not fresh:
                        p.browse_scroll(1)
                        continue
                    for tw in fresh:
                        if time.time() >= deadline:
                            break
                        seen.add(tw["id"])
                        stats["read"] += 1
                        # 扫读时偶尔多停一会儿（真人在读）
                        time.sleep(random.uniform(1.2, 5.0))
                        rec = handle_tweet(p, tw, a, stats, tracker)
                        actions.append(rec)
                        if rec.get("skip"):
                            log(f"  滑过：{rec['skip']}")
                    p.browse_scroll(1)
            except runner.StopTask as e:
                log(f"[x] {e}")
                stats["stopped"] = str(e)
                break
            except Exception as e:
                log(f"[x] {type(e).__name__}: {e}")
                tracker.fail(str(e))

    # ---- 收尾：收藏消化 / 记原创角度（SOP 11 最后一段）----
    try:
        import tools.x_bookmarks as bm
        opened = [i for i in bm.load() if i.get("status") == "open"]
        stats["bookmarks_open"] = len(opened)
        if opened:
            log(f"收藏待消化 {len(opened)} 条（用 python tools/x_bookmarks.py --list 看）")
            for it in opened[:2]:
                log(f"  · [{it.get('category')}] {it.get('text','')[:60]}")
    except Exception as e:
        log(f"收藏消化阶段异常：{e}")

    log(f"结束：读 {stats['read']} 条，展开 {stats['expanded']}，"
        f"赞 {stats['liked']}，评 {stats['commented']}，藏 {stats['bookmarked']}，"
        f"关注 {stats.get('followed', 0)}，滑过 {stats['skipped']}"
        f"{'（dry-run）' if not a.yes else ''}｜帖子留档：data/tweets.jsonl")
    if a.json:
        print(json.dumps({"stats": stats, "actions": actions[-40:]},
                         indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
