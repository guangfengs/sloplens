// 阈值标定脚本的回归：它是个「给数」的工具，出错会静默误导人，所以也要测。
// 跑法：node test/calibrate.test.mjs （0 依赖，用 node 内置 child_process）
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const script = join(root, 'tools', 'calibrate.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'sloplens-cal-'));
const fixture = (name, obj) => {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

// 跑脚本；返回 { code, out }
function run(args) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const AI = '在当今数字化时代，人工智能正在深刻重塑我们的生活方式。首先，它提升了效率；其次，它拓展了边界。综上所述，AI 的未来值得期待。';
const HU = '昨天在楼下修车铺看到师傅用手机查电路图，屏幕裂了三道，他用胶带粘着。查了二十分钟，最后说这个模块得换。';

const tests = [];
const test = (n, fn) => tests.push([n, fn]);

test('正常输入：给出推荐，且推荐的阈值下真人折叠必须是 0', () => {
  const f = fixture('ok.json', [
    { id: 'a1', text: AI, verdict: 'ai', labelSource: 'human' },
    { id: 'a2', text: AI + '值得注意的是，这一点至关重要。', verdict: 'ai', labelSource: 'human' },
    { id: 'h1', text: HU, verdict: 'human', labelSource: 'human' },
    { id: 'h2', text: '我妈今天又把剩菜热了第三遍，我说别吃了，她说倒了多可惜。', verdict: 'human', labelSource: 'human' },
  ]);
  const r = run([f]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /推荐（--level mid）/);
  assert.match(r.out, /真人折叠 0\/2/);
  assert.match(r.out, /PRESETS/, '应该给出可直接粘贴的配置');
});

test('ai-confirmed 和「说不清」都不参与标定', () => {
  const f = fixture('filter.json', [
    { id: 'a1', text: AI, verdict: 'ai', labelSource: 'human' },
    { id: 'x1', text: AI, verdict: 'ai', labelSource: 'ai-confirmed' },
    { id: 'x2', text: AI, verdict: 'unsure', labelSource: 'human' },
    { id: 'h1', text: HU, verdict: 'human', labelSource: 'human' },
  ]);
  const r = run([f]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /跳过 ai-confirmed.*1 条/);
  assert.match(r.out, /跳过「说不清」和未标注：1 条/);
  assert.match(r.out, /可用样本 2 条/);
});

test('只有一类样本时明确拒绝给阈值，而不是硬算一个', () => {
  const f = fixture('one-class.json', [
    { id: 'a1', text: AI, verdict: 'ai', labelSource: 'human' },
    { id: 'a2', text: AI, verdict: 'ai', labelSource: 'human' },
  ]);
  const r = run([f]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /只有一类样本/);
  assert.ok(!r.out.includes('推荐（--level'), '不该给出推荐值');
});

test('喂诊断导出（{items:[...]} 形状）也能认', () => {
  const f = fixture('diag.json', {
    at: 1, engine: 't0-3', url: 'https://x.com/home', total: 2,
    items: [
      { id: 'a1', text: AI, verdict: 'ai', labelSource: 'human' },
      { id: 'h1', text: HU, verdict: 'human', labelSource: 'human' },
    ],
  });
  const r = run([f]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /可用样本 2 条/);
});

test('认不出的文件形状要报错退出，不能假装成功', () => {
  const f = fixture('weird.json', { hello: 'world' });
  const r = run([f]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /认不出这个文件的形状/);
});

test('背景样本会打印被标记比例，并约束 mid', () => {
  const f = fixture('bg.json', [
    { id: 'a1', text: AI, verdict: 'ai', labelSource: 'human' },
    { id: 'a2', text: AI, verdict: 'ai', labelSource: 'human' },
    { id: 'h1', text: HU, verdict: 'human', labelSource: 'human' },
    { id: 'h2', text: '我妈今天又把剩菜热了第三遍，我说别吃了，她说倒了多可惜。', verdict: 'human', labelSource: 'human' },
  ]);
  // 背景全是低分正常内容 → 不该被标
  const bg = fixture('bgfeed.json', { items: Array.from({ length: 10 }, (_, i) => ({ id: `bg${i}`, text: HU })) });
  const r = run([f, '--background', bg]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /背景样本 10 条/);
  assert.match(r.out, /会被标记 0\/10/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
