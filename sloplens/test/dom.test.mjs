// DOM 冒烟测试（需要 jsdom：npm i -D jsdom）
// 跑法：node test/dom.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const engineSrc = readFileSync(join(root, 'engine.js'), 'utf8');
const contentSrc = readFileSync(join(root, 'content.js'), 'utf8');

const AI_TEXT = '在当今数字化时代，人工智能正在深刻重塑我们的生活方式。首先，它提升了效率；其次，它拓展了边界；最后，它带来了新的可能。值得注意的是，我们需要在创新与规范之间平衡。综上所述，AI 的未来值得期待。';
const HUMAN_TEXT = '昨天在楼下修车铺看到师傅用手机查电路图，屏幕裂了三道，他用胶带粘着。查了二十分钟，最后说这个模块得换，然后掏出本子记了个型号。';
// 另一条套话：打 57 分（uncertain），用来区分「重扫了」和「没重扫」
const AI_BIZ_TEXT = '企业数字化转型的核心在于构建数据闭环，通过底层逻辑的重构实现业务赋能。在这个过程中，组织需要建立统一的指标体系，打通部门壁垒，形成可持续演进的生态。只有这样，才能真正释放数据的价值，打造长期护城河。';

function tweet(id, handle, text) {
  return `
    <article data-testid="tweet">
      <div data-testid="User-Name"><span>Name</span><a href="/${handle}">@${handle}</a></div>
      <div data-testid="tweetText">${text}</div>
      <a href="/${handle}/status/${id}"><time datetime="2026-10-30T10:00:00Z"></time></a>
      <div role="group" aria-label="1 replies"></div>
    </article>`;
}

function boot(settings, bodyHtml, opts) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://x.com/home',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // jsdom 不实现 innerText，按 textContent 兜底
  Object.defineProperty(win.Element.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });

  const written = [];
  win.chrome = {
    storage: {
      local: {
        get(keys, cb) { cb({ settings, samples: [], stats: {} }); },
        set(obj) { written.push(obj); },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(msg) {
        if (opts && opts.judge && msg && msg.type === 'aiJudge') return Promise.resolve(opts.judge);
        return Promise.resolve(undefined);
      },
    },
  };

  win.eval(engineSrc);
  win.eval(contentSrc);
  return { dom, win, written };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('高置信推文注入 high 档角标', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('101', 'slop', AI_TEXT));
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(bar, '应该注入角标');
  assert.equal(bar.dataset.tier, 'high');
  assert.ok(Number(bar.querySelector('.sloplast-score').textContent) >= 70);
  dom.window.close();
});

test('真人叙事不注入角标', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('102', 'real', HUMAN_TEXT));
  assert.equal(win.document.querySelector('.sloplast-bar'), null);
  dom.window.close();
});

test('过短文本不判', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('103', 'short', '今天天气不错。'));
  assert.equal(win.document.querySelector('.sloplast-bar'), null);
  dom.window.close();
});

test('折叠模式给高置信加 class', () => {
  const { dom, win } = boot({ mode: 'fold', sensitivity: 'mid' }, tweet('104', 'slop', AI_TEXT));
  const art = win.document.querySelector('article');
  assert.ok(art.classList.contains('sloplast-folded'), '应该折叠');
  dom.window.close();
});

test('点角标展开判定依据面板', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('105', 'slop', AI_TEXT));
  const bar = win.document.querySelector('.sloplast-bar');
  const panel = win.document.querySelector('.sloplast-panel');
  assert.equal(panel.hidden, true);
  bar.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const panel2 = win.document.querySelector('.sloplast-panel');
  assert.equal(panel2.hidden, false, '点开后应可见');
  assert.ok(panel2.querySelectorAll('.sloplast-reasons li').length > 0, '应列出理由');
  dom.window.close();
});

test('反馈按钮落库样本', () => {
  const { dom, win, written } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('106', 'slop', AI_TEXT));
  const bar = win.document.querySelector('.sloplast-bar');
  bar.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const btn = [...win.document.querySelectorAll('.sloplast-actions button')]
    .find(b => b.textContent === '这是 AI');
  assert.ok(btn, '应有反馈按钮');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const saved = written.find(o => Array.isArray(o.samples));
  assert.ok(saved, '应写入 samples');
  assert.equal(saved.samples.length, 1);
  assert.equal(saved.samples[0].id, '106');
  assert.equal(saved.samples[0].verdict, 'ai');
  assert.ok(saved.samples[0].features.length > 0);
  dom.window.close();
});

