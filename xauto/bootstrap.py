"""外部只读依赖桥接。

X 这一层要复用 boss-auto-greet 里的浏览器层（`core.cdp` / `core.cdpinput` / `message.llm`）。
那个仓库是**只读**的：我们只 import，绝不往里写文件。

所以把它的根目录挂到 sys.path 上（可用环境变量 BOSS_AUTO_GREET_ROOT 覆盖）。
任何 `from xauto import ...` 都会先跑一次 ensure()，保证后面 import core.* 能找到。
"""

from __future__ import annotations

import os
import sys

BOSS_ROOT = os.environ.get("BOSS_AUTO_GREET_ROOT", r"D:\dev\01-owned\boss-auto-greet")


def ensure() -> str:
    """把 boss-auto-greet 根目录加进 sys.path（只读引用）。"""
    root = (BOSS_ROOT or "").strip()
    if root and os.path.isdir(root) and root not in sys.path:
        sys.path.insert(0, root)
    return root


ensure()
