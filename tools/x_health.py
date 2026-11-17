"""账号运营与健康：一次性体检，输出可读报告。

看的东西：
  · 主页数据（关注/粉丝/帖子数）
  · 新号引导清单（Let's get you set up）还差哪项
  · 有没有「Unlock more on X」受限提示
  · 今日各项动作次数 vs 每日上限（还能做多少）
  · 输入通道（真实鼠标 / 后台）与关键行为设置

用法：python tools/x_health.py [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pages.x_twitter import XPage
from xauto import behavior, input as xinput, limits, settings, store


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rep: dict = {}
    with XPage() as p:
        p.require_login()
        rep["account"] = p.whoami()
        rep["page"] = {"url": p.cdp.url()}
        if p.open_profile():
            time.sleep(1.5)
            rep["profile"] = p.cdp.evaluate_json("""
            const T = document.body.innerText || '';
            const g = re => { const m = T.match(re); return m ? m[1] : ''; };
            const items = [];
            for (const e of document.querySelectorAll('a, div[role="button"], button')) {
              const label = e.getAttribute('aria-label') || '';
              const txt = (e.innerText || '').replace(/\\s+/g, ' ').trim();
              if (/^(\\d+) left$/i.test(txt) || /^DONE$/i.test(txt))
                items.push({label: label.slice(0, 40), text: txt.slice(0, 40)});
            }
            return {
              following: g(/([\\d,]+)\\s*Following/),
              followers: g(/([\\d,]+)\\s*Follower/),
              posts: g(/([\\d,]+)\\s*posts/),
              unlockedNotice: /Unlock more on X/.test(T),
              checklist: [...new Map(items.map(i => [i.label + i.text, i])).values()],
            };
            """) or {}
        time.sleep(0.5)
        rep["limits"] = limits.load()
        rep["counters"] = store.summary()
        rep["behavior"] = behavior.load()
        rep["input"] = xinput.describe()
        rep["settings"] = settings.load()

    used = (rep.get("counters") or {}).get("today", {})
    left = {k: max(0, int(cap) - int(used.get(k, 0)))
            for k, cap in rep["limits"].items() if k in ("like", "reply", "follow", "mention")}
    rep["remaining"] = left

    print("═" * 46)
    print("账号体检")
    print("═" * 46)
    pr = rep.get("profile") or {}
    print(f"  @{rep['account'].get('handle','')}  "
          f"关注 {pr.get('following','?')} / 粉丝 {pr.get('followers','?')} / 帖子 {pr.get('posts','?')}")
    print(f"  受限提示：{'有（Unlock more on X）' if pr.get('unlockedNotice') else '没有'}")
    todo = [i for i in (pr.get("checklist") or []) if "left" in str(i.get("text", ""))]
    print(f"  引导清单：{'还差 ' + '、'.join(i['label'] or i['text'] for i in todo) if todo else '全部完成'}")
    print(f"  今日用量：{json.dumps(used, ensure_ascii=False)}")
    print(f"  还能做：{json.dumps(left, ensure_ascii=False)}")
    print(f"  输入通道：{'真实鼠标键盘' if rep['input']['mode'] == 'os' else '后台（不占鼠标）'}")
    b = rep["behavior"]
    print(f"  行为设置：语气={b['tone']} 风格={b['style']} 选帖={b['pick_strategy']} "
          f"间隔={b['reply_gap_min']}~{b['reply_gap_max']}s 打字={b['typing_ms']}ms/字")
    print(f"  休息：每回 {b['rest_after_replies']} 条休 {b['rest_minutes']} 分钟；"
          f"每日休息 {'开（' + b['daily_rest_start'] + ' 起 ' + str(b['daily_rest_minutes']) + ' 分钟）' if b['daily_rest_enabled'] else '关'}")
    print(f"  故障恢复：连续失败 {b['refresh_on_failures']} 次刷新（最多 {b['max_refresh']} 次），"
          f"{b['stop_after_failures'] or '∞'} 次后停止")
    print("═" * 46)
    if a.json:
        print(json.dumps(rep, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
