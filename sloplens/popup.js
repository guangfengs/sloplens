const DEFAULTS = {
  mode: 'badge', sensitivity: 'mid', badgePosition: 'header', diagnostics: false,
  lowQuality: true, lowSpecLevel: 'mid', markIncomplete: true,
};
// 默认值只认 llm.js 那一份，避免两处脱节（之前就是这里漏了，字段是空的）
const LLM_DEFAULTS = (globalThis.SlopLensLLM && globalThis.SlopLensLLM.DEFAULTS)
  || { enabled: false, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: '', maxPerDay: 200, fewShot: false };

const $ = id => document.getElementById(id);

function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return null;
  }
}

function setStatus(text, isError) {
  const el = $('llm-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

const ERROR_TEXT = {
  permission: '没有这个接口地址的访问权限，点「保存」重新授权',
  auth: 'key 无效或被拒绝',
  rate: '触发限流，过一会儿再试',
  budget: '今天的调用额度用完了',
  network: '连不上接口（国内直连可能需要代理）',
  parse: '模型返回格式不对，换个模型试试',
  server: '服务端报错',
  config: '深检没启用，或地址 / 模型 / key 没填全',
  http: '接口返回错误',
};

// ---------------- 主面板 ----------------
function paint(settings, stats, samples) {
  for (const [groupId, current] of [
    ['mode', settings.mode],
    ['sens', settings.sensitivity],
    ['pos', settings.badgePosition || 'header'],
    ['lowspec', settings.lowSpecLevel || 'mid'],
  ]) {
    document.querySelectorAll(`#${groupId} button`).forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.v === current));
    });
  }
  $('s-scanned').textContent = stats.scanned || 0;
  $('s-marked').textContent = (stats.high || 0) + (stats.uncertain || 0) + (stats.low || 0);
  $('s-skipped').textContent = stats.skipped || 0;
  $('s-trunc').textContent = (stats.truncated || 0) + (stats.partial || 0);
  const n = (samples || []).length;
  $('export').textContent = n ? `导出反馈样本（${n} 条）` : '导出反馈样本';
  $('diag-on').checked = !!settings.diagnostics;
  $('lowq-on').checked = !!settings.lowQuality;
  $('incompl-on').checked = !!settings.markIncomplete;
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

function download(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function load() {
  chrome.storage.local.get(['settings', 'stats', 'samples', 'llm'], d => {
    const settings = { ...DEFAULTS, ...(d.settings || {}) };
    paint(settings, d.stats || {}, d.samples || []);
    bind(settings, d.stats || {}, d.samples || []);
    fillLLM(d.llm || {});
    bindLLM();
    refreshUsage();
    refreshFewShotCount();
  });
}

function bind(settings, stats, samples) {
  document.querySelectorAll('#mode button').forEach(b => {
    b.onclick = () => {
      settings = { ...settings, mode: b.dataset.v };
      chrome.storage.local.set({ settings });
      paint(settings, stats, samples);
    };
  });
  document.querySelectorAll('#sens button').forEach(b => {
    b.onclick = () => {
      settings = { ...settings, sensitivity: b.dataset.v };
      chrome.storage.local.set({ settings });
      paint(settings, stats, samples);
    };
  });
  document.querySelectorAll('#pos button').forEach(b => {
    b.onclick = () => {
      settings = { ...settings, badgePosition: b.dataset.v };
      chrome.storage.local.set({ settings });
      paint(settings, stats, samples);
    };
  });

  $('export').onclick = () => {
    chrome.storage.local.get(['settings', 'stats', 'samples'], d => {
      const list = d.samples || [];
      if (!list.length) {
        $('export').textContent = '还没有反馈样本';
        setTimeout(() => { $('export').textContent = '导出反馈样本'; }, 1600);
        return;
      }
      download({
        exportedAt: new Date().toISOString(),
        engine: list[0] && list[0].engine,
        settings: d.settings || DEFAULTS,
        stats: d.stats || {},
        samples: list,
      }, `sloplens-samples-${stamp()}.json`);
    });
  };

  // 诊断数据：含未标记的。用来判断到底是「判分低」还是「没扫到」。
  $('export-diag').onclick = () => {
    chrome.storage.local.get('diag', d => {
      const diag = d.diag;
      if (!diag || !diag.items || !diag.items.length) {
        $('export-diag').textContent = '先打开诊断模式刷一会儿';
        setTimeout(() => { $('export-diag').textContent = '导出诊断数据（含未标记）'; }, 2200);
        return;
      }
      download(diag, `sloplens-diag-${stamp()}.json`);
    });
  };

  $('batch-judge').onclick = async () => {
    const btn = $('batch-judge');
    const orig = btn.textContent;
    btn.textContent = '预判中…（看页面底部进度）';
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'batchRelay' });
      if (res && res.ok) {
        btn.textContent = res.done ? `完成 ${res.done}/${res.total}` : '没有待预判的内容';
      } else {
        btn.textContent = '失败：' + (res && res.message ? res.message : '未知');
      }
    } catch (e) {
      btn.textContent = '失败：' + String(e && e.message);
    }
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2600);
  };

  $('diag-on').onchange = () => {
    settings = { ...settings, diagnostics: $('diag-on').checked };
    chrome.storage.local.set({ settings });
  };

  $('lowq-on').onchange = () => {
    settings = { ...settings, lowQuality: $('lowq-on').checked };
    chrome.storage.local.set({ settings });
  };

  document.querySelectorAll('#lowspec button').forEach(b => {
    b.onclick = () => {
      settings = { ...settings, lowSpecLevel: b.dataset.v };
      chrome.storage.local.set({ settings });
      paint(settings, stats, samples);
    };
  });

  $('incompl-on').onchange = () => {
    settings = { ...settings, markIncomplete: $('incompl-on').checked };
    chrome.storage.local.set({ settings });
  };
}

