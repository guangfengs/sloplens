#!/usr/bin/env node
/*
 * 用你自己的标注样本反推阈值
 * ------------------------------------------------------------------
 * 阈值（PRESETS 里的 high / mid / foldSpec）一直是拍的。这个脚本把它变成
 * 「在你的数据上，哪个数能让真人一条都不被折，同时尽量多抓到 AI」。
 *
 * 用法：
 *   node tools/calibrate.mjs samples.json
 *   node tools/calibrate.mjs samples.json --level hi
 *   node tools/calibrate.mjs samples.json --with-ai-labels    # 连 ai-confirmed 一起算
 *   node tools/calibrate.mjs diag.json                        # 诊断导出也能直接喂
 *
 * 输入可以是 popup 里「导出反馈样本」的数组，也可以是「导出诊断数据」那个对象
 * （脚本自己认 samples / items 两种形状）。
 *
 * 三条设计原则，改了就等于把这个脚本变成另一个东西：
 *
 *   1. **分数一律重算，不信任存档里的 score。**
 *      样本里记的分数是老版本引擎算的；引擎一改，那些数字就过期了。
 *      这里拿 text 现场跑当前引擎，所以改完引擎直接重跑这个脚本就有新结论。
 *
 *   2. **不用 argmax 挑阈值。** 22 条样本上任何 argmax 都是过拟合。
 *      做法是先在网格上找出「真人折叠 = 0」的所有解，取 AI 召回最高的那档，
 *      然后报告这一档对应的**稳定区间**（区间内所有阈值决策完全一样），
 *      推荐值取区间中点而不是端点。端点看着更好，其实是运气。
 *
 *   3. **只信人工标签。** ai-confirmed 是模型自己判的、用户点了采纳，
 *      拿它标定阈值等于让模型给自己打分，会越标越偏。
 *
 *   4. **必须能喂一份「背景样本」。** 只用标注样本标阈值一定会偏——
 *      因为人只会去标「值得标」的内容，标注集里全是边界案例，而真实时间线
 *      里绝大多数是正常内容。没有背景分布，学出来的 mid 会把半个 feed 标成存疑。
 *      `--background diag.json` 用「诊断数据」那批**未标注**的真实 feed 当分母，
 *      约束「背景里被标记的比例」不超过 --max-bg-marked（默认 10%）。
 */

import { readFileSync } from 'node:fs';
import '../sloplens/engine.js';

const E = globalThis.SlopLensEngine;

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = name => args.includes('--' + name);
const optVal = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!file) {
  console.error('用法: node tools/calibrate.mjs <samples.json> [--background diag.json]');
  console.error('        [--level mid|low|hi] [--with-ai-labels] [--max-bg-marked 0.1]');
  process.exit(2);
}

const LEVEL = optVal('level', 'mid');
const WITH_AI_LABELS = flag('with-ai-labels');
const BG_FILE = optVal('background', '');
// 背景里最多允许多大比例被标记。默认 10%：时间线上十之一二被提示是可接受的，
// 超过这个数就成了噪声，用户会直接关掉插件。
const MAX_BG_MARKED = Number(optVal('max-bg-marked', '0.10'));
// 真人样本里最多允许多少条落进「存疑」（折叠永远是 0）
const MAX_HU_UNC = Number(optVal('max-human-uncertain', '1'));

// 当前在用的三档（和 content.js 的 PRESETS 保持一致，脚本里再抄一份是为了
// 能拿它做「现状 vs 推荐」的对比；两边不一致时以 content.js 为准）
const PRESETS = {
  low: { high: 78, mid: 58, foldSpec: 35 },
  mid: { high: 70, mid: 45, foldSpec: 35 },
  hi: { high: 62, mid: 35, foldSpec: 35 },
};
const CURRENT_FOLD_SPEC = 35;

// ---------------- 读输入 ----------------
let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`读不了 ${file}: ${e.message}`);
  process.exit(2);
}

const arr = Array.isArray(raw) ? raw
  : Array.isArray(raw && raw.samples) ? raw.samples
    : Array.isArray(raw && raw.items) ? raw.items
      : null;

