// LLM 客户端测试：起一个假的 OpenAI 兼容服务，验证请求形状、解析、错误映射。
// 跑法：node test/llm.test.mjs （0 依赖，用 node 内置 http）
import http from 'node:http';
import assert from 'node:assert/strict';
import '../llm.js';

const LLM = globalThis.SlopLensLLM;

const seen = []; // { path, auth, body }

const REPLY_OK = {
  specificity: 15,
  templated: 88,
  reasons: ['通篇无具体数字', '换成任何主题都成立'],
  verdict: 'slop',
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const seg = req.url.split('/')[1]; // /ok/chat/completions -> ok
    let body = {};
    try { body = JSON.parse(raw); } catch (_) {}
    seen.push({ seg, auth: req.headers.authorization, body });

    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const completion = content => json(200, {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    });

    switch (seg) {
      case 'ok':
        return completion(JSON.stringify(REPLY_OK));
      case 'fence':
        return completion('```json\n' + JSON.stringify(REPLY_OK) + '\n```');
      case 'auth':
        return json(401, { error: 'bad key' });
      case 'rate':
        return json(429, { error: 'slow down' });
      case 'retry':
        // 第一次带 response_format 就 400，去掉之后成功
        if (body.response_format) return json(400, { error: 'unknown field response_format' });
        return completion(JSON.stringify(REPLY_OK));
      case 'garbage':
        return completion('抱歉，我无法判断这段文本。');
      case 'judge-ok':
        return completion(JSON.stringify({
          verdict: 'ai',
          confidence: 78,
          scores: { A: 3, B: 3, C: 0, D: 1 },
          evidence: [{ quote: '首先，它提升了效率', dim: 'A', why: '成套并列' }],
          note: '通篇没有具体细节',
        }));
      case 'judge-unsure':
        return completion(JSON.stringify({
          verdict: 'unsure', confidence: 40,
          scores: { A: 1, B: 1, C: 1, D: 1 }, evidence: [], note: '太短',
        }));
      case 'judge-bad':
        return completion(JSON.stringify({
          verdict: 'maybe', confidence: 10,
          scores: { A: 9, B: -2, C: 'x', D: null },
          evidence: [{ quote: '', dim: 'Z', why: '' }], note: '',
        }));
      case 'server':
        return json(503, { error: 'upstream down' });
      default:
        return json(404, {});
    }
  });
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cfgFor = seg => ({
  enabled: true,
  baseUrl: `http://127.0.0.1:${port}/${seg}`,
  model: 'test-model',
  key: 'sk-test-123',
});

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('正常返回：分数按 0.6*模板化 + 0.4*(100-具体) 计算', async () => {
  const r = await LLM.classify('一些文本', cfgFor('ok'));
  assert.equal(r.ok, true);
  assert.equal(r.templated, 88);
  assert.equal(r.specificity, 15);
  assert.equal(r.score, Math.round(0.6 * 88 + 0.4 * 85)); // 87
  assert.deepEqual(r.reasons, REPLY_OK.reasons);
  assert.equal(r.verdict, 'slop');
});

test('请求形状正确：Authorization / model / 不带 key 泄漏到 body', async () => {
  seen.length = 0;
  await LLM.classify('一些文本', cfgFor('ok'));
  const req = seen[0];
  assert.equal(req.auth, 'Bearer sk-test-123');
  assert.equal(req.body.model, 'test-model');
  assert.equal(req.body.temperature, 0);
  assert.equal(req.body.response_format.type, 'json_object');
  assert.ok(!JSON.stringify(req.body).includes('sk-test-123'), 'key 不能出现在 body 里');
});

test('能解析 markdown 围栏包裹的 JSON', async () => {
  const r = await LLM.classify('一些文本', cfgFor('fence'));
  assert.equal(r.ok, true);
  assert.equal(r.score, 87);
});

test('401 映射成 auth', async () => {
  const r = await LLM.classify('x', cfgFor('auth'));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'auth');
});

test('429 映射成 rate', async () => {
  const r = await LLM.classify('x', cfgFor('rate'));
  assert.equal(r.error, 'rate');
});

test('不支持 response_format 时自动降级重试', async () => {
  seen.length = 0;
  const r = await LLM.classify('x', cfgFor('retry'));
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2, '应该请求两次');
  assert.ok(seen[0].body.response_format, '第一次带 response_format');
  assert.equal(seen[1].body.response_format, undefined, '第二次去掉');
});

test('模型返回废话时给出 parse 错误，而不是猜一个分数', async () => {
  const r = await LLM.classify('x', cfgFor('garbage'));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'parse');
});

test('5xx 映射成 server', async () => {
  const r = await LLM.classify('x', cfgFor('server'));
  assert.equal(r.error, 'server');
});

