"""x-auto 入口。

    python main.py ui            启动控制台（默认；浏览器开 http://127.0.0.1:9300）
    python main.py launch        启动带调试端口的浏览器实例（9234）
    python main.py session       直接跑一次 SOP 浏览会话（命令行模式）
    python main.py report        周复盘
    python main.py health        账号体检
    python main.py probe         环境自检（端口/登录/选择器）

控制台里能做的所有事，等价于下面这些工具：
    tools/x_session.py   SOP 会话（浏览 + 独立的赞/评/藏）
    tools/x_repeat.py    连续会话（多轮，默认不启用）
    tools/x_notif.py     回复通知（别人回我）
    tools/x_post.py      发帖（可 --topic 让模型写）
    tools/x_thread.py    从回复页互动原帖
    tools/x_dm.py        私信
    tools/x_follow.py    关注/取关
    tools/x_bookmarks.py 收藏消化
    tools/x_report.py    周复盘
    tools/x_health.py    账号运营与健康
    tools/x_query.py     数据查询
    tools/x_export.py    导出关注/页面用户
    tools/x_collect.py   从评论收集作者
    tools/x_delete.py    删除帖子
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def _py() -> str:
    return sys.executable or "python"


def _run(script: str, extra: list[str] | None = None) -> int:
    cmd = [_py(), str(ROOT / script)] + (extra or [])
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.call(cmd, cwd=str(ROOT), env=env)


MODES = {
    "ui": ("ui/server.py", ["--port", "9300"]),
    "launch": ("tools/x_launch.py", []),
    "instance": ("tools/x_instance.py", ["--status"]),
    "session": ("tools/x_session.py", []),
    "repeat": ("tools/x_repeat.py", []),
    "notif": ("tools/x_notif.py", []),
    "post": ("tools/x_post.py", []),
    "thread": ("tools/x_thread.py", []),
    "dm": ("tools/x_dm.py", []),
    "follow": ("tools/x_follow.py", []),
    "bookmarks": ("tools/x_bookmarks.py", ["--list"]),
    "report": ("tools/x_report.py", []),
    "health": ("tools/x_health.py", []),
    "query": ("tools/x_query.py", []),
    "export": ("tools/x_export.py", ["--following"]),
    "collect": ("tools/x_collect.py", []),
    "delete": ("tools/x_delete.py", ["--n", "1"]),
    "probe": ("tools/x_probe.py", []),
}


def main() -> int:
    ap = argparse.ArgumentParser(description="X 自动化（按《X新人浏览互动SOP》搭建）")
    ap.add_argument("mode", nargs="?", default="ui", choices=sorted(MODES),
                    help="要做什么（默认 ui）")
    ap.add_argument("extra", nargs=argparse.REMAINDER, help="透传给具体工具的参数")
    a = ap.parse_args()

    script, base = MODES[a.mode]
    args = base + [x for x in a.extra if x != "--"]
    print(f"[x-auto] mode={a.mode} → {script} {' '.join(args)}", file=sys.stderr)
    return _run(script, args)


if __name__ == "__main__":
    raise SystemExit(main())
