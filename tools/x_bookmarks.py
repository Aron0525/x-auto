"""收藏管理：SOP 第 6 节要求「分类 + 事后消化」，不能让收藏夹变成堆积处。

收藏时记一条（帖子 id / 摘要 / 分类 / 时间），消化时把它标成 used 或 dropped。
分类按 SOP 的五个方向。

用法：
    python tools/x_bookmarks.py --list              # 看还没消化的
    python tools/x_bookmarks.py --digest 3          # 标记前 3 条为已消化
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xauto import config

FILE = config.DATA_DIR / "bookmarks.json"

CATEGORIES = {
    "tool": "工具对照",        # 写体验前要回去看的用法/限制/竞品
    "knowledge": "知识待消化",  # 概念、框架、反例
    "social": "社会观察",      # 有事实线索、值得再想的现象
    "question": "问题清单",     # 别人问得好，或可展开的问题
    "pending": "待核实",       # 有用但来源没核对
}


def load() -> list[dict]:
    try:
        if FILE.exists():
            return json.loads(FILE.read_text(encoding="utf-8")).get("items", [])
    except Exception:
        pass
    return []


def save(items: list[dict]) -> None:
    config.ensure_dirs()
    FILE.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=2),
                    encoding="utf-8")


def guess_category(text: str) -> str:
    t = text or ""
    if any(k in t for k in ("工具", "产品", "插件", "app", "软件", "对比", "价格")):
        return "tool"
    if any(k in t for k in ("数据", "统计", "研究", "报道", "现象", "趋势")):
        return "social"
    if any(k in t for k in ("怎么", "为什么", "有没有", "？", "?")):
        return "question"
    if any(k in t for k in ("来源", "出处", "待核实", "据说", "听说")):
        return "pending"
    return "knowledge"


def add(tweet_id: str, text: str, href: str = "", category: str | None = None) -> dict:
    items = load()
    if any(i.get("id") == tweet_id for i in items):
        return {"ok": True, "already": True}
    items.append({"id": tweet_id, "text": (text or "")[:160], "href": href,
                  "category": category or guess_category(text),
                  "at": time.strftime("%Y-%m-%d %H:%M:%S"), "status": "open"})
    save(items)
    return {"ok": True, "added": True}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--digest", type=int, default=0, help="把前 N 条标为已消化")
    ap.add_argument("--dump", type=int, default=0, help="把前 N 条标记为不再需要")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    items = load()
    opened = [i for i in items if i.get("status") == "open"]

    if a.digest or a.dump:
        targets = opened[:max(a.digest, a.dump)]
        for it in targets:
            it["status"] = "used" if a.digest else "dropped"
            it["digested_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        save(items)
        print(f"[=] 处理 {len(targets)} 条：{'已消化' if a.digest else '不再需要'}")

    if a.list or not (a.digest or a.dump):
        print(f"未消化收藏：{len(opened)} 条（共 {len(items)} 条记录）")
        for it in opened[:20]:
            print(f"  [{CATEGORIES.get(it.get('category'), it.get('category'))}] "
                  f"{it.get('at')}  {it.get('text')[:70]}")
    if a.json:
        print(json.dumps({"open": len(opened), "total": len(items),
                          "items": opened[:20]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