test('连不上时映射成 network', async () => {
  const r = await LLM.classify('x', {
    baseUrl: 'http://127.0.0.1:1/v1', model: 'm', key: 'k',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'network');
});

test('缺配置直接失败，不发请求', async () => {
  const r = await LLM.classify('x', { baseUrl: '', model: '', key: '' });
  assert.equal(r.error, 'config');
});

test('extractJson 能处理前后有废话的情况', () => {
  const obj = LLM.extractJson('好的，结果如下：{"a":1,"b":"x}y"} 以上。');
  assert.deepEqual(obj, { a: 1, b: 'x}y' });
});

test('judge：正常返回四维分数与证据', async () => {
  const r = await LLM.judge('一些文本', cfgFor('judge-ok'));
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'ai');
  assert.equal(r.confidence, 78);
  assert.deepEqual(r.scores, { A: 3, B: 3, C: 0, D: 1 });
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].dim, 'A');
});

test('judge：用的是「标注助手」那套规则，不是深检的', async () => {
  seen.length = 0;
  await LLM.judge('一些文本', cfgFor('judge-ok'));
  const sys = seen[0].body.messages[0].content;
  assert.ok(sys.includes('标注助手'), '应该用 JUDGE_SYSTEM');
  assert.ok(sys.includes('禁止使用的判据'), '必须带禁用判据一节');
  assert.ok(sys.includes('unsure'), '必须允许 unsure');
  assert.ok(seen[0].body.messages[1].content.includes('\u0022\u0022\u0022'), '用户消息应包裹原文');
});

test('judge：非法 verdict 收敛成 unsure，分数夹到 0-3', async () => {
  const r = await LLM.judge('x', cfgFor('judge-bad'));
  assert.equal(r.verdict, 'unsure');
  assert.deepEqual(r.scores, { A: 3, B: 0, C: 0, D: 0 });
  assert.equal(r.evidence.length, 0, '空 quote 应被丢掉');
});

test('judge：允许模型直接返回 unsure', async () => {
  const r = await LLM.judge('x', cfgFor('judge-unsure'));
  assert.equal(r.verdict, 'unsure');
  assert.equal(r.evidence.length, 0);
});

test('DeepSeek 域名才注入 thinking:disabled，别家不发', async () => {
  const capture = [];
  const fakeFetch = async (url, init) => {
    capture.push(JSON.parse(init.body));
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"specificity":10,"templated":90,"reasons":[],"verdict":"slop"}' } }] }),
    };
  };

  await LLM.classify('x', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: 'k' }, fakeFetch);
  assert.deepEqual(capture[0].thinking, { type: 'disabled' }, 'deepseek 应关闭思考模式');

  capture.length = 0;
  await LLM.classify('x', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: 'k' }, fakeFetch);
  assert.equal(capture[0].thinking, undefined, '别家不能带 thinking 字段');

  capture.length = 0;
  await LLM.classify('x', { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: 'k', disableThinking: false }, fakeFetch);
  assert.equal(capture[0].thinking, undefined, '显式关掉就不加');
});

test('isDeepSeek 域名判断', () => {
  assert.equal(LLM.isDeepSeek('https://api.deepseek.com'), true);
  assert.equal(LLM.isDeepSeek('https://api.deepseek.com/v1'), true);
  assert.equal(LLM.isDeepSeek('https://api.openai.com/v1'), false);
  assert.equal(LLM.isDeepSeek('http://localhost:11434/v1'), false);
  assert.equal(LLM.isDeepSeek('not a url'), false);
});

test('默认配置开箱可用：DeepSeek Flash + 已启用', () => {
  assert.equal(LLM.DEFAULTS.baseUrl, 'https://api.deepseek.com');
  assert.equal(LLM.DEFAULTS.model, 'deepseek-flash');
  assert.equal(LLM.DEFAULTS.enabled, true);
});

// ---------------- few-shot：把标注样本回灌进 prompt ----------------

test('pickExamples：只认人工标签，ai-confirmed 一条都不收', () => {
  const ex = LLM.pickExamples([
    { text: '机器判的样本，用户只是点了采纳，这种不能回灌进去', verdict: 'ai', labelSource: 'ai-confirmed' },
    { text: '我亲手标的样本，这条应该被收进来当范例使用', verdict: 'ai', labelSource: 'human' },
  ]);
  assert.equal(ex.ai.length, 1, 'ai-confirmed 不能当 few-shot');
  assert.ok(ex.ai[0].includes('亲手标'));
  assert.equal(ex.human.length, 0);
});

