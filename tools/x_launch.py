r"""拉起（或复用）一个带 CDP 调试端口的浏览器实例，专供 X / 推特自动化。

设计要点（和 start_browser.bat 一套思路，但可重入、可探测）：
  1. 先探测端口：已经在跑就直接报告，不再拉第二个进程（否则会抢不到端口、静默失败）
  2. profile 固定——登录态存在这个目录里，换目录等于换账号
  3. 两个档位（9222/9223 已给 BOSS 项目占用，错开避免互相踩）：
       test → 9234 / C:\x-edge-9234（测试号）
       prod → 9235 / C:\x-edge-9235（正式运作号）
     选档位：--instance prod，或环境变量 XAUTO_INSTANCE=prod；不写=test，与旧版一致

用法：
  python tools/x_launch.py                          # test 档位：起 9234
  python tools/x_launch.py --instance prod          # prod 档位：起 9235
  python tools/x_launch.py --status                 # 只报告现状
  python tools/x_launch.py --url https://x.com/messages
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# 本地 CDP 必须绕开系统代理
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# --instance 必须在 import config 之前生效（config 在导入时就把档位解析成端口/profile/数据目录）
for _i, _arg in enumerate(sys.argv):
    if _arg == "--instance" and _i + 1 < len(sys.argv):
        os.environ["XAUTO_INSTANCE"] = sys.argv[_i + 1]
    elif _arg.startswith("--instance="):
        os.environ["XAUTO_INSTANCE"] = _arg.split("=", 1)[1]

from xauto import config  # noqa: E402  —— 档位→端口/profile 的映射只在 config 一处定义

DEFAULT_PORT = config.CDP_PORT
DEFAULT_PROFILE = config.PROFILE_DIR
DEFAULT_URL = "https://x.com/home"

_PROFILE_DIR_CACHE: dict[str, str] = {}


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def probe(port: int = DEFAULT_PORT, timeout: float = 3.0) -> dict | None:
    """端口上有活着的 CDP 就返回 /json/version，否则 None。"""
    try:
        raw = _opener().open(f"http://127.0.0.1:{port}/json/version",
                            timeout=timeout).read()
        return json.loads(raw)
    except Exception:
        return None


def list_targets(port: int = DEFAULT_PORT, timeout: float = 3.0) -> list[dict]:
    try:
        raw = _opener().open(f"http://127.0.0.1:{port}/json/list",
                             timeout=timeout).read()
        return [t for t in json.loads(raw) if t.get("type") == "page"]
    except Exception:
        return []


def find_browser() -> str | None:
    cands = [
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def launch(port: int = DEFAULT_PORT, profile: str = DEFAULT_PROFILE,
           url: str = DEFAULT_URL, width: int = 1320, height: int = 940,
           x: int = 60, y: int = 40) -> int:
    ver = probe(port)
    if ver:
        print(f"[ok] 端口 {port} 已经在跑：{ver.get('Browser')}")
        for t in list_targets(port):
            print(f"     - {t.get('title','')[:40]} | {t.get('url','')[:80]}")
        print("[i] 复用现有实例；如需重开请先关掉那个浏览器窗口。")
        return 0

    exe = find_browser()
    if not exe:
        print("[x] 没找到 Edge / Chrome，装一个再来。", file=sys.stderr)
        return 2

    Path(profile).mkdir(parents=True, exist_ok=True)
    args = [
        exe,
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        f"--window-position={x},{y}",
        f"--window-size={width},{height}",
        url,
    ]
    print(f"[>] {Path(exe).name}  port={port}  profile={profile}")
    subprocess.Popen(args, close_fds=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for _ in range(40):                      # 最多等 20 秒
        time.sleep(0.5)
        ver = probe(port)
        if ver:
            print(f"[ok] CDP 就绪：{ver.get('Browser')}")
            for t in list_targets(port):
                print(f"     - {t.get('title','')[:40]} | {t.get('url','')[:80]}")
            print("\n[i] 如果这是全新 profile，请在弹出来的窗口里登录 X（登录态会存进上面那个目录）。")
            return 0
    print("[x] 端口起来了但 CDP 没响应；可能端口被别人占了。", file=sys.stderr)
    return 3


def report(port: int = DEFAULT_PORT) -> int:
    ver = probe(port)
    if not ver:
        print(f"[i] 端口 {port} 无响应（实例没起，或已关闭）。")
        return 1
    print(f"[ok] {ver.get('Browser')} @ {port}")
    for t in list_targets(port):
        print(f"  - {t.get('title','')[:50]}")
        print(f"    {t.get('url','')}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", choices=("test", "prod"),
                    help="档位：test=9234（测试号），prod=9235（正式号）；默认看环境变量 XAUTO_INSTANCE")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    return report(a.port) if a.status else launch(a.port, a.profile, a.url)


if __name__ == "__main__":
    raise SystemExit(main())