if (!arr) {
  console.error('认不出这个文件的形状：要 popup 导出的 samples 数组，或 diag 对象（含 items）。');
  process.exit(2);
}

// ---------------- 归一化标签 ----------------
const skipped = { noVerdict: 0, aiConfirmed: 0, noText: 0 };

const labeled = arr.map((s, i) => {
  if (!s) return null;
  const verdict = s.verdict;
  if (verdict !== 'ai' && verdict !== 'human') { skipped.noVerdict++; return null; }
  // 缺 labelSource 的老存档按人工标签算（saveSample 那边缺省也是 'human'）
  const src = s.labelSource || 'human';
  if (src !== 'human' && !WITH_AI_LABELS) { skipped.aiConfirmed++; return null; }
  const text = String(s.text || '').trim();
  if (!text) { skipped.noText++; return null; }
  return { id: String(s.id || `#${i}`), label: verdict, aiLabel: src !== 'human', text };
}).filter(Boolean);

if (!labeled.length) {
  console.error('没有可用样本：需要 verdict 为 ai / human、且有 text 的记录。');
  console.error(skipped);
  process.exit(2);
}

// 分数现场重算
const rows = labeled.map(r => {
  const a = E.analyze(r.text, {});
  return { ...r, score: a.score, spec: a.specificity };
});

const nAi = rows.filter(r => r.label === 'ai').length;
const nHu = rows.filter(r => r.label === 'human').length;

// ---------------- 背景分布（可选，但强烈建议） ----------------
const bg = [];
if (BG_FILE) {
  let braw;
  try { braw = JSON.parse(readFileSync(BG_FILE, 'utf8')); }
  catch (e) { console.error(`读不了背景文件 ${BG_FILE}: ${e.message}`); process.exit(2); }
  const barr = Array.isArray(braw) ? braw
    : Array.isArray(braw && braw.samples) ? braw.samples
      : Array.isArray(braw && braw.items) ? braw.items : null;
  if (!barr) { console.error('背景文件也认不出形状（要 diag 对象或数组）。'); process.exit(2); }
  for (const [i, s] of barr.entries()) {
    const text = String((s && s.text) || '').trim();
    if (!text) continue;
    const a = E.analyze(text, {});
    bg.push({ id: String((s && s.id) || `bg${i}`), score: a.score, spec: a.specificity });
  }
}

// ---------------- 评估 ----------------
const fold = (r, h, f) => r.score >= h && r.spec <= f;

function evaluate(h, f, m) {
  let aiFold = 0, aiUnc = 0, huFold = 0, huUnc = 0, bgFold = 0, bgUnc = 0;
  for (const r of rows) {
    const isFold = fold(r, h, f);
    const isUnc = !isFold && r.score >= m;
    if (r.label === 'ai') { if (isFold) aiFold++; else if (isUnc) aiUnc++; }
    else { if (isFold) huFold++; else if (isUnc) huUnc++; }
  }
  for (const r of bg) {
    if (fold(r, h, f)) bgFold++;
    else if (r.score >= m) bgUnc++;
  }
  return { aiFold, aiUnc, huFold, huUnc, bgFold, bgUnc };
}

// 背景被标记的比例（折叠 + 存疑）。没有背景样本时返回 0，约束自然失效。
const bgMarkedRate = (e) => (bg.length ? (e.bgFold + e.bgUnc) / bg.length : 0);

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const HIGH = range(40, 96);
const FOLD = range(10, 60);
const MID = range(10, 96);