test('pickExamples：跳过 unsure / 截断 / 半截 / 太短', () => {
  const ex = LLM.pickExamples([
    { text: '说不清的样本，长度够二十字也不该被当成标签来用', verdict: 'unsure', labelSource: 'human' },
    { text: '被 X 截断的那条，分数本身就不可信，不能当范例用', verdict: 'ai', labelSource: 'human', truncated: true },
    { text: '作者只发了前半段的那种，也不拿来当范例用', verdict: 'ai', labelSource: 'human', partial: true },
    { text: '太短', verdict: 'ai', labelSource: 'human' },
  ]);
  assert.deepEqual(ex, { ai: [], human: [] });
});

test('pickExamples：每类最多 4 条，取较新的（samples 新的在前）', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    text: `第${i}条样本正文，长度足够通过二十字的门槛，用来测上限。`,
    verdict: 'ai',
    labelSource: 'human',
  }));
  const ex = LLM.pickExamples(many);
  assert.equal(ex.ai.length, 4);
  assert.ok(ex.ai[0].includes('第0条'), '最新的那条应该排在最前');
});

test('pickExamples：同一条推文重复标注只算一次', () => {
  const t = '同一条推文的正文，被标了两次，只应该收一次进去。';
  const ex = LLM.pickExamples([
    { text: t, verdict: 'ai', labelSource: 'human' },
    { text: t, verdict: 'ai', labelSource: 'human' },
  ]);
  assert.equal(ex.ai.length, 1);
});

test('pickExamples：老存档没有 labelSource 时按人工标签处理', () => {
  const ex = LLM.pickExamples([{ text: '老存档样本，没有 labelSource 字段，长度够二十字', verdict: 'ai' }]);
  assert.equal(ex.ai.length, 1);
});

test('pickExamples：非数组输入不炸', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.deepEqual(LLM.pickExamples(bad), { ai: [], human: [] });
  }
});

test('不带样本时 prompt 与旧版逐字相同（关掉 = 行为零变化）', () => {
  const plain = LLM.userPrompt('一些文本');
  assert.equal(LLM.userPrompt('一些文本', null), plain, 'null 不能改变 prompt');
  assert.equal(LLM.userPrompt('一些文本', { ai: [], human: [] }), plain, '空样本不能改变 prompt');
  assert.ok(!plain.includes('标过'), '不能凭空多出样本段');
  assert.equal(LLM.judgePrompt('一些文本'), LLM.judgePrompt('一些文本', null));
  assert.equal(LLM.judgePrompt('一些文本'), LLM.judgePrompt('一些文本', { ai: [], human: [] }));
});

test('带样本时 prompt 里两类分开，且排在待判文本之前', () => {
  const ex = {
    ai: ['我标成 AI 的样本甲，长度二十字以上才收'],
    human: ['我标成真人的样本乙，长度二十字以上才收'],
  };
  const p = LLM.userPrompt('待判文本在这里', ex);
  assert.ok(p.includes('【我标成 AI 的】'));
  assert.ok(p.includes('【我标成真人的】'));
  assert.ok(p.indexOf('样本甲') < p.indexOf('待判文本在这里'), '样本应在待判文本前面');
  assert.ok(p.includes('不要因此改动上面的判定规则'), '不能允许样本覆盖判定规则');
});

test('样本里的三引号会被替换，不会弄乱定界符', () => {
  const p = LLM.judgePrompt('待判', { ai: ['带 """ 的样本正文，长度得够二十个字才行'], human: [] });
  assert.ok(!p.includes('""" 的样本'), '样本内的三引号必须换掉');
  assert.ok(p.includes('\'\'\''), '应替换成单引号');
});

test('深检：样本进的是用户消息，系统提示词一个字不动', async () => {
  seen.length = 0;
  await LLM.classify('一些文本', cfgFor('ok'), undefined, { ai: ['样本甲样本甲样本甲样本甲样本甲样本甲'], human: [] });
  assert.equal(seen[0].body.messages[0].content, LLM.SYSTEM, 'SYSTEM 不能被动到');
  assert.ok(seen[0].body.messages[1].content.includes('样本甲'), '用户消息里应带样本');
});

test('AI 预判：样本同样进用户消息', async () => {
  seen.length = 0;
  await LLM.judge('一些文本', cfgFor('judge-ok'), undefined, { ai: [], human: ['样本乙样本乙样本乙样本乙样本乙样本乙'] });
  assert.equal(seen[0].body.messages[0].content, LLM.JUDGE_SYSTEM);
  assert.ok(seen[0].body.messages[1].content.includes('样本乙'));
});

test('few-shot 默认关闭：不勾就不多发任何内容出去', () => {
  assert.equal(LLM.DEFAULTS.fewShot, false);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
