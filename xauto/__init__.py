"""X / 推特自动化层：配置 + 会话 + DOM 工具 + 拟人输入 + 评论生成 + 去重簿。

依赖说明：浏览器层（`core.cdp` / `core.cdpinput` / `message.llm`）来自只读仓库
boss-auto-greet，由 `xauto.bootstrap` 挂到 sys.path 上（见该文件注释）。

设计原则（继承那边的实战结论，别改）：
  1. 页面读写只走 core.cdp.Cdp.evaluate —— 只调 Runtime.evaluate，绝不 *.enable
  2. 点击/输入优先走 core.cdpinput（CDP 派发事件，不占真实鼠标、不抢前台）
  3. 真人节奏：每步随机停顿，批量任务必设限额
"""

from __future__ import annotations

from xauto import bootstrap  # noqa: F401  —— 副作用：把只读依赖接进 sys.path

__all__ = ["config", "session", "dom", "typing", "store", "comment", "bootstrap"]
