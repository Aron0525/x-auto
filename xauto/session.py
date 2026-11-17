"""会话层：连到 9234 那个实例里的 X 页面，并判定登录态 / 页面就位。

和 BOSS 侧的 BrowserSession 同构，但只管 X：
  - connect() 找 target（x.com 或 twitter.com），附着后返回 Cdp
  - 不做任何 *.enable，页面长期存活
"""

from __future__ import annotations

import json
import random
import time
import urllib.request
from typing import Any

from core.cdp import Cdp, CdpError
from xauto import config


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def port_alive(port: int | None = None, timeout: float = 3.0) -> dict | None:
    port = port or config.CDP_PORT
    try:
        raw = _opener().open(f"http://127.0.0.1:{port}/json/version",
                             timeout=timeout).read()
        return json.loads(raw)
    except Exception:
        return None


def list_targets(port: int | None = None) -> list[dict]:
    port = port or config.CDP_PORT
    try:
        raw = _opener().open(f"http://127.0.0.1:{port}/json/list",
                             timeout=4.0).read()
        return [t for t in json.loads(raw) if t.get("type") == "page"]
    except Exception:
        return []


def random_sleep(a: float, b: float) -> float:
    d = random.uniform(a, b)
    time.sleep(d)
    return d


class XSession:
    """一个 X 页面会话。用完只断 CDP，不动浏览器。"""

    def __init__(self, cdp_url: str | None = None):
        self.cdp_url = cdp_url or config.CDP_URL
        self.cdp = Cdp(self.cdp_url)

    # ---------- 连接 ----------

    def connect(self) -> Cdp:
        ver = port_alive(config.CDP_PORT)
        if not ver:
            raise RuntimeError(
                f"端口 {config.CDP_PORT} 上没有浏览器。先跑："
                f"python tools/x_launch.py")
        targets = self.cdp.list_targets()
        hit = None
        for t in targets:
            url = (t.get("url") or "")
            if any(h in url for h in config.TARGET_HINTS):
                hit = t
                break
        if hit is None:
            raise RuntimeError(
                "调试浏览器里没有 X 页面。在窗口里打开 https://x.com/home ，或跑 "
                "python tools/x_launch.py")
        self.cdp.attach(hit)
        return self.cdp

    def disconnect(self) -> None:
        self.cdp.close()

    # ---------- 页面状态 ----------

    def title(self) -> str:
        return self.cdp.title()

    def url(self) -> str:
        return self.cdp.url()

    def goto(self, url: str, wait: float = 2.5) -> None:
        """页内跳转。

        坑（2026-11-16 实测）：直接 evaluate 一句 `location.assign(...)` 会挂死 ——
        页面一开始跳转，执行上下文就被销毁，那条 Runtime.evaluate 永远等不到回复，
        最后以 websocket 超时收场（发帖其实已经成功，报错却像是失败）。
        解法：用 setTimeout 把跳转推迟一拍，让 evaluate 先拿到返回值再离开。
        """
        self.cdp.evaluate(
            f"setTimeout(() => location.assign({json.dumps(url)}), 30); 'scheduled';")
        time.sleep(wait)

    def status(self) -> dict:
        js = """
        const q = s => document.querySelector(s);
        const href = location.href;
        return {
          href: href,
          ready: document.readyState,
          title: document.title,
          logged_in: !!q('[data-testid="SideNav_AccountSwitcher_Button"]'),
          on_login: /\\/i\\/flow\\/login|\\/login/.test(href),
          has_composer_entry: !!q('[data-testid="SideNav_NewTweet_Button"]'),
          tweet_count: document.querySelectorAll('article[data-testid="tweet"]').length,
          nav: [...document.querySelectorAll('nav a')].map(a => a.getAttribute('href')).filter(Boolean),
        };
        """
        try:
            return self.cdp.evaluate_json(js) or {}
        except CdpError as e:
            return {"error": str(e)}

    def is_logged_in(self) -> bool:
        return bool(self.status().get("logged_in"))

    def wait_logged_in(self, timeout: float = 300.0, interval: float = 3.0) -> bool:
        """等人手动登录完（轮询登录态）。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.is_logged_in():
                return True
            time.sleep(interval)
        return False

    def browser_name(self) -> str:
        try:
            ua = self.cdp.evaluate("navigator.userAgent") or ""
        except CdpError:
            ua = ""
        return "Microsoft Edge" if "Edg/" in ua else ("Google Chrome" if "Chrome/" in ua else "未知浏览器")
