# vendor/ —— 本地快照的第三方代码（BOSS 项目共用层）

这几个文件复制自 `boss-auto-greet`（原路径 `D:\dev\01-owned\boss-auto-greet`，复制时间 2026-11-17）：

| 文件 | 原始版本时间 | 我们用它做什么 |
|---|---|---|
| `core/cdp.py` | 2026-10-13 | 裸 CDP 客户端：Runtime.evaluate 读页面 |
| `core/cdpinput.py` | 2026-10-17 | 视口坐标换算 + Input.* 派发 |
| `core/human.py` | 2026-10-13 | OS 级键鼠输入兜底（SendInput 通道） |
| `message/llm.py` | — | OpenAI 兼容接口调用（评论/文案生成） |

## 为什么要 vendor 化

以前 `xauto/bootstrap.py` 把 BOSS 仓库挂进 `sys.path`，两边**运行时共用代码**：
那边改接口、重构、甚至删文件，这边下次 import 就直接炸（2026-11-17 实测：
BOSS 的 keep_browser 编排反复把 9234/9235 实例连带杀死，排查成本极高）。

现在依赖被钉死在本地快照上：**那边的任何改动都影响不到我们**，
直到我们主动重新复制一次为止。

## 规矩

- 只在这 4 个文件确实需要升级时，才从 BOSS 重新复制，并在上面表格更新版本时间。
- 平时把它们当本项目源码对待：需要定制就直接改这里（改完在行尾标注 `[local]`）。
- 不要往 vendor/ 里加新的外部代码——能用我们自己的 xauto/ 写的就写在自己家里。
