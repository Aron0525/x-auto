"""任务运行时：节奏、休息、故障恢复。

所有工具共用这一套，保证行为设置里的参数真的生效：
  · reply_gap_min/max   —— 两次写操作之间的间隔
  · rest_after_replies  —— 每回复 N 条强制休息 rest_minutes
  · daily_rest_enabled  —— 每日定时休息（在窗口内直接等/跳过）
  · refresh_on_failures / max_refresh / stop_after_failures —— 连续失败的处理
"""

from __future__ import annotations

import random
import time

from xauto import behavior, config

try:
    from xauto import input as xinput
except Exception:                 # 极早期导入时可能还没有
    xinput = None


class StopTask(RuntimeError):
    """连续失败到阈值、需要停掉整个任务。"""


class FailureTracker:
    """连续失败计数 → 刷新页面 / 停止任务。"""

    def __init__(self, page=None):
        self.page = page
        self.failures = 0
        self.refreshes = 0

    def ok(self) -> None:
        self.failures = 0
        self.refreshes = 0

    def fail(self, why: str = "") -> None:
        self.failures += 1
        need_refresh = int(behavior.get("refresh_on_failures") or 0)
        max_refresh = int(behavior.get("max_refresh") or 0)
        stop_after = int(behavior.get("stop_after_failures") or 0)

        if need_refresh and self.failures % need_refresh == 0 and self.refreshes < max_refresh:
            self.refreshes += 1
            print(f"    [恢复] 连续失败 {self.failures} 次，刷新页面（第 {self.refreshes}/{max_refresh} 次）")
            self.refresh()
        if stop_after and self.failures >= stop_after:
            raise StopTask(f"连续失败 {self.failures} 次（{why}），按设置停止任务")

    def refresh(self) -> None:
        """刷新页面（故障恢复用；这是刷新，不是输网址跳转）。"""
        if not self.page or not getattr(self.page, "cdp", None):
            return
        try:
            self.page.cdp.evaluate("setTimeout(() => location.reload(), 30); 'scheduled';")
            time.sleep(random.uniform(6.0, 9.0))
            try:
                self.page.ensure_home()
            except Exception:
                pass
        except Exception:
            pass


def reply_gap() -> float:
    lo = float(behavior.get("reply_gap_min") or 20)
    hi = float(behavior.get("reply_gap_max") or 90)
    if hi < lo:
        hi = lo
    d = random.uniform(lo, hi)
    time.sleep(d)
    return d


def rest_if_needed(done_replies: int) -> bool:
    """每回复 N 条后休息一次。返回是否休息了。"""
    n = int(behavior.get("rest_after_replies") or 0)
    if n <= 0 or done_replies <= 0 or done_replies % n != 0:
        return False
    minutes = float(behavior.get("rest_minutes") or 0)
    if minutes <= 0:
        return False
    print(f"    [休息] 已回复 {done_replies} 条，休息 {minutes:.0f} 分钟")
    time.sleep(minutes * 60)
    return True


def in_daily_rest(now: float | None = None) -> bool:
    """现在是否处于「每日定时休息」窗口内。"""
    if not behavior.get("daily_rest_enabled"):
        return False
    minutes = float(behavior.get("daily_rest_minutes") or 0)
    if minutes <= 0:
        return False
    start = str(behavior.get("daily_rest_start") or "02:00")
    try:
        hh, mm = [int(x) for x in start.split(":")[:2]]
    except Exception:
        return False
    now = now or time.time()
    lt = time.localtime(now)
    start_ts = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, hh, mm, 0, 0, 0, -1))
    if start_ts > now:                     # 今天还没开始，看昨天那段是否跨到今天
        start_ts -= 86400
    return start_ts <= now < start_ts + minutes * 60


def wait_out_daily_rest(poll: float = 60.0) -> None:
    """如果在每日休息窗口内，就等到窗口结束。"""
    if not in_daily_rest():
        return
    print(f"    [休息] 处于每日定时休息窗口，等待结束…")
    while in_daily_rest():
        time.sleep(poll)
    print("    [休息] 每日休息结束，继续")


def summary_line() -> str:
    b = behavior.load()
    return (f"语气={b['tone']} 风格={b['style']} 选帖={b['pick_strategy']} "
            f"回复间隔={b['reply_gap_min']}~{b['reply_gap_max']}s "
            f"打字={b['typing_ms']}ms/字")