// ---- 第一步：折叠闸（high + foldSpec），硬约束是「真人折叠 = 0」 ----
let best = null;
for (const f of FOLD) {
  const legal = HIGH.filter(h => {
    const e = evaluate(h, f, MID[0]);
    return e.huFold === 0 && e.bgFold === 0;
  });
  if (!legal.length) continue;
  const aiMax = Math.max(...legal.map(h => evaluate(h, f, 0).aiFold));
  const band = legal.filter(h => evaluate(h, f, 0).aiFold === aiMax);
  const cand = {
    f, aiFold: aiMax,
    lo: band[0], hi: band[band.length - 1],
    width: band[band.length - 1] - band[0],
    h: Math.round((band[0] + band[band.length - 1]) / 2),
  };
  // 先比 AI 折叠召回；再比稳定区间宽窄；最后比 foldSpec 离现状（35）近不近
  const better = !best
    || cand.aiFold > best.aiFold
    || (cand.aiFold === best.aiFold && cand.width > best.width)
    || (cand.aiFold === best.aiFold && cand.width === best.width
      && Math.abs(cand.f - CURRENT_FOLD_SPEC) < Math.abs(best.f - CURRENT_FOLD_SPEC));
  if (better) best = cand;
}

if (!best) {
  console.error('找不到「真人一条都不折」的解：样本里所有人的分数都太高，');
  console.error('说明这批内容本身套路化很重，光调阈值解决不了——先看看是不是标错了。');
  process.exit(1);
}

// ---- 第二步：存疑阈值 mid，在折叠闸固定的前提下单独调 ----
// mid 要同时满足：真人折叠 0、真人存疑 ≤ MAX_HU_UNC、背景被标记比例 ≤ MAX_BG_MARKED。
// 在这三条下面把 AI 存疑拉到最多；并列时取更大的 mid（更保守）。
const midCand = MID.filter(m => m <= best.h).map(m => ({ m, ...evaluate(best.h, best.f, m) }));
const midLegal = midCand.filter(x => x.huFold === 0
  && x.huUnc <= MAX_HU_UNC
  && bgMarkedRate(x) <= MAX_BG_MARKED);

let bestMid;
if (midLegal.length) {
  bestMid = midLegal.reduce((a, b) => (b.aiUnc > a.aiUnc
    || (b.aiUnc === a.aiUnc && b.m > a.m) ? b : a));
} else {
  // 约束太紧（常见于背景分布本身就很高）：退回「真人折叠 0 + 背景不折叠」，
  // 并取背景被标记比例最小的那个 m
  const fallback = midCand.filter(x => x.huFold === 0 && x.bgFold === 0);
  bestMid = (fallback.length ? fallback : midCand.filter(x => x.huFold === 0))
    .reduce((a, b) => {
      const ra = bgMarkedRate(a), rb = bgMarkedRate(b);
      return rb < ra || (rb === ra && b.aiUnc > a.aiUnc) ? b : a;
    });
}

const rec = { high: best.h, mid: bestMid.m, foldSpec: best.f };

// ---------------- 输出 ----------------
const pad = (s, n) => String(s).padEnd(n);
const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '—');
const line = '─'.repeat(74);

console.log('='.repeat(74));
console.log(`SlopLens 阈值标定  |  引擎 ${E.ENGINE_VERSION}  |  ${file}`);
console.log('='.repeat(74));
console.log(`可用样本 ${rows.length} 条：AI ${nAi} / 真人 ${nHu}`);
if (skipped.noVerdict) console.log(`  跳过「说不清」和未标注：${skipped.noVerdict} 条`);
if (skipped.aiConfirmed) console.log(`  跳过 ai-confirmed（模型判的，不能拿来标定）：${skipped.aiConfirmed} 条`);
if (skipped.noText) console.log(`  跳过没有正文的：${skipped.noText} 条`);

if (rows.length < 20) {
  console.log('');
  console.log('⚠ 样本不足 20 条。下面的数只能看形状，不能当结论——');
  console.log('  在这个量级上，动 1 分就能让结论翻面。');
}
if (!nAi || !nHu) {
  console.log('');
  console.log('⚠ 只有一类样本，标不出阈值（没有真人样本就不知道「折到真人」在哪）。');
  console.log('  先去标几条真人。');
  process.exit(0);
}

