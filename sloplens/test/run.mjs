// 引擎自测：只验证「形状」和回归，不验证准确率。
// 样本是人为构造的（正样本由我生成），真实准确率必须用独立评测集。
import './../engine.js';

const E = globalThis.SlopLensEngine;

const CASES = [
  // ---- 正样本：AI 生成 ----
  { id: 'ai-zh-obvious', label: 'ai', text:
    '在当今数字化时代，人工智能正在深刻重塑我们的生活方式。首先，它提升了效率；其次，它拓展了边界；最后，它带来了新的可能。值得注意的是，我们需要在创新与规范之间找到平衡。综上所述，AI 的未来值得期待。' },
  { id: 'ai-en-obvious', label: 'ai', text:
    "In today's fast-paced digital landscape, it's worth noting that AI is not just a tool but a paradigm shift. Furthermore, we must delve into the ethical dimensions. Ultimately, the key is to strike a balance between innovation and regulation." },
  { id: 'ai-zh-subtle', label: 'ai', text:
    '很多人以为这只是技术的胜利，但事实并非如此。真正的关键在于底层逻辑的重构——不是工具变了，而是人与信息的关系变了。当这种变化发生时，我们需要重新思考自己的位置。' },
  { id: 'ai-zh-guide', label: 'ai', text:
    '想要提升写作效率？这里有几个实用建议。1. 明确你的目标读者，这决定了内容的深度与语气。2. 建立结构化的写作框架，让逻辑更清晰。3. 善用工具辅助，但不要完全依赖。4. 反复打磨细节。希望这些方法能帮到你。' },
  { id: 'ai-zh-biz', label: 'ai', text:
    '企业数字化转型的核心在于构建数据闭环，通过底层逻辑的重构实现业务赋能。在这个过程中，组织需要建立统一的指标体系，打通部门壁垒，形成可持续演进的生态。只有这样，才能真正释放数据的价值，打造长期护城河。' },
  { id: 'ai-zh-rewritten', label: 'ai', text:
    '说白了，AI 这玩意儿确实把很多东西改了。你先别急着高兴，它带来方便的同时也带来麻烦。比如说写东西快了，但你得想想这东西到底是不是你写的。反正我觉得，关键还是人自己得有数，不然工具再好也白搭。' },
  { id: 'ai-en-explain', label: 'ai', text:
    'Machine learning models learn patterns from data rather than following explicit rules. This distinction is important. Furthermore, the quality of the training data largely determines the outcome, making data curation a pivotal step in any robust pipeline.' },
  { id: 'ai-zh-short', label: 'ai', text:
    '真正的成长，是学会与不确定性共处。' },
  { id: 'ai-rich', label: 'ai', text:
    '2024 年三季度我们在 3 个城市做了 1200 份问卷，67% 的用户表示愿意为省时间付费。首先，价格敏感度比去年下降了 12 个百分点；其次，复购主要集中在 35 岁以上人群；最后，渠道差异比预想的小。' },

  // ---- 负样本：真人 ----
  { id: 'hu-narrative', label: 'human', text:
    '昨天在楼下修车铺看到师傅用手机查电路图，屏幕裂了三道，他用胶带粘着。查了二十分钟，最后说这个模块得换，然后掏出本子记了个型号。' },
  { id: 'hu-life', label: 'human', text:
    '我妈今天又把剩菜热了第三遍，我说别吃了，她说倒了多可惜。然后我们都沉默了。' },
  { id: 'hu-en-casual', label: 'human', text:
    'drove 4 hours to pick up a used bike. seller ghosted me. sat in a parking lot eating gas station sushi. 10/10 would do again' },
  { id: 'hu-academic', label: 'human', text:
    '本文基于 2021—2024 年 37 个省份的面板数据，采用双重差分法检验政策效应。结果显示，处理组系数为 0.032（p<0.01），表明政策显著提升了企业研发投入。' },
  { id: 'hu-notice', label: 'human', text:
    '公司决定自下月起调整考勤规则。具体安排如下：一、上班时间提前至八点三十分；二、午休时间缩短至四十五分钟；三、加班需提前一天申请。请各位同事知悉。' },
  { id: 'hu-tech', label: 'human', text:
    '这个 bug 我查了两天，最后发现是 useEffect 的依赖数组里少写了一个变量。改完就好了。文档里其实写了，但我当时没细看。' },
  { id: 'hu-news', label: 'human', text:
    '昨晚 11 点左右，杭州余杭区一小区地下车库进水，物业用沙袋堵了三个入口。截至今天上午 9 点，积水已排空，未接到人员伤亡报告。' },
  { id: 'hu-opinion', label: 'human', text:
    '我不太同意这个说法。去年我们团队做过一次类似尝试，三个月后数据反而下降了 15%。原因很简单：用户根本不愿意多点两次。所以问题不在技术，在于流程设计。' },
  { id: 'hu-joke', label: 'human', text:
    '同事说他家的猫会开冰箱。我说那你家猫挺聪明。他说不，是冰箱太老了。' },
  { id: 'hu-manual', label: 'human', text:
    '安装前请确认电源已断开。将底座对准卡槽，顺时针旋转约 45 度至锁紧位置。若听到咔哒声，说明安装到位。' },
  { id: 'hu-quote', label: 'human', text:
    '他当时原话是"这事儿我来兜"，然后第二天就提了离职。我现在想起来还是觉得挺魔幻的。' },
  { id: 'hu-data', label: 'human', text:
    '第三季度营收 12.4 亿，同比增长 8.3%，但环比下降 2.1%。管理层把原因归结为季节性因素，我个人觉得主要是渠道调整没做完。' },
  { id: 'hu-empty', label: 'human', text:
    '希望大家都能找到属于自己的节奏，慢慢来，比较快，别急。' },

  // ---- t0-3 新增特征的正样本 ----
  { id: 'ai-zh-connector', label: 'ai', text:
    '这个变化值得重视。此外，团队的协作方式也需要相应调整。同时，外部的反馈渠道同样需要打通。因此，我们需要在下个季度重新评估整体节奏。' },
  { id: 'ai-zh-listdot', label: 'ai', text:
    '提升写作效率可以这样做：1. 先明确目标读者，这决定内容的深度与语气。2. 再建立结构化的写作框架，让逻辑更清晰。3. 最后善用工具辅助，但不要完全依赖。' },
  { id: 'ai-zh-closing', label: 'ai', text:
    '很多人写东西卡住不是因为不会写，而是因为没想清楚要写给谁。先把这个想明白，剩下的都是技术问题。希望这些建议能帮到你。' },

  // ---- t0-3 新增特征的负样本（专门来撞新规则的）----
  // 语气词要跟标点才算：「网吧」的「吧」后面是「待」，不能算
  { id: 'hu-mood-bar', label: 'human', text:
    '昨天去网吧待了一下午，回来发现钥匙丢了，现在还在门口蹲着呢' },
  // 连续问号 / 感叹号是真人情绪，不该当机器信号
  { id: 'hu-shout', label: 'human', text:
    '这也能算完成？？你认真的吗！！我盯了一下午。' },
  // 正式书面语、但确实是真人写的：不能因为「像公文」就被折
  { id: 'hu-formal', label: 'human', text:
    '季度总结会上大家都提到了同一个问题，但没人给出方案。我个人倾向于先小范围试，再谈推广。' },
];

