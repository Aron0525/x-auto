"""X 页面探针：先看清 DOM，再写选择器。别猜。

用法：
  python tools/x_probe.py --status            # 登录态 / 当前页 / 时间线条数
  python tools/x_probe.py --dom '[data-testid="tweetTextarea_0"]'   # 看某个元素的 DOM
  python tools/x_probe.py --timeline -n 5     # 抽时间线里前几条帖子（作者/正文/链接）
  python tools/x_probe.py --tree              # 发帖编辑器的祖先链（定容器用）
  python tools/x_probe.py --shot              # 存一张截图到 xauto/data/shots
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xauto import config, dom
from xauto.session import XSession


def show_status(s: XSession) -> None:
    st = s.status()
    print(json.dumps(st, indent=2, ensure_ascii=False))


def show_dom(s: XSession, selector: str, limit: int = 2500) -> None:
    html = s.cdp.evaluate(
        f"(document.querySelector({dom.js(selector)}) || {{}}).outerHTML || ''") or ""
    print(html[:limit] if html else "(没找到该元素)")


def show_tree(s: XSession, selector: str, depth: int = 6) -> None:
    """打印元素到 body 的祖先链，带关键属性（data-testid / role / class 前 40 字）。"""
    js = f"""
    let el = document.querySelector({dom.js(selector)});
    if (!el) return null;
    const out = [];
    for (let i = 0; i < {depth} && el; i++) {{
      out.push({{
        tag: el.tagName,
        tid: el.getAttribute('data-testid'),
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        cls: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 60),
        ce: el.isContentEditable,
      }});
      el = el.parentElement;
    }}
    return out;
    """
    print(json.dumps(s.cdp.evaluate("(() => {" + js + "})()"), indent=2, ensure_ascii=False))


def show_timeline(s: XSession, n: int = 5) -> None:
    js = f"""
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, {n});
    const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
    return arts.map(a => {{
      const txt = a.querySelector('[data-testid="tweetText"]');
      const userBlock = a.querySelector('[data-testid="User-Name"]');
      const links = [...a.querySelectorAll('a[href*="/status/"]')].map(x => x.getAttribute('href'));
      const timeEl = a.querySelector('time');
      const social = a.querySelector('[data-testid="socialContext"]');
      return {{
        text: clean(txt && txt.innerText).slice(0, 200),
        user: clean(userBlock && userBlock.innerText).slice(0, 80),
        link: links[0] || '',
        t: timeEl ? timeEl.getAttribute('datetime') : '',
        social: clean(social && social.innerText).slice(0, 60),
        reply_btn: !!a.querySelector('[data-testid="reply"]'),
        is_pinned_or_retweet: !!a.querySelector('[data-testid="socialContext"]'),
      }};
    }});
    """
    data = s.cdp.evaluate("(() => {" + js + "})()") or []
    print(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\n共抓到 {len(data)} 条")


def do_shot(s: XSession) -> None:
    config.ensure_dirs()
    p = config.SHOT_DIR / f"probe-{int(time.time())}.png"
    ok = s.cdp.screenshot(str(p))
    print(("已存 " if ok else "截图失败 ") + str(p))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--dom")
    ap.add_argument("--tree")
    ap.add_argument("--timeline", action="store_true")
    ap.add_argument("-n", type=int, default=5)
    ap.add_argument("--shot", action="store_true")
    a = ap.parse_args()

    s = XSession()
    try:
        s.connect()
    except Exception as e:
        print(f"[x] {e}", file=sys.stderr)
        return 2

    try:
        if a.dom:
            show_dom(s, a.dom)
        elif a.tree:
            show_tree(s, a.tree)
        elif a.timeline:
            show_timeline(s, a.n)
        elif a.shot:
            do_shot(s)
        else:
            show_status(s)
    finally:
        s.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