// ---------------- 深检配置 ----------------
function fillLLM(cfg) {
  const c = { ...LLM_DEFAULTS, ...cfg };
  $('llm-enabled').checked = !!c.enabled;
  // 空字符串也当没填，回落到默认值——用户之前存过空值也不会看到空白
  $('llm-base').value = c.baseUrl || LLM_DEFAULTS.baseUrl;
  $('llm-model').value = c.model || LLM_DEFAULTS.model;
  $('llm-key').value = c.key || '';
  $('llm-cap').value = c.maxPerDay || 200;
  $('llm-fewshot').checked = !!c.fewShot;
}

async function saveLLM() {
  const cfg = {
    enabled: $('llm-enabled').checked,
    baseUrl: $('llm-base').value.trim() || LLM_DEFAULTS.baseUrl,
    model: $('llm-model').value.trim() || LLM_DEFAULTS.model,
    key: $('llm-key').value.trim(),
    maxPerDay: Math.max(1, Math.min(5000, Number($('llm-cap').value) || 200)),
    fewShot: $('llm-fewshot').checked,
  };

  if (!cfg.enabled) {
    await chrome.storage.local.set({ llm: cfg });
    setStatus('已保存（深检未启用）');
    return cfg;
  }

  if (!cfg.baseUrl || !cfg.model) {
    setStatus('接口地址和模型都要填', true);
    return null;
  }

  const pattern = originPattern(cfg.baseUrl);
  if (!pattern) {
    setStatus('接口地址格式不对，要填完整的 https://…', true);
    return null;
  }

  // 直接请求，不先 await contains —— 先 await 一次再 request 有丢失
  // 用户手势（user activation）的风险，Chrome 会直接拒掉。
  // request 对已授权的 origin 会立刻返回 true。
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (_) {}
  if (!granted) {
    setStatus(`没拿到 ${pattern} 的权限，深检无法工作`, true);
    return null;
  }

  await chrome.storage.local.set({ llm: cfg });
  setStatus('已保存');
  return cfg;
}

async function refreshUsage() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'usage' });
    if (res && res.ok) $('llm-used').textContent = res.count;
  } catch (_) {}
}

// 显示「当前可用几条样本」。必须按 pickExamples 的口径算，不能直接报 samples.length——
// 用户标了 20 条但全是「说不清」时，直接报条数会显示 20 却不生效，反而更让人困惑。
async function refreshFewShotCount() {
  try {
    const { samples } = await chrome.storage.local.get('samples');
    const L = globalThis.SlopLensLLM;
    const ex = (L && L.pickExamples) ? L.pickExamples(samples) : { ai: [], human: [] };
    $('llm-fewshot-n').textContent = String(ex.ai.length + ex.human.length);
  } catch (_) {}
}

function bindLLM() {
  $('llm-save').onclick = async () => { await saveLLM(); refreshUsage(); refreshFewShotCount(); };

  $('llm-test').onclick = async () => {
    setStatus('测试中…');
    const cfg = await saveLLM();
    if (!cfg) return;
    if (!cfg.enabled) { setStatus('先勾上「启用深检」再测', true); return; }

    try {
      const res = await chrome.runtime.sendMessage({ type: 'testLLM' });
      if (res && res.ok) {
        setStatus(`连接正常 · 这条测试文本得分 ${res.score}（模板化 ${res.templated} / 具体信息 ${res.specificity}）`);
      } else {
        setStatus('失败：' + (ERROR_TEXT[res && res.error] || (res && res.message) || '未知错误'), true);
      }
    } catch (e) {
      setStatus('失败：' + String(e && e.message), true);
    }
  };

  $('llm-panel').addEventListener('toggle', () => {
    if (!$('llm-panel').open) return;
    refreshUsage();
    refreshFewShotCount();
  });
}

load();
