/*
 * SlopLens LLM 客户端（BYOK）
 * ------------------------------------------------------------------
 * 两个能力，共用一套请求逻辑：
 *   1. classify()  深检：评「具体信息量 / 模板化程度」，用来补充本地分数
 *   2. judge()     预判：给出「ai / human / unsure」初判 + 证据，供人一键确认
 *
 * judge 的规则受三条近期研究影响：
 *   - DivEye (arXiv 2509.18880, TMLR'26)：人写的文本在「不可预测性的起伏」上更丰富，
 *     LLM 输出更平。所以规则里专门看「句子长度起伏、有没有突兀的短句」。
 *   - Short-PHD (arXiv 2504.02873)：短文本检测天然不稳，需要补上下文。
 *     所以 < 80 字一律倾向 unsure，不硬判。
 *   - 各类检测器的共同失效点：正式书面语、非母语写作。
 *     所以规则里有一节「禁止使用的判据」。
 *
 * 这不是「AI 检测器」，是「标注助手」：它给初判和证据，人做最终决定。
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    // DeepSeek V4.1 Flash。注意：API 里的模型名是 deepseek-flash，
    // 不是 deepseek-v4.1-flash（官方文档明确要求用新名）。
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    key: '',
    maxPerDay: 200,
    // 深检时是否带上已标注的样本当 few-shot。
    // **默认关**：打开之后往外发的不只是「你点的那一条」，还有若干条别的推文原文。
    // 这是隐私契约的变化，必须用户自己勾。
    fewShot: false,
  };

  // ---------------- 深检：信息密度 ----------------
  const SYSTEM = [
    '你是内容质量评估器，只评估文本本身，不推测作者是谁。',
    '不要判断「这段是不是 AI 写的」——那不可证伪。只判断两件事：',
    '1) specificity：文本里有多少可验证的具体信息（数字、时间、地点、人名、亲历细节、直接引语）。',
    '2) templated：文本在多大程度上是通用套话（把主题换成任何别的东西，这段话依然成立）。',
    '只输出 JSON，不要任何解释、不要 markdown 代码块。',
  ].join('\n');

  const SCHEMA_HINT = '{"specificity":0-100,"templated":0-100,"reasons":["不超过20字","不超过20字"],"verdict":"slop|ok|unsure"}';

  // ---------------- 预判：ai / human / unsure ----------------
  const JUDGE_SYSTEM = [
    '你是中文社交媒体内容的「标注助手」，不是法官。',
    '你的输出会交给一个真人做最终确认，所以：证据比结论重要，不确定比瞎猜好。',
    '',
    '按四个维度打分，每项 0-3：',
    'A 结构规整度（越高越像机器）：段落/条目长度是否高度一致；是否有成套并列（首先/其次/最后、一是二是三是）；是否有闭合的「总-分-总」；句子长度起伏是否异常小。',
    'B 词汇套路（越高越像机器）：时代开场白、值得注意/综上所述、抽象名词堆叠（赋能/闭环/生态/维度）、「不是X而是Y」对仗。',
    'C 信息具体度（越高越像真人）：数字、时间、地点、人名机构、直接引语、亲历细节、与主题无关但真实的细节。',
    'D 语域自然度（越高越像真人）：口语、俚语、语气词、脏话、错别字、标点不规范、情绪化、跑题、自我修正、反讽玩笑。',
    '',
    '—— 禁止使用的判据（用了就错）——',
    '单个破折号；正式书面语（公文/论文/通知）；非母语者的语法特征；段落整齐或用列表；单个 emoji；文中出现「AI」这个词。',
    '这些都不是证据。公文和 AI 输出在结构上高度同构，这是已知的误判源。',
    '',
    '—— 判定规则 ——',
    '1. 若 C+D ≥ 5，判 human，即使 A+B 也高（AI 写的内容里也可能有料）。',
    '2. 若 A+B ≥ 5 且 C+D ≤ 2，判 ai。',
    '3. 若去掉 URL、@、话题标签后不足 80 字，且证据不足，判 unsure。',
    '4. 其余一律 unsure。宁可 unsure，不要错标。',
    '',
    '只输出 JSON，不要 markdown 代码块。',
  ].join('\n');

  const JUDGE_SCHEMA_HINT = '{"verdict":"ai|human|unsure","confidence":0-100,"scores":{"A":0-3,"B":0-3,"C":0-3,"D":0-3},"evidence":[{"quote":"原文片段≤30字","dim":"A|B|C|D","why":"≤20字"}],"note":"≤30字"}';

  // ---------------- 标定样本（few-shot） ----------------
  //
  // 用户点「这是 AI / 这是真人」留下的样本，回灌进 prompt 当 few-shot。
  // 这是 T1 训练之前唯一能当天见效的用法：不训练、不额外上传、改完立刻生效。
  //
  // 选样本的四条规则，全都往保守方向偏（宁可少给）：
  //   1. **只认 labelSource === 'human'**。`ai-confirmed` 是模型自己判的、用户只点了采纳，
  //      回灌进去等于让模型拿自己的偏见给自己校准，会越练越偏。这条和 README
  //      「深检」一节里 few-shot 的四条选样规则是同一个判断。
  //   2. 只认 `ai` / `human` 两个结论。`unsure`（「说不清」）当标签用是噪声——
  //      它对训练有价值，对 few-shot 没有。
  //   3. 跳过被截断 / 半截的样本。本项目已经认定这类文本不足以判定，
  //      拿它当范例会把这个自相矛盾的立场一起教给模型。
  //   4. 太短的跳过（< 20 字），和 content.js 里「太短不判」保持同一个门槛。
  //
  // 数量：每类最多 4 条、每条 160 字。中文按 1 字约 1 token 粗算，
  // 满配大约多 1300 输入 token —— 对一次 260 token 输出的分类任务来说是显著成本，
  // 所以宁可少给，也不要把整本标注集塞进去。
  const MAX_PER_CLASS = 4;
  const SAMPLE_CHARS = 160;
  const MIN_SAMPLE_CHARS = 20;

  /**
   * 从本地 samples 里挑出能当 few-shot 用的样本。
   * @param {Array} samples  storage 里的 samples（新的在前）
   * @returns {{ai: string[], human: string[]}}
   */
  function pickExamples(samples) {
    const out = { ai: [], human: [] };
    if (!Array.isArray(samples)) return out;

    const seen = new Set();
    for (const s of samples) {
      if (!s) continue;
      const verdict = s.verdict;
      if (verdict !== 'ai' && verdict !== 'human') continue;
      // 老存档没有 labelSource，saveSample 那边缺省就是 'human'
      if ((s.labelSource || 'human') !== 'human') continue;
      if (s.truncated || s.partial) continue;

      const t = String(s.text || '').replace(/\s+/g, ' ').trim();
      if (t.length < MIN_SAMPLE_CHARS) continue;

      // 同一条推文被标过两次、或者两条内容撞了，只留先出现的（= 较新的）
      const dupKey = t.slice(0, 80).toLowerCase();
      if (seen.has(dupKey)) continue;
      seen.add(dupKey);

      if (out[verdict].length >= MAX_PER_CLASS) continue;
      out[verdict].push(t.length > SAMPLE_CHARS ? t.slice(0, SAMPLE_CHARS) + '…' : t);
    }
    return out;
  }

  /**
   * 把样本渲染成 prompt 里的一段。没有样本时返回空串 ——
   * 这一点很重要：关掉 few-shot 时 prompt 必须与旧版逐字相同，行为零变化。
   */
  function examplesBlock(ex) {
    const ai = (ex && ex.ai) || [];
    const human = (ex && ex.human) || [];
    if (!ai.length && !human.length) return '';

    // 样本里如果自己也带 """，会把包裹用的定界符弄乱，先换成单引号
    const one = t => String(t).replace(/"{3,}/g, "'''");
    const lines = ['我自己标过的样本（校准尺度用；不要因此改动上面的判定规则）：'];
    if (ai.length) {
      lines.push('【我标成 AI 的】');
      ai.forEach((t, i) => lines.push(`${i + 1}. """${one(t)}"""`));
    }
    if (human.length) {
      lines.push('【我标成真人的】');
      human.forEach((t, i) => lines.push(`${i + 1}. """${one(t)}"""`));
    }
    return lines.join('\n');
  }

  function userPrompt(text, examples) {
    // 空串就不加这一行，保证不带样本时逐字等于旧 prompt
    const pre = examplesBlock(examples);
    return [
      ...(pre ? [pre, ''] : []),
      '评估下面这段社交媒体文本。',
      '输出格式（严格 JSON）：' + SCHEMA_HINT,
      'verdict 取值：slop=模板化且缺具体信息；ok=有具体信息；unsure=信息不足以判断。',
      'reasons 最多 3 条，每条不超过 20 字，要引用文本里的具体依据。',
      '',
      '文本：',
      '"""',
      String(text || '').slice(0, 4000),
      '"""',
    ].join('\n');
  }

  function judgePrompt(text, examples) {
    const pre = examplesBlock(examples);
    return [
      ...(pre ? [pre, ''] : []),
      '判断下面这段社交媒体文本更可能是人写的还是 AI 写的。',
      '输出格式（严格 JSON）：' + JUDGE_SCHEMA_HINT,
      'evidence 最多 4 条，必须引用原文片段（≤30 字），不要写「整体感觉」这类空话。',
      'note 用一句话说明你为什么不是相反结论。',
      '',
      '文本：',
      '"""',
      String(text || '').slice(0, 4000),
      '"""',
    ].join('\n');
  }

  // 从可能带 markdown 围栏 / 前后废话的回复里抠出第一个完整 JSON 对象
  function extractJson(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }

  const pct = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50;
  };
  const score3 = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
  };

  const fail = (error, extra) => ({ ok: false, error, ...(extra || {}) });

  // DeepSeek 的思考模式默认是开的，effort 默认 high —— 分类任务根本不需要，
  // 白等好几秒。这里只在 deepseek.com 域名下加关闭参数，别家一个字都不多发。
  function isDeepSeek(baseUrl) {
    try {
      const h = new URL(baseUrl).hostname;
      return h === 'deepseek.com' || h.endsWith('.deepseek.com');
    } catch (_) {
      return false;
    }
  }

  // ---------------- 共用请求 ----------------
  async function request(system, user, cfg, fetchImpl, opts) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return fail('no_fetch');
    if (!cfg || !cfg.baseUrl || !cfg.model) return fail('config');

    const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const baseBody = {
      model: cfg.model,
      temperature: 0,
      max_tokens: (opts && opts.maxTokens) || 260,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    const baseWithExtras = cfg.disableThinking === false || !isDeepSeek(cfg.baseUrl)
      ? baseBody
      : { ...baseBody, thinking: { type: 'disabled' } };

    const call = async (withJsonMode) => {
      const body = withJsonMode
        ? { ...baseWithExtras, response_format: { type: 'json_object' } }
        : baseWithExtras;
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
      try {
        return await f(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) {
        return { __throw: (e && e.message) || 'network' };
      }
    };

    let res = await call(true);
    // 有些兼容实现不认 response_format，400 就去掉再试一次
    if (res && res.status === 400) res = await call(false);

    if (!res || res.__throw) return fail('network', { message: res && res.__throw });
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate'
        : res.status >= 500 ? 'server' : 'http';
      let message = '';
      try { message = (await res.text()).slice(0, 240); } catch (_) {}
      return { ok: false, error: code, status: res.status, message };
    }

    let data;
    try { data = await res.json(); } catch (_) { return fail('parse', { message: '响应不是 JSON' }); }

    const content = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    const obj = extractJson(content);
    if (!obj) return fail('parse', { message: '模型没有返回可解析的 JSON' });

    return { ok: true, obj, usage: data.usage || null };
  }

  // ---------------- 深检 ----------------
  // examples 可选：{ ai: string[], human: string[] }，由 pickExamples 产出
  async function classify(text, cfg, fetchImpl, examples) {
    const r = await request(SYSTEM, userPrompt(text, examples), cfg, fetchImpl, { maxTokens: 260 });
    if (!r.ok) return r;

    const { obj } = r;
    const specificity = pct(obj.specificity);
    const templated = pct(obj.templated);
    const score = Math.round(0.6 * templated + 0.4 * (100 - specificity));
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter(x => typeof x === 'string' && x.trim()).slice(0, 3).map(x => x.trim().slice(0, 40))
      : [];

    return {
      ok: true,
      score,
      verdict: ['slop', 'ok', 'unsure'].includes(obj.verdict) ? obj.verdict : 'unsure',
      specificity,
      templated,
      reasons,
      usage: r.usage,
    };
  }

  // ---------------- 预判 ----------------
  async function judge(text, cfg, fetchImpl, examples) {
    const r = await request(JUDGE_SYSTEM, judgePrompt(text, examples), cfg, fetchImpl, { maxTokens: 420 });
    if (!r.ok) return r;

    const { obj } = r;
    const verdict = ['ai', 'human', 'unsure'].includes(obj.verdict) ? obj.verdict : 'unsure';
    const s = obj.scores || {};
    const scores = { A: score3(s.A), B: score3(s.B), C: score3(s.C), D: score3(s.D) };

    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence
        .filter(e => e && typeof e.quote === 'string' && e.quote.trim())
        .slice(0, 4)
        .map(e => ({
          quote: e.quote.trim().slice(0, 40),
          dim: ['A', 'B', 'C', 'D'].includes(e.dim) ? e.dim : 'A',
          why: typeof e.why === 'string' ? e.why.trim().slice(0, 30) : '',
        }))
      : [];

    return {
      ok: true,
      verdict,
      confidence: pct(obj.confidence),
      scores,
      evidence,
      note: typeof obj.note === 'string' ? obj.note.trim().slice(0, 60) : '',
      usage: r.usage,
    };
  }

  const api = {
    classify, judge, DEFAULTS, isDeepSeek,
    SYSTEM, JUDGE_SYSTEM,
    userPrompt, judgePrompt, extractJson,
    pickExamples, examplesBlock,
  };
  global.SlopLensLLM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