// 现状
console.log('\n' + line);
console.log('现状（三个灵敏度档各自的效果，foldSpec 固定 35）');
console.log(line);
console.log(pad('档位', 6) + pad('high', 7) + pad('mid', 7) + pad('AI折叠', 9) + pad('AI存疑', 9) + pad('真人折叠', 10) + '真人存疑');
for (const [name, p] of Object.entries(PRESETS)) {
  const e = evaluate(p.high, p.foldSpec, p.mid);
  console.log(pad(name, 6) + pad(p.high, 7) + pad(p.mid, 7)
    + pad(`${e.aiFold}/${nAi}`, 9) + pad(`${e.aiUnc}/${nAi}`, 9)
    + pad(`${e.huFold}/${nHu}`, 10) + `${e.huUnc}/${nHu}`);
}

if (bg.length) {
  const cur = evaluate(PRESETS[LEVEL].high, PRESETS[LEVEL].foldSpec, PRESETS[LEVEL].mid);
  const curBg = cur.bgFold + cur.bgUnc;
  const sorted = bg.map(r => r.score).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log('');
  console.log(`背景样本 ${bg.length} 条（未标注的真实 feed）：按当前的 --level ${LEVEL}，`
    + `会被标记 ${curBg} 条（${Math.round(curBg / bg.length * 100)}%），其中折叠 ${cur.bgFold} 条`);
  console.log(`  分数分布 ${sorted[0]}–${sorted[sorted.length - 1]}，中位 ${med}`);
  if (cur.bgFold > 0) console.log('  ⚠ 背景里有内容会被折叠：真实 feed 里几乎不会有 AI，这大概率是误伤。');
} else {
  console.log('');
  console.log('⚠ 没给背景样本（--background diag.json）。只靠标注集标出来的 mid 会偏激进——');
  console.log('  标注集里全是边界案例，而真实时间线里绝大多数是正常内容。');
}

// 推荐
const recE = evaluate(rec.high, rec.foldSpec, rec.mid);
console.log('\n' + line);
console.log(`推荐（--level ${LEVEL}）`);
console.log(line);
console.log(`  high     = ${rec.high}`);
console.log(`  mid      = ${rec.mid}`);
console.log(`  foldSpec = ${rec.foldSpec}${rec.foldSpec === CURRENT_FOLD_SPEC ? '（和现在一样）' : '（和现在的 35 不一样）'}`);
console.log('');
console.log(`  在你这批样本上：AI 折叠 ${recE.aiFold}/${nAi}（${pct(recE.aiFold, nAi)}）· `
  + `AI 存疑 ${recE.aiUnc}/${nAi} · 真人折叠 ${recE.huFold}/${nHu} · 真人存疑 ${recE.huUnc}/${nHu}`);
if (bg.length) {
  const bgMarked = recE.bgFold + recE.bgUnc;
  console.log(`  在背景样本上：会被标记 ${bgMarked}/${bg.length}（${pct(bgMarked, bg.length)}，`
    + `上限 ${Math.round(MAX_BG_MARKED * 100)}%），其中折叠 ${recE.bgFold}`);
}
console.log(`  high 的稳定区间 [${best.lo}, ${best.hi}]：区间内任何值，决策完全相同。`);

// foldSpec 单独报告可辨识区间：很多取值会给出**完全相同**的决策，
// 这时候把其中一个当成「结论」是误导。gate 若几乎不起作用，更要说出来。
const fBand = FOLD.filter(x => {
  const e = evaluate(rec.high, x, rec.mid);
  return e.aiFold === recE.aiFold && e.huFold === recE.huFold && e.bgFold === recE.bgFold;
});
if (fBand.length) {
  const lo = fBand[0], hi = fBand[fBand.length - 1];
  console.log(`  foldSpec 的可辨识区间 [${lo}, ${hi}]：区间内任何值决策完全相同。`);
  if (hi - lo >= 10) {
    console.log(`    也就是说这道闸在这批数据上不起作用——分数够到折叠门槛的那些内容，`);
    console.log(`    具体信息都 ≤ ${lo}，所以 ${lo} 以上取什么值都一样。折叠实际上只由 high 一个数决定。`);
  }
}

