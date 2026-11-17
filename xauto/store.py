"""去重簿 / 状态存储：已经回复过谁、发过什么，落盘一次就够。

为什么必须有：
  - 时间线是滚动的，同一批帖子会反复出现在视野里
  - 重复回复同一个人 = 最像「机器人」的行为，也是最容易被限流的行为
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from xauto import config


def _load() -> dict:
    config.ensure_dirs()
    p: Path = config.STATE_FILE
    empty = {"replied_tweets": {}, "posted": [], "replied_dms": {},
             "liked": {}, "events": []}
    if not p.exists():
        return empty
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return empty
    for k, v in empty.items():
        d.setdefault(k, v)
    return d


def _save(d: dict) -> None:
    config.ensure_dirs()
    config.STATE_FILE.write_text(
        json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def seen_tweet(tweet_id: str) -> bool:
    return str(tweet_id) in _load()["replied_tweets"]


def mark_tweet(tweet_id: str, meta: dict | None = None) -> None:
    d = _load()
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    d["replied_tweets"][str(tweet_id)] = {"at": ts, **(meta or {})}
    d["events"].append({"kind": "reply", "at": ts, "id": str(tweet_id)})
    _save(d)


# ---------------- 点赞 ----------------

def liked(tweet_id: str) -> bool:
    return str(tweet_id) in _load()["liked"]


def mark_like(tweet_id: str, meta: dict | None = None) -> None:
    d = _load()
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    d["liked"][str(tweet_id)] = {"at": ts, **(meta or {})}
    d["events"].append({"kind": "like", "at": ts, "id": str(tweet_id)})
    _save(d)


# ---------------- 每日额度（风控纪律）----------------

def count_today(kind: str) -> int:
    """今天已经做了几次 kind（like / reply / dm / post）。"""
    today = time.strftime("%Y-%m-%d")
    d = _load()
    n = sum(1 for e in d["events"]
            if e.get("kind") == kind and str(e.get("at", "")).startswith(today))
    if kind == "post":                     # 帖子历史单独记在 posted 里
        n = sum(1 for p in d["posted"] if str(p.get("at", "")).startswith(today))
    if kind == "dm":
        n = sum(1 for v in d["replied_dms"].values()
                if str(v.get("at", "")).startswith(today))
    return n


def budget_left(kind: str, cap: int) -> int:
    return max(0, int(cap) - count_today(kind))


# ---------------- 关注（互关）----------------

def followed(handle: str) -> bool:
    return str(handle).lower() in _load().get("followed", {})


def mark_follow(handle: str, meta: dict | None = None) -> None:
    d = _load()
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    d.setdefault("followed", {})[str(handle).lower()] = {"at": ts, **(meta or {})}
    d["events"].append({"kind": "follow", "at": ts, "id": str(handle)})
    _save(d)


def seen_dm(conversation_key: str) -> bool:
    return str(conversation_key) in _load()["replied_dms"]


def mark_dm(conversation_key: str, meta: dict | None = None) -> None:
    d = _load()
    d["replied_dms"][str(conversation_key)] = {
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        **(meta or {}),
    }
    _save(d)


def mark_post(text: str, extra: dict | None = None) -> None:
    d = _load()
    d["posted"].append({"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "text": text[:120], **(extra or {})})
    _save(d)


def summary() -> dict:
    d = _load()
    return {
        "state_file": str(config.STATE_FILE),
        "replied_tweets": len(d["replied_tweets"]),
        "posted": len(d["posted"]),
        "replied_dms": len(d["replied_dms"]),
        "liked": len(d["liked"]),
        "followed": len(d.get("followed", {})),
        "today": {k: count_today(k) for k in ("like", "reply", "dm", "post", "follow")},
    }
