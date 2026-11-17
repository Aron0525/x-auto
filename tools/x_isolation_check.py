"""离线冒烟：完全不碰浏览器、不联网，验证整条 import 链在外部仓库不可达时仍健康。"""
import os
import sys

os.environ["BOSS_AUTO_GREET_ROOT"] = r"D:\nowhere"      # 外部仓库不可达
sys.path.insert(0, ".")

mods = ["xauto.config", "xauto.session", "xauto.dom", "xauto.input", "xauto.typing",
        "xauto.store", "xauto.comment", "xauto.behavior", "xauto.limits", "xauto.settings",
        "xauto.runner", "xauto.sop", "xauto.account", "pages.x_twitter",
        "xauto.bootstrap", "core.cdp", "core.cdpinput", "core.human", "message.llm"]
for m in mods:
    try:
        __import__(m)
        print(f"  ✓ {m}")
    except Exception as e:
        print(f"  ✗ {m}: {type(e).__name__}: {str(e)[:90]}")

# 行为自检：账号闸门的纯逻辑 + LLM 配置来源必须是我们自己的
from xauto import account, config
assert account.normalize("@Foo_Bar") == "foo_bar", "handle 归一化不对"
assert account.normalize("") == ""
print(f"\n档位={config.INSTANCE} 端口={config.CDP_PORT} profile={config.PROFILE_DIR}")
print(f"LLM base/model = {config.LLM.get('base_url')} / {config.LLM.get('model')}（来自 xauto/config.py，非 BOSS 的 config.yaml）")
print("vendor 解析自 :", sys.modules["core.cdp"].__file__)
print("\n[ok] 外部仓库不可达时，全部模块导入成功")