// 灵敏度阈值
const PRESETS = {
  low: { high: 78, mid: 58, foldSpec: 35 },
  mid: { high: 70, mid: 45, foldSpec: 35 },
  hi:  { high: 62, mid: 35, foldSpec: 35 },
};
const preset = PRESETS.mid;

// 与 content.js 里的规则保持一致：阈值判的是展示分数，折叠另加「具体低」闸
function tierOf(score, specificity) {
  const foldSpec = typeof preset.foldSpec === 'number' ? preset.foldSpec : 35;
  if (score >= preset.high && specificity <= foldSpec) return 'fold';
  if (score >= preset.mid) return 'uncertain';
  return 'none';
}

const rows = [];
for (const c of CASES) {
  const r = E.analyze(c.text, {});
  rows.push({
    ...c, score: r.score, raw: r.raw, features: r.features,
    templated: r.templated, specificity: r.specificity,
    tier: tierOf(r.score, r.specificity),
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('='.repeat(86));
console.log(`SlopLens 引擎 ${E.ENGINE_VERSION}  |  阈值 high>=${preset.high} mid>=${preset.mid}`);
console.log('='.repeat(86));
console.log(pad('样本', 18) + pad('标签', 7) + pad('空话', 5) + pad('套路', 5) + pad('具体', 5) + pad('档位', 12) + '主要理由');
console.log('-'.repeat(86));
for (const r of rows) {
  const top = r.features.slice(0, 2).map(f => `${f.name}(${f.weight > 0 ? '+' : ''}${f.weight})`).join('; ');
  console.log(pad(r.id, 18) + pad(r.label, 7) + pad(r.score, 5)
    + pad(r.templated, 5) + pad(r.specificity, 5) + pad(r.tier, 12) + (top || '—'));
}

// ---- 汇总 ----
const ai = rows.filter(r => r.label === 'ai');
const hu = rows.filter(r => r.label === 'human');
const hit = (arr, t) => arr.filter(r => r.tier === t).length;

console.log('\n' + '-'.repeat(86));
console.log(`AI 样本 ${ai.length} 条：会折叠 ${hit(ai, 'fold')} / 仅标记 ${hit(ai, 'uncertain')} / 不标记 ${hit(ai, 'none')}`);
console.log(`真人样本 ${hu.length} 条：会折叠 ${hit(hu, 'fold')} / 仅标记 ${hit(hu, 'uncertain')} / 不标记 ${hit(hu, 'none')}`);
const fp = hu.filter(r => r.tier === 'fold');
console.log(`\n高危误伤（真人被折叠）：${fp.length ? fp.map(r => r.id).join(', ') : '无'}`);
const richMissed = ai.filter(r => r.id === 'ai-rich')[0];
console.log(`AI 但内容有料（应只标记、不折叠）：${richMissed.tier === 'uncertain' ? '✓ 正确' : '✗ 变成了 ' + richMissed.tier}`);
const fn = ai.filter(r => r.tier === 'none');
console.log(`完全漏判（AI 未标记）：${fn.length ? fn.map(r => r.id).join(', ') : '无'}`);
console.log('\n注：样本均为人为构造，n 太小，只能看形状，不能当准确率。');

// ---- 硬约束：这些一旦不成立就是回归，直接让脚本失败 ----
// 之前这里只打印不断言，改坏了也看不出来。
const failures = [];
if (fp.length) failures.push(`真人被折叠：${fp.map(r => r.id).join(', ')}（必须是 0）`);
if (richMissed.tier === 'fold') failures.push('AI 但有具体信息的那条被折叠了（应该只标记）');

if (failures.length) {
  console.log('\n✗ 违反约束：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 约束成立：真人折叠 = 0；AI 但有料的只标记不折叠');
