/*
 * SlopLens 规则引擎 T0
 * ------------------------------------------------------------------
 * 设计约束（很重要，改代码前先读）：
 *   1. 纯函数、零依赖、零网络、不碰 DOM。所有输入是文本 + 一点点上下文。
 *   2. 只输出 0-100 的分数和「为什么」，不输出「是不是 AI」。
 *      判决由 UI 三档呈现，永远不会只有对/错。
 *   3. 高频虚词（最后/首先/而是/因为…）一律不进词表。
 *      它们真人天天用，是最差的特征——第一版就是这么误伤真人叙事的。
 *   4. 负向特征和正向特征同等重要。数字密度、直接引语、具体时空细节，
 *      这些是「真人证据」，权重必须能把一篇公文压回安全区。
 */
(function (global) {
  'use strict';

  const ENGINE_VERSION = 't0-3';

  // ---------- 词表：只收高精度套路话 ----------
  // 权重含义：0.3 弱暗示，0.6 明显，1.0 几乎决定性。
  const ZH_LEX = {
    // 时代开场白
    '在当今': 0.9, '在如今': 0.7, '数字化时代': 1.0, '人工智能时代': 1.0,
    '信息爆炸': 0.8, '随着科技的发展': 0.9, '随着社会的发展': 0.8, '随着人工智能': 0.8,
    // 空转的动词/名词
    '深刻变革': 0.8, '深刻重塑': 0.9, '重塑': 0.25, '赋能': 0.4, '闭环': 0.4,
    '底层逻辑': 0.7, '范式': 0.45, '抓手': 0.5, '保驾护航': 0.7, '深度融合': 0.7,
    // 收尾套话
    '综上所述': 1.1, '总而言之': 1.0, '值得注意的是': 0.9, '值得一提的是': 0.9,
    '不难发现': 0.8, '众所周知': 0.9, '毋庸置疑': 0.8,
    '至关重要': 0.8, '不可或缺': 0.8, '未来可期': 0.9, '拭目以待': 0.6,
    '开启新篇章': 1.0, '让我们一起': 0.9, '大有可为': 0.7,
    // t0-3 补充：中文 LLM 的话语标记。
    // 收词标准比「像 AI」更严：**公文里会用的词一律不收**。
    // 所以 亟待 / 不容忽视 / 从而 / 与此同时 全部排除——它们是正式书面语，
    // 而「公文和 AI 同构」是这个项目记录在案的头号误伤源（见 README「明确禁止的判据」）。
    '需要指出的是': 0.85, '需要注意的是': 0.8, '值得关注的是': 0.8,
    '我们可以看到': 0.7, '在一定程度上': 0.5, '从某种意义上': 0.55,
  };

  const EN_LEX = {
    "in today's": 1.0, 'fast-paced': 0.8, 'ever-evolving': 0.9, 'landscape': 0.5,
    'realm': 0.6, 'delve': 1.0, "it's worth noting": 1.0, 'it is worth noting': 1.0,
    'furthermore': 0.7, 'moreover': 0.7, 'the key is': 0.7, 'tapestry': 0.9,
    'underscore': 0.7, 'pivotal': 0.8, 'seamless': 0.6, 'paradigm shift': 0.9,
    'strike a balance': 0.8, 'in conclusion': 0.8, 'to sum up': 0.7,
    'at the end of the day': 0.6, 'but rather': 0.6,
    // t0-3 补充：只收英文 LLM 独有的壳子。
    // 原本还加了 robust / leverage / harness / elevate / unlock，实测发现
    // 真人技术写作天天用它们（一条 57 分的英文样本被 'robust' 一个词抬到 69），
    // 按「高频词不进词表」的规则撤掉。
    'at its core': 0.9, 'in a world where': 1.0,
    'dive into': 0.6, 'game-changer': 0.5,
  };

  // ---------- 工具 ----------
  function splitSentences(t) {
    return t.split(/[。！？!?；;\n]+/).map(s => s.trim()).filter(s => s.length > 1);
  }
  function splitParagraphs(t) {
    return t.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
  }
  function cv(nums) {
    if (nums.length < 2) return 1;
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    if (!mean) return 1;
    const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
    return sd / mean;
  }
  const r2 = n => Math.round(n * 100) / 100;

  // ---------- 主函数 ----------
  /**
   * @param {string} text 推文正文
   * @param {{handleSeen?:number, dupCount?:number}} [ctx] 账号/簇上下文
   * @returns {{score:number, raw:number, features:{name:string,weight:number}[], engine:string}}
   */
  function analyze(text, ctx) {
    ctx = ctx || {};
    const feats = [];
    let raw = 0;
    const add = (name, w) => {
      if (Math.abs(w) < 0.01) return;
      feats.push({ name, weight: r2(w) });
      raw += w;
    };

    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) {
      return { score: 0, raw: 0, features: [], engine: ENGINE_VERSION, empty: true };
    }
    const lower = t.toLowerCase();

    // ===== 1. 套路词 =====
    const hits = [];
    let lex = 0;
    for (const p in ZH_LEX) {
      if (t.indexOf(p) !== -1) { lex += ZH_LEX[p]; hits.push(p); }
    }
    for (const p in EN_LEX) {
      if (lower.indexOf(p) !== -1) { lex += EN_LEX[p]; hits.push(p); }
    }
    lex = Math.min(lex, 3.2);
    if (hits.length) {
      const shown = hits.slice(0, 4).join('、') + (hits.length > 4 ? ` 等 ${hits.length} 处` : '');
      add(`套路表达：${shown}`, lex);
    }

    // ===== 2. 结构信号 =====
    const paras = splitParagraphs(t);
    const sents = splitSentences(t);

    if (paras.length >= 3 && cv(paras.map(p => p.length)) < 0.4) {
      add('段落长度过于均匀', 1.3);
    }
    if (sents.length >= 5 && cv(sents.map(s => s.length)) < 0.35) {
      add('句长过于均匀', 1.0);
    }

    // 成套并列（必须凑齐才计分，避免「最后」单独误伤）
    if (['首先', '其次', '最后'].every(k => t.indexOf(k) !== -1)) {
      add('首先 / 其次 / 最后 成套', 2.2);
    } else if (['一是', '二是', '三是'].every(k => t.indexOf(k) !== -1)) {
      add('一是 / 二是 / 三是 成套', 2.0);
    }

    if (/(?:^|[\n。：；\s])(?:[1-9][.、)]|[一二三四五]、)/m.test(t)) {
      add('显式编号列表', 1.2);
    }

    const dashes = (t.match(/[—–]/g) || []).length;
    if (dashes) add(`破折号 ×${dashes}`, Math.min(dashes, 3) * 0.5);

    // 「不是 A，而是 B」——中文 LLM 的强句式
    if (/(不是|并非)[^。！？\n]{1,24}(而是)/.test(t)) add('不是…而是… 句式', 0.7);

    // 建议清单开场白（"这里有几个实用建议"）
    if (/(这里|以下|下面)(有|是)?(几个|一些|几点|几种).{0,8}(建议|方法|技巧|步骤|思路)/.test(t)) {
      add('建议清单开场白', 1.1);
    }

    // 编号列表的每一项都以「。」收尾 —— AI 列点的写法。
    // 公文/通知用的是「一、…；二、…；三、…。」（项间分号），
    // 所以这里只认「句号 + 下一个编号」这个组合，不会打到公文上（见 hu-notice）。
    const dotBeforeNum = (t.match(/[。！？]\s*(?:[1-9][.、)]|[一二三四五六]、)/g) || []).length;
    if (dotBeforeNum >= 2) add('编号列表每项都以句号收尾', 0.6);

    // 连续多句以转折 / 递进连接词开头。
    // 「首先 / 其次 / 最后」已经在上面成套计分，这里不重复收，免得同一件事算两遍。
    const CONN = /^(此外|同时|然而|因此|另外|总体|与此同时|除此之外|更重要的是)/;
    const connStarts = sents.filter(x => CONN.test(x)).length;
    if (sents.length >= 3 && connStarts >= 2) add(`连续以连接词开头（${connStarts} 句）`, 0.7);

    // 收尾套话。「希望这些…帮到你」是中文 AI 的典型收尾；
    // 必须带「这些/以上/本文」，否则「希望大家都能…」这种真人表达会被误伤。
    if (/希望(这些|以上|本文|这个)[^。！？\n]{0,20}(帮到你|有帮助|有所(帮助|启发)|对你)/.test(t)) {
      add('收尾套话（希望这些…帮到你）', 0.8);
    }

    // 逗号切出来的短句长度高度雷同 = 四字/六字堆叠
    // 阈值必须收得紧：真人叙事也常有三四个等长短句，松了就会误伤。
    const segs = t.split(/[，,。；;]/).map(s => s.trim()).filter(Boolean);
    if (segs.length >= 8) {
      const neat = segs.filter(s => s.length >= 4 && s.length <= 7 && /^[\u4e00-\u9fa5]+$/.test(s)).length;
      if (neat / segs.length > 0.55) add('四字 / 六字短语堆叠', 0.7);
    }

    if (/\bnot just\b[^.]{0,80}\bbut\b/i.test(t)) add('not just … but … 句式', 0.8);
    if (/[\u2728\u{1F680}\u{1F4A1}\u{1F31F}]\s*$/u.test(t)) add('结尾 emoji', 0.4);

    // ===== 3. 真人证据（负向） =====
    // 先剥掉列表编号，否则 "1. 2. 3." 会被当成数字密度，误伤 AI 教程。
    const tNoList = t.replace(/(^|[\n。：；\s])(?:[1-9][.、)]|[一二三四五]、)/g, '$1');
    const digits = (tNoList.match(/\d/g) || []).length;
    const dDensity = digits / Math.max(tNoList.length, 1) * 100;
    if (dDensity > 1.2) add(`具体数字（${dDensity.toFixed(1)} 个/百字）`, -1.3);

    let anchors = 0;
    if (digits > 0) anchors++;
    if (/[“”「」『』]|"[^"]{6,}"/.test(t)) { add('直接引语', -0.7); anchors++; }
    if (/(昨天|今天|前天|上周|去年|刚才|那天|楼下|地铁|医院|超市|机场|菜市场|修车)/.test(t)) {
      add('具体时空细节', -0.7); anchors++;
    }
    if (/(我|我们)[^。！？]{0,14}(了|过)/.test(t)) { add('第一人称叙述', -0.35); anchors++; }
    if (/\b(lmao|tbh|imo|nah|dude|wtf)\b|卧槽|妈的|真的服|笑死|绝了|离谱/i.test(t)) {
      add('口语 / 俚语', -1.2); anchors++;
    }
    // 中英混排时，英文术语（NoShake / iOS / API）本身就是具体信息
    const cjkN = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
    const latinN = (t.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || []).length;
    if (cjkN > latinN * 2 && latinN >= 2) {
      add('中英混排的具体术语', -0.5); anchors++;
    }

    // 语气词：真人的强信号，AI 几乎不写。
    // 必须跟标点或句末，否则「网吧」「酒吧」会被算成语气词（吧后面是「待」就不算）。
    const mood = (t.match(/[啊吧呢嘛哦呀呗啦诶唉哎哟咯嘞](?=[，。！？、…~～\s]|$)/g) || []).length;
    if (mood >= 2) add(`语气词 ×${mood}`, -0.8);
    else if (mood === 1 && t.length >= 30) add('语气词 ×1', -0.35);

    // 真人发推经常一逗到底、只在最后点一个句号；AI 几乎每句都收。
    // 英文的 '.' 也算，否则英文 AI 文本会被这条白送分。
    const stops = (t.match(/[。！？!?]|\./g) || []).length;
    if (t.length >= 40 && stops <= 1) add('几乎不打句末标点', -0.5);

    // 连续感叹 / 追问：真人情绪化表达，AI 极少
    if ((t.match(/[！？!?]/g) || []).length >= 2) add('感叹/追问 ×2 以上', -0.35);

    if (t.length < 50) add('文本过短', -0.6);

    // 通篇没有任何具体信息：无数字、无引语、无时空、无亲历
    // 这是比「像不像 AI」更稳的信号，也最接近「值不值得读」
    if (t.length >= 80 && anchors === 0) {
      add('通篇无具体信息（无数字 / 引语 / 时空 / 亲历）', 0.8);
    }

    const tags = t.match(/#[^\s#]+/g) || [];
    if (tags.length >= 3) add('hashtag 堆叠', 0.5);

    // ===== 4. 账号 / 文案簇（外部上下文） =====
    if (ctx.handleSeen >= 25) add(`该账号本次浏览已刷到 ${ctx.handleSeen} 条`, 0.7);
    if (ctx.dupCount >= 3) add(`与 ${ctx.dupCount} 条内容高度相似`, 1.5);

    // ===== 5. 两个维度，再合成 =====
    //
    // 关键：一个分数会把两件不同的事糊在一起。
    //   - 套路化（templated）：套话、对称结构、无信息密度 → 这是「AI 味」
    //   - 具体信息（specificity）：数字、引语、时空、亲历 → 这是「有没有料」
    //
    // 只有「套路高 且 具体信息低」才该折叠。这样才不会：
    //   - 把真人写的空话折掉（低质但不是 AI）
    //   - 把 AI 写的有用内容折掉（是 AI 但不低质）
    //
    // 「文本过短」不参与任何一个维度——它只表示「样本不足」。
    const posRaw = feats.filter(f => f.weight > 0)
      .reduce((a, f) => a + f.weight, 0);
    const negRaw = feats.filter(f => f.weight < 0 && f.name !== '文本过短')
      .reduce((a, f) => a - f.weight, 0);

    const templated = Math.round(100 / (1 + Math.exp(-(posRaw - 2.0))));
    const specificity = Math.round(100 / (1 + Math.exp(-(negRaw - 1.3))));

    // 展示用的「空话指数」就是套路化分本身。
    // 之前用 0.6*templated + 0.4*(100-specificity)，导致：
    //   - 任何没有数字/引语的口语贴都会被 (100-specificity) 抬分（真人被误伤）
    //   - 界面显示 50，判阈值用的却是另一个数（用户看到 50 却不标记，困惑）
    // 现在数字与判定完全一致；具体信息只在「折叠」时作为第二道闸。
    const score = templated;

    return {
      score: Math.max(0, Math.min(100, score)),
      templated: Math.max(0, Math.min(100, templated)),
      specificity: Math.max(0, Math.min(100, specificity)),
      raw: r2(raw),
      features: feats.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
      engine: ENGINE_VERSION,
    };
  }

  const api = { analyze, ENGINE_VERSION };
  global.SlopLensEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