test('关闭模式不注入任何东西', () => {
  const { dom, win } = boot({ mode: 'off', sensitivity: 'mid' }, tweet('107', 'slop', AI_TEXT));
  assert.equal(win.document.querySelector('.sloplast-bar'), null);
  dom.window.close();
});

test('header 模式：角标挂在时间戳那一行', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid', badgePosition: 'header' }, tweet('108', 'slop', AI_TEXT));
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(bar.classList.contains('sloplast-bar--inline'), '应该用紧凑样式');
  assert.ok(bar.parentElement.querySelector('time'), '角标所在行应包含时间戳');
  const panel = win.document.querySelector('.sloplast-panel');
  assert.equal(panel.previousElementSibling.getAttribute('data-testid'), 'tweetText', '面板仍应落在正文后面');
  dom.window.close();
});

test('below 模式：角标挂在正文后面', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid', badgePosition: 'below' }, tweet('109', 'slop', AI_TEXT));
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(!bar.classList.contains('sloplast-bar--inline'));
  assert.equal(bar.previousElementSibling.getAttribute('data-testid'), 'tweetText');
  dom.window.close();
});

test('点角标不会冒泡成「打开推文」', () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid', badgePosition: 'header' }, tweet('110', 'slop', AI_TEXT));
  const article = win.document.querySelector('article');
  let leaked = 0;
  article.addEventListener('click', () => { leaked++; });
  const bar = win.document.querySelector('.sloplast-bar');
  bar.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(leaked, 0, '点击角标不能冒泡到推文');
  dom.window.close();
});

test('诊断模式：未标记的短推文也显示分数', () => {
  const { dom, win } = boot(
    { mode: 'badge', sensitivity: 'mid', badgePosition: 'header', diagnostics: true },
    tweet('111', 'short', '今天天气不错。')
  );
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(bar, '诊断模式下应该显示');
  assert.ok(bar.classList.contains('sloplast-bar--diag'), '应该用诊断样式');
  assert.equal(bar.dataset.tier, 'skipped');
  assert.ok(bar.textContent.includes('太短'), '应标明跳过原因');
  dom.window.close();
});

test('诊断模式关闭时，未标记的短推文保持安静', () => {
  const { dom, win } = boot(
    { mode: 'badge', sensitivity: 'mid', badgePosition: 'header', diagnostics: false },
    tweet('112', 'short', '今天天气不错。')
  );
  assert.equal(win.document.querySelector('.sloplast-bar'), null);
  dom.window.close();
});

test('AI 预判：显示初判与证据，采纳后记为 ai-confirmed', async () => {
  const judge = {
    ok: true, verdict: 'ai', confidence: 78,
    scores: { A: 3, B: 3, C: 0, D: 1 },
    evidence: [{ quote: '首先，它提升了效率', dim: 'A', why: '成套并列' }],
    note: '通篇没有具体细节',
  };
  const { dom, win, written } = boot(
    { mode: 'badge', sensitivity: 'mid', badgePosition: 'header' },
    tweet('113', 'slop', AI_TEXT),
    { judge }
  );

  // 展开面板
  win.document.querySelector('.sloplast-bar')
    .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const aiBtn = [...win.document.querySelectorAll('.sloplast-actions button')]
    .find(b => b.textContent === 'AI 预判');
  assert.ok(aiBtn, '应有 AI 预判按钮');
  aiBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  // 等 promise 链跑完
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  const box = win.document.querySelector('.sloplast-ai');
  assert.ok(box, '应出现预判结果块');
  assert.ok(box.textContent.includes('像 AI'), '应显示初判');
  assert.ok(box.textContent.includes('首先，它提升了效率'), '应引用原文证据');

  const accept = [...box.querySelectorAll('button')]
    .find(b => b.textContent === '采纳这个判断');
  assert.ok(accept, '应有采纳按钮');
  accept.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const saved = written.filter(o => Array.isArray(o.samples)).pop();
  assert.ok(saved, '采纳后应落库');
  assert.equal(saved.samples[0].verdict, 'ai');
  assert.equal(saved.samples[0].labelSource, 'ai-confirmed');
  assert.equal(saved.samples[0].ai.verdict, 'ai');
  dom.window.close();
});

