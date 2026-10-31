/*
 * SlopLens service worker
 * ------------------------------------------------------------------
 * 它只干两件事：
 *   1. 右键菜单转发
 *   2. 代 content script 调 LLM —— 必须在这里 fetch，因为 content script
 *      的 fetch 继承页面源，会被 CORS 拦；扩展后台带上 host 权限后不受限。
 *
 * key 只在这里和 storage 之间流动，永远不进页面。
 */
importScripts('llm.js');

const LLM = globalThis.SlopLensLLM;

// ---------------- 右键菜单 ----------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sloplens-check',
    title: '用 SlopLens 检测选中文字',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'sloplens-check' || !tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'checkSelection' }).catch(() => {
    /* 页面不是 X，或 content script 尚未就绪，忽略 */
  });
});

// ---------------- 工具 ----------------
async function getConfig() {
  const { llm } = await chrome.storage.local.get('llm');
  return { ...LLM.DEFAULTS, ...(llm || {}) };
}

// 深检要不要带标注样本，由 llm.fewShot 决定（默认关：会把别的推文原文一起发出去）。
// 任何异常都退回「不带」——多发内容比少发一次严重。
async function examplesFor(cfg) {
  if (!cfg || !cfg.fewShot) return null;
  try {
    const { samples } = await chrome.storage.local.get('samples');
    return LLM.pickExamples(samples);
  } catch (_) {
    return null;
  }
}

function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return null;
  }
}

async function hasPermission(pattern) {
  if (!pattern) return false;
  try { return await chrome.permissions.contains({ origins: [pattern] }); }
  catch (_) { return false; }
}

async function bumpUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const { usage } = await chrome.storage.local.get('usage');
  const u = usage && usage.date === today ? usage : { date: today, count: 0 };
  u.count += 1;
  await chrome.storage.local.set({ usage: u });
  return u.count;
}

async function todayUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const { usage } = await chrome.storage.local.get('usage');
  return usage && usage.date === today ? usage.count : 0;
}

// ---------------- 消息处理 ----------------
async function handleDeepCheck(text) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, error: 'config', message: '深检没启用' };
  if (!cfg.key && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    return { ok: false, error: 'config', message: '还没填 API Key' };
  }

  const pattern = originPattern(cfg.baseUrl);
  if (!(await hasPermission(pattern))) {
    return { ok: false, error: 'permission', message: `没有 ${pattern} 的访问权限` };
  }

  const used = await todayUsage();
  const cap = Number(cfg.maxPerDay) || 200;
  if (used >= cap) return { ok: false, error: 'budget', message: `今日 ${cap} 次已用完` };

  const res = await LLM.classify(text, cfg, null, await examplesFor(cfg));
  if (res.ok) await bumpUsage();
  return res;
}

async function withGuard(run) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, error: 'config', message: '深检没启用' };
  if (!cfg.key && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
    return { ok: false, error: 'config', message: '还没填 API Key' };
  }

  const pattern = originPattern(cfg.baseUrl);
  if (!(await hasPermission(pattern))) {
    return { ok: false, error: 'permission', message: `没有 ${pattern} 的访问权限` };
  }

  const used = await todayUsage();
  const cap = Number(cfg.maxPerDay) || 200;
  if (used >= cap) return { ok: false, error: 'budget', message: `今日 ${cap} 次已用完` };

  const res = await run(cfg);
  if (res && res.ok) await bumpUsage();
  return res;
}

async function handleJudge(text) {
  return withGuard(async cfg => LLM.judge(text, cfg, null, await examplesFor(cfg)));
}

async function handleTest() {
  const cfg = await getConfig();
  const pattern = originPattern(cfg.baseUrl);
  if (!(await hasPermission(pattern))) {
    return { ok: false, error: 'permission', message: `没有 ${pattern} 的访问权限` };
  }
  return LLM.classify('今天下午三点开会，记得把上周的报表带上，别忘了。', cfg);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'deepCheck') {
    handleDeepCheck(String(msg.text || '')).then(sendResponse, e =>
      sendResponse({ ok: false, error: 'internal', message: String(e && e.message) }));
    return true; // 保持消息通道，等异步结果
  }

  if (msg.type === 'aiJudge') {
    handleJudge(String(msg.text || '')).then(sendResponse, e =>
      sendResponse({ ok: false, error: 'internal', message: String(e && e.message) }));
    return true;
  }

  if (msg.type === 'testLLM') {
    handleTest().then(sendResponse, e =>
      sendResponse({ ok: false, error: 'internal', message: String(e && e.message) }));
    return true;
  }

  if (msg.type === 'batchRelay') {
    // popup 够不到 content script，只能由后台转发给当前标签页
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab || !tab.id) { sendResponse({ ok: false, message: '没有活动标签页' }); return; }
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'batchJudge' });
        sendResponse(r || { ok: false });
      } catch (e) {
        sendResponse({ ok: false, message: '当前标签页不是 x.com，或脚本还没就绪' });
      }
    }, () => sendResponse({ ok: false, message: '查询标签页失败' }));
    return true;
  }

  if (msg.type === 'usage') {
    todayUsage().then(n => sendResponse({ ok: true, count: n }), () => sendResponse({ ok: false }));
    return true;
  }
});
