"""依赖桥接：把浏览器/LLM 层挂进 sys.path。

2026-11-17 起改为 **vendor 优先**：
  1. 先挂本项目 `vendor/`（core.cdp / core.cdpinput / core.human / message.llm 的本地快照）
     —— 日常运行完全不依赖外部仓库，BOSS 那边改什么都影响不到这里。
  2. `BOSS_AUTO_GREET_ROOT` 只作为兜底：万一 vendor 缺失（比如刚 clone 漏了目录），
     还能回退到旧的共用方式，并在 stderr 提示一次。

import 名保持不变（`core.*` / `message.*`），所以业务代码零改动，只是解析位置变了。
vendor 快照的来源与升级规矩见 vendor/README.md。
"""

from __future__ import annotations

import os
import sys

VENDOR_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")
BOSS_ROOT = os.environ.get("BOSS_AUTO_GREET_ROOT", r"D:\dev\01-owned\boss-auto-greet")

_warned = False


def ensure() -> str:
    """优先返回 vendor 根目录；vendor 不完整时回退到 BOSS 仓库并提示。"""
    global _warned
    need = (os.path.join("core", "cdp.py"), os.path.join("message", "llm.py"))
    if all(os.path.exists(os.path.join(VENDOR_ROOT, p)) for p in need):
        if VENDOR_ROOT not in sys.path:
            sys.path.insert(0, VENDOR_ROOT)
        return VENDOR_ROOT

    if not _warned:
        _warned = True
        print("[!] vendor/ 快照不完整，回退到外部仓库（BOSS）："
              "代码层隔离失效，请尽快恢复 vendor/ 目录", file=sys.stderr)
    root = (BOSS_ROOT or "").strip()
    if root and os.path.isdir(root) and root not in sys.path:
        sys.path.insert(0, root)
    return root


ensure()