// ---------------- 扫描调度 / 自己 / 节点复用 ----------------
// 等一轮 schedule（200ms 节流）跑完
const tick = (ms = 320) => new Promise(r => setTimeout(r, ms));

test('定向重扫：后插进来的推文（装在容器里）也会被判', async () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('201', 'real', HUMAN_TEXT));
  assert.equal(win.document.querySelector('.sloplast-bar'), null);

  // 真实时间线是整块容器插进来的，addedNodes 里没有 <article> 本身
  const wrap = win.document.createElement('div');
  wrap.innerHTML = tweet('202', 'slop', AI_TEXT);
  win.document.body.appendChild(wrap);

  await tick();
  const bars = win.document.querySelectorAll('.sloplast-bar');
  assert.equal(bars.length, 1, '容器里那条应该被扫到');
  assert.equal(bars[0].dataset.tier, 'high');
  dom.window.close();
});

test('排除自己：本人推文不判、不注入', () => {
  const html = '<a data-testid="AppTabBar_Profile_Link" href="/me">个人资料</a>'
    + tweet('203', 'me', AI_TEXT);
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, html);
  assert.equal(win.document.querySelector('.sloplast-bar'), null, '自己的推文不该被打分');
  dom.window.close();
});

test('排除自己：认不出自己时照常判（不猜）', () => {
  // 没有侧边栏 → selfHandle() 返回 null → 不能顺手把别人当成自己
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('204', 'me', AI_TEXT));
  assert.ok(win.document.querySelector('.sloplast-bar'), '认不出自己时应照常判');
  dom.window.close();
});

test('节点复用：同一条 article 换装另一条推文时重新分析', async () => {
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid' }, tweet('205', 'slop', AI_TEXT));
  const art = win.document.querySelector('article');
  assert.equal(win.document.querySelector('.sloplast-bar').dataset.tier, 'high');

  // 虚拟列表把同一个节点回收去装另一条推文：整棵子树被换掉，角标跟着没了。
  // 真正的约束在这里 —— 这条 article 必须被重新扫到并重新判分。
  // 换进来的文本打 57 分（uncertain），和原来是两个档、两个分数，所以
  // 「没重扫」和「重扫了」在界面上分得开：没重扫就一个角标都没有。
  art.innerHTML = `
      <div data-testid="User-Name"><span>Name</span><a href="/slop2">@slop2</a></div>
      <div data-testid="tweetText">${AI_BIZ_TEXT}</div>
      <a href="/slop2/status/206"><time datetime="2026-10-30T10:00:00Z"></time></a>`;

  await tick();
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(bar, '回收后的推文必须被重新扫到，否则角标就永远丢了');
  assert.equal(bar.dataset.tier, 'uncertain', '应该按新文本重新判档');
  assert.equal(bar.querySelector('.sloplast-score').textContent, '57', '分数应该是新文本的');
  dom.window.close();
});

test('锚点晚到：先挂起，时间戳出现后补画', async () => {
  // 没有正文也没有时间戳 → 两处锚点都拿不到，这一轮不画，但要挂起重试
  const mediaOnly = `<article data-testid="tweet">
      <div data-testid="User-Name"><span>Name</span><a href="/m">@m</a></div>
    </article>`;
  const { dom, win } = boot({ mode: 'badge', sensitivity: 'mid', diagnostics: true }, mediaOnly);
  assert.equal(win.document.querySelector('.sloplast-bar'), null, '锚点没出来时不该硬插');

  win.document.querySelector('article').insertAdjacentHTML('beforeend',
    '<a href="/m/status/207"><time datetime="2026-10-30T10:00:00Z"></time></a>');

  await tick();
  const bar = win.document.querySelector('.sloplast-bar');
  assert.ok(bar, '锚点补上后应该重试成功');
  assert.equal(bar.dataset.tier, 'skipped');
  dom.window.close();
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
