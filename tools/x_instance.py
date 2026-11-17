r"""档位实例管理：一键起 test/prod 的浏览器，绑定/核对「这个实例登录的是哪个号」。

它是所有「跟档位有关但不属于具体功能」的入口：
  python tools/x_instance.py prod                  # 起正式号实例（9235 / C:\x-edge-9235），开 x.com 等登录
  python tools/x_instance.py test                  # 起测试号实例（9234），行为同 x_launch.py
  python tools/x_instance.py prod --bind           # 从页面读当前 handle，写进 data/accounts.json[prod]
  python tools/x_instance.py --status              # 两个档位总览：端口 / profile / 登录态 / 账号

--bind 为什么重要：账号闸门（xauto/account.py）靠「期望值」和「页面实际值」对账。
期望值第一次得从你确认过没登错的那个窗口里读出来——登录好，跑一次 --bind，闭环。

起 prod 实例时，数据目录（xauto/data/prod）会带着默认的行为/额度设置出生：
从 test 的数据目录复制一份当起点，之后两边各自演化，互不影响。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 位置参数里的档位必须在 import config 之前进环境变量（config 导入时就把档位解析成端口/profile/数据目录）
_argv = sys.argv[1:]
for _i, _a in enumerate(_argv):
    if _a in ("test", "prod"):
        os.environ["XAUTO_INSTANCE"] = _a
        break
    if _a.startswith("--instance="):
        os.environ["XAUTO_INSTANCE"] = _a.split("=", 1)[1]
        break
    if _a == "--instance" and _i + 1 < len(_argv):
        os.environ["XAUTO_INSTANCE"] = _argv[_i + 1]
        break

from xauto import account, config  # noqa: E402

INSTANCE_PORTS = {"test": 9234, "prod": 9235}
INSTANCE_PROFILES = {"test": r"C:\x-edge-9234", "prod": r"C:\x-edge-9235"}
_TEST_DATA = config.PKG_DIR / "data"            # 可编辑配置的「出生地」
_FILENAMES = ("behavior.json", "limits.json", "settings.json")


def seed_data(instance: str) -> None:
    """新档位的数据目录出生：复制 test 的可编辑配置当起点，建好子目录。"""
    if instance == "test":
        return
    dest = _TEST_DATA / "prod"
    dest.mkdir(parents=True, exist_ok=True)
    for sub in ("shots", "exports", "ui-runs"):
        (dest / sub).mkdir(exist_ok=True)
    for fn in _FILENAMES:
        src, dst = _TEST_DATA / fn, dest / fn
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
            print(f"    [seed] {fn} → data/prod/（起点=测试号配置，之后独立演化）")


def _peek(port: int) -> dict:
    """连到指定端口看一眼登录态和账号（不影响全局 config）。"""
    from core.cdp import Cdp
    from xauto.session import port_alive, list_targets

    row = {"alive": False}
    if not port_alive(port):
        return row
    row["alive"] = True
    targets = [t for t in list_targets(port)
               if any(h in (t.get("url") or "") for h in config.TARGET_HINTS)]
    if not targets:
        row.update({"logged_in": False, "handle": "", "url": ""})
        return row
    cdp = Cdp(f"http://127.0.0.1:{port}")
    try:
        cdp.attach(targets[0])
        js = """
        const q = s => document.querySelector(s);
        const sw = q('[data-testid="SideNav_AccountSwitcher_Button"]');
        const pf = q('a[data-testid="AppTabBar_Profile_Link"]');
        return {
          logged_in: !!sw,
          handle: pf ? (pf.getAttribute('href') || '').replace('/', '') : '',
          url: location.href,
        };
        """
        d = cdp.evaluate_json(js) or {}
        row.update({"logged_in": bool(d.get("logged_in")),
                    "handle": account.normalize(d.get("handle", "")),
                    "url": (d.get("url") or "")[:60]})
    except Exception as e:
        row["error"] = str(e)[:80]
    finally:
        try:
            cdp.close()
        except Exception:
            pass
    return row


def _expected(instance: str) -> str:
    try:
        if config.ACCOUNTS_FILE.exists():
            d = json.loads(config.ACCOUNTS_FILE.read_text(encoding="utf-8"))
            return account.normalize(str(d.get(instance, "") or ""))
    except Exception:
        pass
    return ""


def status_all() -> int:
    """两个档位各是什么状态，一眼看清。"""
    print(f"{'档位':<7}{'端口':<7}{'实例':<7}{'登录':<6}{'当前账号':<20}{'期望账号':<20}")
    print("-" * 82)
    for inst in ("test", "prod"):
        r = _peek(INSTANCE_PORTS[inst])
        alive = "运行中" if r["alive"] else "未启动"
        logged = ("是" if r.get("logged_in") else "否") if r["alive"] else "-"
        exp = _expected(inst)
        print(f"{inst:<7}{INSTANCE_PORTS[inst]:<7}{alive:<7}{logged:<6}"
              f"{'@' + (r.get('handle') or '-'):<20}{'@' + exp if exp else '(未绑定)':<20}")
        if r["alive"] and not r.get("logged_in"):
            print(f"    [!] 该窗口没登录 X。profile: {INSTANCE_PROFILES[inst]}")
        if exp and r.get("handle") and r["handle"] != exp:
            print(f"    [!!] 账号不匹配：窗口 @{r['handle']} ≠ 期望 @{exp} —— 此档位工具会拒跑（闸门）")
    return 0


def bind(instance: str) -> int:
    """把当前页面读到的 handle 绑定为该档位的期望账号（绑定动作本身跳过闸门）。"""
    from pages.x_twitter import XPage
    os.environ["XAUTO_NO_GATE"] = "1"           # 绑定的语义就是「读实际值」，不能被旧期望值拦
    try:
        with XPage() as p:
            p.require_login()
            got = ""
            for _ in range(6):
                got = account.current_handle(p)
                if got:
                    break
                time.sleep(1.5)
    finally:
        os.environ.pop("XAUTO_NO_GATE", None)
    if not got:
        print("[x] 读不到当前账号：页面可能没渲染完。在窗口里打开 https://x.com/home 再试。",
              file=sys.stderr)
        return 1
    prev = _expected(instance)
    account.bind(instance, got)
    print(f"[ok] 档位 {instance} 绑定账号：@{got}")
    if prev and prev != got:
        print(f"     （原来绑的是 @{prev}，已覆盖）")
    print(f"     写入 {config.ACCOUNTS_FILE}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("instance", nargs="?", choices=("test", "prod"),
                    default=config.INSTANCE, help="要操作哪个档位（默认看 XAUTO_INSTANCE）")
    ap.add_argument("--status", action="store_true", help="两个档位总览")
    ap.add_argument("--bind", action="store_true", help="把当前页面账号绑定为该档位期望账号")
    ap.add_argument("--url", default="https://x.com/home")
    a = ap.parse_args()

    if a.status:
        return status_all()

    if a.bind:
        # 用档位对应的端口重新解析连接目标：绑定永远绑「命令行说的那个档位」
        os.environ["XAUTO_PORT"] = str(INSTANCE_PORTS[a.instance])
        os.environ["XAUTO_PROFILE"] = INSTANCE_PROFILES[a.instance]
        import importlib
        importlib.reload(config)
        return bind(a.instance)

    seed_data(a.instance)
    print(f"[>] 档位={a.instance}（{config.INSTANCE_LABELS[a.instance]}） "
          f"端口={INSTANCE_PORTS[a.instance]} profile={INSTANCE_PROFILES[a.instance]}")
    from tools import x_launch as xl
    # prod 窗口往右摆，和 test 并排时肉眼就能分；标题带账号后双窗口互不混淆
    x = 60 if a.instance == "test" else 720
    rc = xl.launch(INSTANCE_PORTS[a.instance], INSTANCE_PROFILES[a.instance], a.url, x=x)
    if rc == 0:
        exp = _expected(a.instance)
        print(f"\n[i] 这个窗口的账号闸门期望值：{'@' + exp if exp else '未绑定'}")
        if not exp:
            print(f"    登录好之后跑：python tools/x_instance.py {a.instance} --bind")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
