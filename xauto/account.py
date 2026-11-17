"""账号闸门：确认「这个浏览器实例登录的，就是这个档位该用的那个号」。

为什么必须有：现在有两个实例（9234 测试号 / 9235 正式号）。最容易出的事故不是
脚本写错，而是**档位和环境变量没对上**——以为在跑测试号，一条评论发到了正式号上；
或者反过来，正式号该干活的窗口里登着测试号，白刷一天。

规则（用户定的）：**不匹配就直接退出**，只提示不拦=没拦。
所以这里抛的是 AccountMismatch，工具侧不要 try 掉它。

期望值来自 config.ACCOUNT：
    环境变量 XAUTO_ACCOUNT  >  xauto/data/accounts.json {"test": "...", "prod": "..."}  >  空
空 = 不校验（第一次登录、还没绑定的时候用）。绑定用：
    python tools/x_instance.py prod --bind
"""

from __future__ import annotations

import json
from typing import Optional

from xauto import config


class AccountMismatch(RuntimeError):
    """当前页面登录的账号 ≠ 本档位期望的账号。"""


def normalize(handle: str) -> str:
    return str(handle or "").strip().lstrip("@").lower()


def current_handle(page) -> str:
    """从页面读当前登录 handle。读不到返回空串。

    whoami() 依赖左栏的 Profile 链接与账号切换按钮，登录态在但页面没渲染完时会拿不到，
    所以调用方可以重试（require 里就重试了几次）。
    """
    try:
        info = page.whoami() or {}
    except Exception:
        return ""
    return normalize(info.get("handle") or info.get("handle_text"))


def require(page, expected: Optional[str] = None, attempts: int = 6,
            settle: float = 1.5, allow_unset: bool = True) -> str:
    """校验当前账号是否是本档位期望的号；不一致抛 AccountMismatch。

    返回实际 handle。expected 为空且 allow_unset=True 时放行并提醒一次——
    刚登录还没绑定的第一次需要这个口子，绑定之后就不会再走到。
    """
    import time

    expected = normalize(expected if expected is not None else config.ACCOUNT)

    got = ""
    for i in range(attempts):
        got = current_handle(page)
        if got or i == attempts - 1:
            break
        time.sleep(settle)

    if not expected:
        if allow_unset:
            print(f"    [闸门] 本档位未绑定期望账号（当前 @{got or '未读到'}）。"
                  f"跑一次 tools/x_instance.py {config.INSTANCE} --bind 绑定。")
            return got
        raise AccountMismatch(f"{config.instance_banner()}：期望账号未设定，拒绝执行。")

    if not got:
        raise AccountMismatch(
            f"{config.instance_banner()}：读不到当前登录账号（页面没渲染完 / 未登录 / X 改版）。"
            f"闸门宁可不跑也不冒险，请确认该窗口已登录之后重跑。")

    if got != expected:
        raise AccountMismatch(
            f"{config.instance_banner()}：账号不匹配，已拒绝执行。\n"
            f"        这个浏览器窗口（端口 {config.CDP_PORT}，profile {config.PROFILE_DIR}）"
            f"登录的是 @{got}，但当前档位期望 @{expected}。\n"
            f"        要么切档位（$env:XAUTO_INSTANCE=...），要么把窗口里的账号换对，"
            f"要么重新绑定：python tools/x_instance.py {config.INSTANCE} --bind")

    return got


def bind(instance: str, handle: str) -> dict:
    """把某档位期望的账号写进 accounts.json。"""
    data: dict = {}
    try:
        if config.ACCOUNTS_FILE.exists():
            data = json.loads(config.ACCOUNTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    data[instance] = normalize(handle)
    config.ACCOUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.ACCOUNTS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data
