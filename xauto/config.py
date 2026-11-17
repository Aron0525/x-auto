"""X 自动化的全部可调参数，集中一处。

两个「档位」（instance），互不打扰：
    test → 端口 9234 / profile C:\\x-edge-9234 / 数据 xauto/data         （测试号，人工盯着）
    prod → 端口 9235 / profile C:\\x-edge-9235 / 数据 xauto/data/prod     （正式运作号）

选档位只有一个办法：环境变量 XAUTO_INSTANCE=prod。
**不设 = test**，所有老脚本、老定时任务、老数据的行为保持原样。
显式的 XAUTO_PORT / XAUTO_PROFILE / XAUTO_DATA 优先级高于档位默认，便于临时试。

为什么这样切：登录态存在 profile 目录里（换目录=换账号），
去重簿/额度/行为设置/日志全在数据目录里——三样都分开，才算真的两个号。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent        # ...\xauto（comment_rules.md / .llm_key 挂这里，跨档位共用）
_ROOT = PKG_DIR.parent

# ---------- 档位 ----------
INSTANCE = (os.environ.get("XAUTO_INSTANCE", "test") or "test").strip().lower()
if INSTANCE not in ("test", "prod"):
    INSTANCE = "test"

INSTANCE_LABELS = {"test": "测试号", "prod": "正式号"}
INSTANCE_PROFILES = {"test": r"C:\x-edge-9234", "prod": r"C:\x-edge-9235"}
INSTANCE_PORTS = {"test": 9234, "prod": 9235}

# ---------- 浏览器 ----------
CDP_PORT = int(os.environ.get("XAUTO_PORT") or INSTANCE_PORTS[INSTANCE])
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
PROFILE_DIR = os.environ.get("XAUTO_PROFILE") or INSTANCE_PROFILES[INSTANCE]
TARGET_HINTS = ("x.com", "twitter.com")

# 这个档位期望登录的账号 handle（可带 @；空=不校验）。优先级：
#   环境变量 XAUTO_ACCOUNT  >  xauto/data/accounts.json 里本档位的值  >  空
ACCOUNTS_FILE = PKG_DIR / "data" / "accounts.json"
ACCOUNT = (os.environ.get("XAUTO_ACCOUNT") or "").strip().lstrip("@").lower()
if not ACCOUNT:                                  # 档位默认从 accounts.json 查，缺省不校验
    try:
        if ACCOUNTS_FILE.exists():
            _a = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            ACCOUNT = str(_a.get(INSTANCE, "") or "").strip().lstrip("@").lower()
    except Exception:
        pass

def instance_banner() -> str:
    """给日志/报错用的一行身份说明：档位、端口、profile、期望账号。"""
    return (f"档位={INSTANCE}（{INSTANCE_LABELS[INSTANCE]}） 端口={CDP_PORT} "
            f"profile={PROFILE_DIR} 期望账号={'@' + ACCOUNT if ACCOUNT else '未设定'}")

# 站点根（x.com 与 twitter.com 是同一站点，x.com 为准）
SITE = "https://x.com"

# ---------- 节奏（秒）----------
# 单步操作后的随机停顿：太快会触发限流/验证，太慢又没必要
STEP_DELAY = (1.2, 3.2)
# 两个动作之间（发完一条、回复完一条）的冷却
ACTION_DELAY = (8.0, 20.0)
# 单个批次内最多做几件事
DEFAULT_BATCH = 5

# ---------- 存储 ----------
# test 档位保持原位（xauto/data），老数据一个字节都不动；prod 另起 data/prod
_DATA_DEFAULT = PKG_DIR / "data" if INSTANCE == "test" else PKG_DIR / "data" / "prod"
DATA_DIR = Path(os.environ.get("XAUTO_DATA") or _DATA_DEFAULT)
STATE_FILE = DATA_DIR / "state.json"          # 去重簿：已回复过的 tweet id、已发过内容
SHOT_DIR = DATA_DIR / "shots"                 # 截图

# ---------- 浏览策略（模仿人在首页刷时间线）----------

# 「自己感兴趣的内容」：命中这些词的帖子优先点进去（模仿有选择的浏览）
INTEREST_KEYWORDS = (
    "AI", "Agent", "智能体", "大模型", "LLM", "prompt", "提示词", "RAG",
    "自动化", "效率", "产品", "创业", "独立开发", "写作", "读书", "思考",
    "赚钱", "搞钱", "副业", "运营", "增长", "出海", "代码", "编程", "开源",
)

# 明显不想看的：命中就跳过（广告/抽奖/互关/引流话术/纯链接）
SKIP_KEYWORDS = (
    "互关", "互粉", "抽奖", "关注我", "点个赞", "求关注", "推广", "广告",
    "免费领", "课程", "扫码", "加群", "私信我", "看主页",
    "评论区留言", "评论区扣", "扣1", "想要的扣", "留言发你", "评论区回复",
)

# 风险话题：这类帖子不去互动（评论了容易被连带，也容易踩到违规内容）
RISK_KEYWORDS = (
    "博彩", "赌", "菠菜", "灰产", "拉人头", "刷单", "撸羊毛", "空投", "币圈",
    "翻墙", "代充", "接码", "洗钱", "黑产", "搬砖套利", "无限撸", "暴富项目",
    "招聘代理", "日结", "返佣", "带单",
)

# 单次浏览会话的节奏
BROWSE_SCROLL = (3, 7)                 # 先刷 3~7 屏
BROWSE_SCROLL_DELAY = (1.2, 3.5)       # 每屏之间的停顿
BROWSE_SKIM_PAUSE = (2.0, 6.0)         # 偶尔停下多看一会儿
BROWSE_MIN_TEXT = 12                   # 正文太短的（纯图片/纯链接）不点开

# 一轮最多互动几次（点进去 → 评论 + 点赞）
BROWSE_PICK = 1                        # 默认一轮只深看 1 条，宁少勿多
BROWSE_MAX_PICK = 3                    # 上限
LIKE_PROB = 0.85                       # 点进去后点赞的概率

# 每日写操作上限（风控纪律，见 README 第六节）
DAILY_LIKE_MAX = 20
DAILY_REPLY_MAX = 12

# 评论生成
COMMENT_MAX_CHARS = 80                 # X 评论短一点更自然
COMMENT_STYLE = "像真人随手留一句，说具体的东西，不吹捧不空话"

# ---------- LLM（评论生成用；和 BOSS 打招呼那套互不影响）----------
# 密钥只从环境变量读，绝不写进文件。
#   PowerShell:  $env:LLM_API_KEY="sk-..."
# 当前用的是 DeepSeek（可用模型：deepseek-flash / deepseek-v4-pro）
LLM = {
    "base_url": os.environ.get("XAUTO_LLM_BASE", "https://api.deepseek.com/v1"),
    "model": os.environ.get("XAUTO_LLM_MODEL", "deepseek-flash"),
    "api_key_env": "LLM_API_KEY",
    "timeout_s": int(os.environ.get("XAUTO_LLM_TIMEOUT", "60")),
    "temperature": float(os.environ.get("XAUTO_LLM_TEMP", "0.85")),
}

# ---------- 点赞 ----------
# 点赞有两种位置：首页信息流里直接点（便宜、像人刷着刷着顺手点），
# 或者点进帖子在详情页点。两者都支持。
LIKE_INLINE_PROB = 0.5          # 刷屏过程中随手点赞的比例（针对感兴趣但没点进去的帖子）
LIKE_AFTER_REPLY = True         # 评论完顺手点个赞



# ---------- 选择器（探针实测后确认，集中在这里方便一次改全局生效）----------
# 实测记录（2026-11-16，x.com 首页）：
#   [data-testid^="tweetTextarea_"] 是【前缀陷阱】——同一篇发帖框里会同时命中
#     tweetTextarea_0_label（外层容器，placeholder 就在里面）
#     tweetTextarea_0RichTextInputContainer（富文本容器）
#     tweetTextarea_0（真正的 contenteditable）
#   只按前缀取第一个 → 读到的是 placeholder，注入也落不准。必须加 contenteditable 限定。
#   提交按钮同理：tweetButton（弹层）与 tweetButtonInline（页内）会同时存在于 DOM。
SEL = {
    # 登录态判定：左栏账号切换按钮只在登录后出现
    "account_switcher": '[data-testid="SideNav_AccountSwitcher_Button"]',
    # 左栏「发帖」入口
    "nav_post": '[data-testid="SideNav_NewTweet_Button"]',
    # 发帖/回复编辑框：只认真正可编辑的那个节点
    "editor": 'div[contenteditable="true"][data-testid^="tweetTextarea_"]',
    # 提交按钮：内联（页内/详情页）与弹层两种都要覆盖，具体取哪个由「就近祖先」决定
    "submit": '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
    # 时间线里的帖子
    "tweet": 'article[data-testid="tweet"]',
    "tweet_text": '[data-testid="tweetText"]',
    "tweet_user": '[data-testid="User-Name"]',
    # 回复按钮 / 私信
    "reply_btn": '[data-testid="reply"]',
    "dm_input": 'div[contenteditable="true"][data-testid="dmComposerTextInput"]',
    "dm_send": '[data-testid="dmComposerSendButton"]',
    "dm_conversation": 'div[data-testid="conversation"]',
}



def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