// 说清楚 mid 是被哪条约束卡住的——不给理由的数没法复核
if (bestMid.m > 10) {
  const lower = evaluate(rec.high, rec.foldSpec, bestMid.m - 1);
  const why = [];
  if (lower.huUnc > MAX_HU_UNC) why.push(`真人存疑会变成 ${lower.huUnc} 条（上限 ${MAX_HU_UNC}）`);
  if (bgMarkedRate(lower) > MAX_BG_MARKED) {
    why.push(`背景被标记会升到 ${Math.round(bgMarkedRate(lower) * 100)}%（上限 ${Math.round(MAX_BG_MARKED * 100)}%）`);
  }
  if (!why.length) why.push(`再降 1 分，AI 存疑并不会变多（${lower.aiUnc} 条），没有必要`);
  console.log(`  mid 再降 1 分（${bestMid.m - 1}）就会破约束：${why.join('；')}。`);
}
console.log(`  推荐取中点 ${best.h}，不取端点——端点在 ${rows.length} 条样本上是运气，不是规律。`);

// 有没有更好的配置被约束挡掉了
const looser = [];
for (const f of FOLD) {
  for (const h of HIGH) {
    const e = evaluate(h, f, rec.mid);
    if (e.huFold > 0 && e.aiFold > recE.aiFold) looser.push({ h, f, e });
  }
}
if (looser.length) {
  const b = looser.reduce((a, c) => (c.e.aiFold > a.e.aiFold ? c : a));
  console.log('');
  console.log(`  参考：如果把「真人折叠」放宽到允许 ${b.e.huFold} 条，AI 能多折 ${b.e.aiFold - recE.aiFold} 条`);
  console.log(`        （high=${b.h} foldSpec=${b.f}）。这是拿误伤换召回，本项目不建议。`);
}

// 逐条看
console.log('\n' + line);
console.log('逐条（按推荐阈值判）');
console.log(line);
console.log(pad('样本', 14) + pad('标签', 7) + pad('空话', 5) + pad('具体', 5) + pad('档位', 11) + '主要理由');
for (const r of [...rows].sort((a, b) => b.score - a.score)) {
  const isFold = fold(r, rec.high, rec.foldSpec);
  const tier = isFold ? '折叠' : r.score >= rec.mid ? '存疑' : '不标';
  const a = E.analyze(r.text, {});
  const top = a.features.slice(0, 2).map(x => `${x.name}(${x.weight > 0 ? '+' : ''}${x.weight})`).join('; ');
  const mark = (r.label === 'ai' && tier === '不标') || (r.label === 'human' && tier !== '不标') ? ' ←' : '';
  console.log(pad(r.id.slice(0, 13), 14) + pad(r.label + (r.aiLabel ? '*' : ''), 7)
    + pad(r.score, 5) + pad(r.spec, 5) + pad(tier, 11) + (top || '—') + mark);
}

// 可直接粘贴的 PRESETS
console.log('\n' + line);
console.log('贴回 content.js 的 PRESETS（只改你标定的这一档，另外两档别动）');
console.log(line);
const merged = { ...PRESETS[LEVEL], high: rec.high, mid: rec.mid, foldSpec: rec.foldSpec };
console.log(`  ${LEVEL}:${' '.repeat(Math.max(0, 4 - LEVEL.length))}{ high: ${merged.high}, mid: ${merged.mid}, foldSpec: ${merged.foldSpec} },`);
console.log('');
console.log('  ⚠ foldSpec 是目前写死在 tierOf 里的那个 35。要让它生效，');
console.log('    content.js 的 PRESETS 必须带上 foldSpec 字段（t0-3 之后已支持）。');
console.log('  ⚠ 标定完记得重跑 test/run.mjs——真人折叠必须仍然是 0。');

if (WITH_AI_LABELS) {
  console.log('');
  console.log('  标 * 的是 ai-confirmed 样本。它们带着模型自己的偏见，');
  console.log('  这次是你要算进来才用的；平时标定建议去掉这个开关。');
}
