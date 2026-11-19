// 用正式号真实保存的帖子，生成 10 条评论做效果预览
const fs = require("fs");
globalThis.window = globalThis;
globalThis.chrome = { runtime: { sendMessage: async () => ({ __error: "no key in preview" }) } };

eval(fs.readFileSync("E:/DSH/tui/extension/sop.js", "utf8"));
eval(fs.readFileSync("E:/DSH/tui/extension/comment.js", "utf8"));
const CG = globalThis.COMMENT_GEN;

const posts = [
  "我靠，辛辛苦苦定投一年，牛市赚的钱，熊市几天就给你收回去了！刷到一位兄弟，纳指持仓接近67万。昨天一天亏了8215元。持仓还赚2.8万，但累计收益已经是负的。他说今年好不容易攒下的利润，最近两个月几乎全吐回去了。巧了，我也一样",
  "很多人第一次做独立开发，最容易掉进「一直闷头改产品、不敢拿出去给人用」的坑里。本质上是因为「做什么 × 怎么推广」两个不确定性乘在一起爆掉了，所以第一次真不如先抄一个已经验证过的需求练手",
  "AI 并没有让构建变得容易。它让分发变得更贵。这两件事是不同的。意味着 1000 个人周末会发布同一个应用，赢家是那些已经拥有谷歌流量的人。",
  "我已经花了25万欧元请律师和税务顾问。我还没有推出任何东西。13名在职员工。一位从跨国公司跳槽来加入我的CFO。我没有在卖给你任何东西。没有课程。没有指导。没有付费群组。永远没有。",
  "这个应用的描述是粉丝用应用内金币向认证创作者私下定制专属照片视频，上架四个月，冲到美区 Google Play 美妆畅销榜第 9，估算一个月几万到十万美金收入。但这个需求也太恐怖了。",
  "想找这种「切口独特、而且后面做同款的也刚赚到钱」的对标练手，可以直接翻这个表（162 个）",
  "一年多来，我一直在默默地做一件事情。今晚 19:00 CET，它将不再是秘密。",
  "我把全部身家压在了一个没人看好的方向上，两年了，今天终于有了第一个付费用户，只有 9 美元，但我截图存下来了。",
  "招人的时候我只看一件事：这个人是不是真的对这个东西感兴趣。技术可以教，兴趣教不了。",
  "写了一年多 newsletter，订阅从 0 到 3000。最大的感受是：内容质量只决定你能不能留住人，选题才决定有没有人点进来。",
];

const beh = { comment_rule: "mine", comment_target_len: 13, comment_prob: 1, tone: "friendly" };

(async () => {
  console.log("=".repeat(70));
  console.log("评论效果预览（模板兜底模式，未调用模型）");
  console.log("=".repeat(70));

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    CG.applyCustom({});
    CG.setHistory([]);
    console.log(`\n【${i + 1}】原帖：${p.slice(0, 55)}${p.length > 55 ? "…" : ""}`);
    const seen = new Set();
    for (let k = 0; k < 3; k++) {
      const r = CG.tryTemplates({ text: p }, 13, beh);
      if (r && !seen.has(r)) { seen.add(r); console.log(`     → ${r}`); }
      if (seen.size >= 2) break;
    }
    if (!seen.size) console.log("     → (没有合格评论)");
  }
  console.log("\n" + "=".repeat(70));
})();
