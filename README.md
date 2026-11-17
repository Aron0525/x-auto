# x-auto

按《X 新人浏览互动 SOP》搭建的 X（推特）浏览与互动自动化，带本地控制台 UI。

> 设计前提：**这个工具不做"刷量"。** 它把 SOP 里"先读懂、再决定要不要赞/评/藏/关"的判断
> 落成可执行规则，动作彼此独立，没有可做的动作就跳过。

## 快速开始

```bash
# 1. 启动带调试端口的浏览器（独立 profile，首次需手动登录）
python main.py launch

# 2. 启动控制台（浏览器打开 http://127.0.0.1:9300）
python main.py ui
```

控制台里能做的所有事都有命令行等价物（`python main.py <mode>`）：
`session / repeat / notif / post / thread / dm / follow / bookmarks / report / health / query / export / collect / delete / probe`。

## 两种输入方式（UI 可随时切换）

| 模式 | 行为 | 代价 |
|---|---|---|
| `os` 真实鼠标键盘 | `SendInput`：贝塞尔轨迹移动 + 按下松开 + 滚轮 + 逐字按键 | 会占用真实光标，窗口需在前台 |
| `cdp` 后台模式（默认） | `Input.dispatchMouseEvent` / `insertText` | 不动真实光标；窗口必须可见（不能最小化） |

## 目录结构

```
main.py                 入口（ui / session / launch / report …）
xauto/                  核心
  config.py             端口、profile、选择器、LLM 配置
  sop.py                ★ SOP 判定层（扫读/展开/赞/评/藏/关注/通知）
  comment.py            评论生成（语气×风格×场景，含硬校验）
  behavior.py           行为设置（语气、节奏、休息、故障恢复、SOP 参数）
  limits.py             每日上限（UI 可改）
  settings.py           输入通道等运行设置
  runner.py             节奏/休息/故障恢复
  input.py / wininput.py / typing.py   输入层（os 与 cdp 两条通道）
  session.py / dom.py / store.py / bootstrap.py
  account.py            ★ 账号闸门（档位期望账号 vs 页面实际账号）
  limits.py / settings.py   每日上限 / 输入通道等运行设置
pages/x_twitter.py      页面对象（读写页面、点赞、评论、收藏、删除…）
tools/                  各个动作（每个都是独立 CLI）
  x_instance.py        ★ 档位实例管理（起实例 / 绑定账号 / 两档总览）
  x_session.py         ★ SOP 会话主体（核心）
  x_repeat.py          连续会话（多轮，默认不启用）
  x_notif.py           回复通知
  x_post.py            发帖（可 --topic 让模型写）   x_autopost_gen.py  文案生成
  x_thread.py          从回复页互动原帖
  x_dm.py              私信
  x_follow.py          关注/取关（内容质量驱动）
  x_bookmarks.py       收藏消化
  x_report.py          周复盘
  x_health.py          账号体检
  x_query.py           数据查询
  x_export.py          导出关注/页面用户
  x_collect.py         从评论收集作者
  x_delete.py          删除帖子
  x_launch.py          单实例启动（兼容）            x_probe.py  环境自检
ui/server.py           控制台后端（HTTP + 调度 + 任务管理）
ui/index.html          控制台前端
docs/SOP对齐说明.md     SOP 条款 → 代码的逐条对照与未实现项说明
```

## 与 SOP 的对应关系

完整对照见 [docs/SOP对齐说明.md](docs/SOP对齐说明.md)。核心几条：

- **三层阅读**：扫读（跳过互关诱饵/抽奖/引流/来源不明）→ 展开（长帖/引用/回复必展开，其余 25%）→ 核实（不自动点外链，标记待人工）
- **动作独立**：点赞、评论、收藏、关注各自判断，允许"只读不互动"
- **评论硬校验**：必须接住原帖的具体点（bigram 命中）、不许空话/编造亲历/承诺互关，不合格不发
- **关注看内容质量**：简介 + 近期多篇 + 关注理由，三项都过才关注；不搜"互关"关键词
- **时间盒**：默认 25 分钟，内部按 20%/40%/25%/15% 分配到 通知 / 关注时间线 / 推荐 / 收藏消化

## 环境依赖

- Python 3.11+
- 浏览器层复用 `boss-auto-greet` 仓库的 `core.cdp` / `core.cdpinput` / `message.llm`
  （只 import，不修改；路径可用环境变量 `BOSS_AUTO_GREET_ROOT` 覆盖）
- LLM 密钥：环境变量 `LLM_API_KEY`，或本地文件 `xauto/.llm_key`（已 gitignore）

## 风险与边界

- 自动化操作平台可能违反其使用条款，账号风险自负。
- 程序不自动：点外链、静音、屏蔽、举报、转帖。这几件事按 SOP 都需要人工判断。
- 每日上限、时间盒、休息是给账号留余地，不是平台安全保证。
