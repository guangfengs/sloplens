/*
 * SlopLens content script
 * ------------------------------------------------------------------
 * 只做四件事：
 *   1. 在 X 的时间线里增量扫描推文（虚拟列表，滚过去会卸载，所以要缓存）
 *   2. 调本地规则引擎打分，映射成三档
 *   3. 注入角标 / 折叠 / 判定依据面板
 *   4. 把「判错了」的样本存到本地，供后续重训
 *
 * 刻意不做的事：不改 X 的请求、不自动拉黑、不自动举报、不上传任何内容。
 */
(() => {
  'use strict';

  const E = globalThis.SlopLensEngine;
  if (!E) return;

  // foldSpec = 折叠的第二道闸：具体信息必须 ≤ 这个数，否则只标记不折叠。
  // t0-2 之前写死在 tierOf 里（35）；做成字段是为了让 tools/calibrate.mjs
  // 能用你自己的标注数据把这三个数一起标出来，标完直接贴回来。
  const PRESETS = {
    low: { high: 78, mid: 58, foldSpec: 35 }, // 保守：少标
    mid: { high: 70, mid: 45, foldSpec: 35 }, // 默认
    hi:  { high: 62, mid: 35, foldSpec: 35 }, // 激进：多标
  };
  const MIN_LEN = 16; // 太短的不判，避免胡说。中文推文普遍短，25 会漏掉一大片

  // 低信息角标：具体信息 ≤ 阈值才灰标。
  // 这是「内容密度」，不是「是不是 AI」——真人写的空话也在这里，所以它永不折叠。
  //
  // 阈值做成三档，因为「多少算没料」因人而异，而且这个数只能靠标注数据标定：
  //   strict 15 只标最空的 / mid 30 默认 / loose 45 想大面积过滤用
  // 20 那个初值在实际 feed 上一条都没触发，所以默认放到 30。
  const LOW_SPEC_LEVELS = { strict: 15, mid: 30, loose: 45 };
  const lowSpec = () => LOW_SPEC_LEVELS[state.settings.lowSpecLevel] ?? LOW_SPEC_LEVELS.mid;

  const state = {
    settings: {
      mode: 'badge', sensitivity: 'mid', badgePosition: 'header', diagnostics: false,
      lowQuality: true,      // 具体信息过低 → 灰标「低信息」，永不折叠
      lowSpecLevel: 'mid',   // 低信息的阈值档：strict / mid / loose
      markIncomplete: true,  // 截断 / 半截 这类「内容不完整」的记号
    },
    recs: new Map(),        // tweetId -> rec
    handleIds: new Map(),   // handle -> Set<id>
    recent: [],             // 最近文本的 3-gram，用于文案簇查重
    samples: [],
    stats: { scanned: 0, high: 0, uncertain: 0 },
  };

  // ---------------- 工具 ----------------
  const preset = () => PRESETS[state.settings.sensitivity] || PRESETS.mid;

  // 折叠条件 = 套路高 且 具体信息低（才是「低质量的 AI 内容」）
  // 只有套路高但信息量够 → 只标记，不折叠
  // 阈值判的就是界面上那个数字（空话指数），不会出现「显示 50 却不标记」。
  // 具体信息只做第二道闸：只有「空话高 且 具体低」才折叠。
  const tierOf = (score, specificity) => {
    const p = preset();
    const foldSpec = typeof p.foldSpec === 'number' ? p.foldSpec : 35;
    if (score >= p.high && specificity <= foldSpec) return 'high';
    if (score >= p.mid) return 'uncertain';
    return 'none';
  };

  // 唯一分档入口：扫描、设置变更重算，全都走这里，免得两处逻辑走岔。
  //
  // 优先级：内容不完整 > 空话 > 低信息。
  //   - 截断（X 折叠）/ 半截（作者自己把后半段放到回复里）：文本不全，
  //     分数不可信，所以既不折叠、也不算低质，只留记号。
  //   - 低信息：只在「空话没命中」时才标，一条推最多一个角标，不叠着吼。
  const tierFor = rec => {
    if (rec.truncated || rec.partial) {
      if (!state.settings.markIncomplete) return 'none';
      return rec.truncated ? 'truncated' : 'partial';
    }
    const t = tierOf(rec.score, rec.specificity ?? 0);
    if (t !== 'none') return t;
    if (state.settings.lowQuality
      && typeof rec.specificity === 'number' && rec.specificity <= lowSpec()) {
      return 'low';
    }
    return 'none';
  };

  const normDup = t => t
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@[a-z0-9_]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

  function grams(t) {
    const n = 3, s = new Set();
    if (t.length < n) { if (t) s.add(t); return s; }
    for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n));
    return s;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
  }

  // ---------------- 从 DOM 取数据 ----------------
  const inQuote = el => !!(el.closest && el.closest('[data-testid="quoteTweet"]'));

  function ownTextEl(article) {
    for (const n of article.querySelectorAll('[data-testid="tweetText"]')) {
      if (!inQuote(n)) return n;
    }
    return null;
  }

  // X 把长推截断成「显示更多」，此时 innerText 只有可见的一段。
  // 拿半截话去打分是不成立的（会重演「没数字 → 低信息」的误伤），
  // 所以这类内容一律不参与折叠和低质判定，只留一个记号。
  const SHOW_MORE = /^(show more|显示更多|显示全文|展开全文|展开)$/i;

  // 作者故意发半截、把后半段放在自己的回复里。和「X 折叠」长得像但不是一回事：
  // 这里能看到的字就是作者打出来的全部，可内容还没说完。
  //
  // 只认强信号，宁可漏也不误标——中文推文本来就很少写句末标点，
  // 单纯「结尾没有。」会把半个 feed 都标上。
  const PARTIAL_MARKS = [
    /[（(]\s*\d{1,2}\s*[\/／]\s*\d{1,2}\s*[）)]/,   // （1/2）
    /接下文|见下条|下条继续|未完待续|未完|（续）|\(续\)|续👇/,
    /👇\s*$/u,                                        // 结尾一个指向回复的手势
  ];
  const PARTIAL_END = /[，、,；;…]$|(——|--|\.\.\.)$/;   // 悬空结尾

  function isPartial(text) {
    const t = (text || '').trim();
    if (t.length < 6) return false;
    // 显式标记（（1/2）、接下文、结尾👇）短也算
    if (PARTIAL_MARKS.some(re => re.test(t))) return true;
    // 只看「悬空结尾」的话必须够长：中文推文本来就少写句末标点，
    // 「就这样吧…」「今天真热，」是完整表达，不能标。
    return t.length >= 16 && PARTIAL_END.test(t);
  }

  function isTruncated(article) {
    // 只认「这条自己的」显示更多，别把引用推里的算进来
    for (const n of article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')) {
      if (!inQuote(n)) return true;
    }
    const el = ownTextEl(article);
    if (!el) return false;
    // 兜底：X 的 testid 会变，退回看「显示更多」那个链接/按钮。
    // 只认 a 和 role=button，避免正文里正好提到 "show more" 被误判。
    for (const n of el.querySelectorAll('a, [role="button"]')) {
      if (SHOW_MORE.test((n.innerText || n.textContent || '').trim())) return true;
    }
    return false;
  }

  function tweetId(article) {
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      if (inQuote(a)) continue;
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function handleOf(article) {
    const el = article.querySelector('[data-testid="User-Name"]');
    if (!el) return '';
    const m = (el.innerText || '').match(/@[A-Za-z0-9_]+/);
    return m ? m[0] : '';
  }

  // ---------------- 排除自己 ----------------
  // 给作者本人打「空话 82」没有任何意义。X 的侧边栏有好几种写法，任一条命中就够用；
  // 一条都拿不到时返回 null，宁可漏排也不猜——猜错了就会把别人当成你。
  let selfCache = null;
  function selfHandle() {
    if (selfCache) return selfCache;

    // 1) 左侧导航「个人资料」入口，href 就是 /<handle>
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const href = link && link.getAttribute('href');
    if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
      selfCache = '@' + href.slice(1);
      return selfCache;
    }

    // 2) 左下角账号切换按钮，文本形如 "Jormungandr@NewJormungandr"
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      const m = (switcher.innerText || '').match(/@[A-Za-z0-9_]+/);
      if (m) { selfCache = m[0]; return selfCache; }

      // 3) 切换按钮里的头像容器，testid 形如 UserAvatar-Container-<handle>。
      //    必须限定在 switcher 内部——页面上每条推文的头像都是同一个前缀。
      const avatar = switcher.querySelector('[data-testid^="UserAvatar-Container-"]');
      const raw = avatar && (avatar.getAttribute('data-testid') || '');
      const handle = raw ? raw.slice('UserAvatar-Container-'.length) : '';
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle) && handle !== 'unknown') {
        selfCache = '@' + handle;
        return selfCache;
      }
    }

    // 侧边栏还没渲染出来：这次不缓存，下一轮扫描再试
    return null;
  }

  // 统计是「增量累加」的，把一条已经计过数的推文改判成别的档位时必须先减回去，
  // 否则 popup 上的数字会越飘越远。
  const TIER_KEY = {
    high: 'high', uncertain: 'uncertain', low: 'low',
    truncated: 'truncated', partial: 'partial', skipped: 'skipped',
  };
  function uncountStat(tier) {
    const s = state.stats;
    s.scanned = Math.max(0, (s.scanned || 0) - 1);
    const k = TIER_KEY[tier];
    if (k) s[k] = Math.max(0, (s[k] || 0) - 1);
  }

  // 虚拟列表滚过去就卸载，rec 全靠内存兜着；开一整天会一直涨。
  // 给个上限，超了按插入顺序丢最早的（它们早滚出视野了，再遇到会重新判一遍）。
  const MAX_RECS = 4000;
  function rememberRec(rec) {
    state.recs.set(rec.id, rec);
    if (state.recs.size <= MAX_RECS) return;
    let drop = state.recs.size - MAX_RECS;
    for (const k of state.recs.keys()) {
      if (drop-- <= 0) break;
      state.recs.delete(k);
    }
  }

  // ---------------- 扫描 ----------------
  function process(article) {
    if (article.closest('[data-testid="quoteTweet"]')) return true;
    if (article.closest('[data-testid="placementTracking"]')) return true; // 推广帖不动

    const id = tweetId(article);
    if (!id) return true;

    const handle = handleOf(article);

    // 自己的推文不判，也不进统计
    const self = selfHandle();
    if (self && handle === self) {
      const prev = state.recs.get(id);
      if (prev && prev.tier !== 'skipped') uncountStat(prev.tier);
      const skip = {
        id, text: '', handle: self, score: 0, raw: 0, features: [],
        tier: 'skipped', skipReason: '本人',
        open: false, expanded: false, verdict: null,
      };
      rememberRec(skip);
      clearUI(article);
      return state.settings.diagnostics ? ensureUI(article, skip) : true;
    }

    let rec = state.recs.get(id);

    // 用户点过「显示更多」→ 现在有全文了，按全文重算一遍。
    // 之前那个分数是按半截话算的，不能留着。
    if (rec && rec.truncated && !isTruncated(article)) {
      const full = ownTextEl(article);
      const t2 = full ? (full.innerText || '').trim() : '';
      if (t2.length >= MIN_LEN) {
        const r2 = E.analyze(t2, { handleSeen: 1, dupCount: 0 });
        Object.assign(rec, {
          text: t2, score: r2.score, raw: r2.raw, features: r2.features,
          templated: r2.templated, specificity: r2.specificity, engine: r2.engine,
          truncated: false, partial: isPartial(t2),
        });
        rec.tier = tierFor(rec);
        persistDiag();
      }
    }

    if (!rec) {
      const textEl = ownTextEl(article);
      const text = textEl ? (textEl.innerText || '').trim() : '';

      // 没扫描成功的也记一笔，否则永远不知道是「判分低」还是「没扫到」
      if (!text || text.length < MIN_LEN) {
        rec = {
          id, text, handle: '',
          score: 0, raw: 0, features: [],
          tier: 'skipped',
          skipReason: text ? '太短' : '无文字',
          open: false, expanded: false, verdict: null,
        };
        rememberRec(rec);
        state.stats.skipped = (state.stats.skipped || 0) + 1;
        persistStats();
        persistDiag();
        return state.settings.diagnostics ? ensureUI(article, rec) : true;
      }

      // 文案簇：和最近 120 条比 3-gram Jaccard
      const g = grams(normDup(text));
      let dup = 0;
      for (const r of state.recent) if (jaccard(g, r.g) >= 0.65) dup++;

      const seenN = (state.handleIds.get(handle) || new Set()).size;
      const res = E.analyze(text, { handleSeen: seenN + 1, dupCount: dup });

      rec = {
        id, text, handle,
        score: res.score, raw: res.raw, features: res.features,
        templated: res.templated, specificity: res.specificity,
        engine: res.engine,
        // 被截断 / 作者自己发半截：分数照算（诊断要用），但不参与任何判定
        truncated: isTruncated(article),
        partial: isPartial(text),
        open: false, expanded: false, verdict: null,
      };
      rec.tier = tierFor(rec);
      rememberRec(rec);

      state.recent.push({ id, g });
      if (state.recent.length > 120) state.recent.shift();

      if (handle) {
        let ids = state.handleIds.get(handle);
        if (!ids) { ids = new Set(); state.handleIds.set(handle, ids); }
        ids.add(id);
      }

      state.stats.scanned++;
      if (rec.tier === 'high') state.stats.high++;
      else if (rec.tier === 'uncertain') state.stats.uncertain++;
      else if (rec.tier === 'low') state.stats.low = (state.stats.low || 0) + 1;
      else if (rec.tier === 'truncated') state.stats.truncated = (state.stats.truncated || 0) + 1;
      else if (rec.tier === 'partial') state.stats.partial = (state.stats.partial || 0) + 1;
      persistStats();
      persistDiag();
    }

    return ensureUI(article, rec);
  }

  // ---------------- 渲染 ----------------
  const uiKey = rec => [
    rec.tier, rec.open ? 1 : 0, rec.expanded ? 1 : 0, rec.verdict || '-',
    state.settings.mode, state.settings.badgePosition,
    state.settings.diagnostics ? 'd' : '-',
    state.settings.lowQuality ? 'L' : '-',
    state.settings.markIncomplete ? 'I' : '-',
  ].join('|');

  function clearUI(article) {
    article.querySelectorAll('.sloplast-bar, .sloplast-panel').forEach(e => e.remove());
    article.classList.remove('sloplast-folded');
  }

  // 时间戳所在的那个 flex 行（名字 / @handle / · / 时间 / 翻译 / 更多）
  function headerAnchor(article) {
    const time = article.querySelector('time');
    if (!time) return null;
    const link = time.closest('a');
    const holder = link && link.parentElement;
    return holder || link || null;
  }

  // 返回 true = 这条已经画完（或者本来就该什么都不画），不用再重扫；
  // 返回 false = 锚点还没渲染出来，得留到下一轮再试。
  // 调用方靠这个返回值维护 pending 集合，别改成 undefined。
  function ensureUI(article, rec) {
    const diag = !!state.settings.diagnostics;
    const marked = rec.tier === 'high' || rec.tier === 'uncertain' || rec.tier === 'low';
    const incompl = rec.tier === 'truncated' || rec.tier === 'partial';
    const diagRow = diag && (rec.tier === 'none' || rec.tier === 'skipped');

    if (state.settings.mode === 'off' || (!marked && !incompl && !diagRow)) { clearUI(article); return true; }

    const key = uiKey(rec);
    if (article.querySelector('.sloplast-bar') && article.dataset.sloplastKey === key) return true;

    article.dataset.sloplastKey = key;
    clearUI(article);

    const textEl = ownTextEl(article);
    const pos = state.settings.badgePosition === 'below' ? 'below' : 'header';
    const inline = pos === 'header';
    const barAnchor = (inline ? headerAnchor(article) : null) || textEl;
    if (!barAnchor) return false;

    // ---- 内容不完整：只留一个记号，不显示分数、不参与判定 ----
    if (incompl) {
      const isTrunc = rec.tier === 'truncated';
      const t = document.createElement('div');
      t.className = 'sloplast-bar sloplast-bar--trunc'
        + (barAnchor === textEl ? '' : ' sloplast-bar--inline');
      t.dataset.tier = rec.tier;
      t.title = isTrunc
        ? '这条被 X 折断了，全文要点开才看得到。半截文本打出来的分不可信，所以不参与判定。'
        : '作者只发了前半段，后半段在自己的回复里。内容不全，所以不参与判定——往下翻他的回复。';
      const d = document.createElement('span');
      d.className = 'sloplast-dot';
      const l = document.createElement('span');
      l.textContent = isTrunc ? '需展开' : '半截';
      t.append(d, l);
      barAnchor.insertAdjacentElement('afterend', t);
      return true;
    }

    const skipped = rec.tier === 'skipped';
    const isLow = rec.tier === 'low';
    const folded = !skipped && marked && state.settings.mode === 'fold'
      && rec.tier === 'high' && !rec.expanded;

    // 低信息角标显示的是「具体信息」，不是「空话指数」——两个数方向相反，不能混着看
    const shown = isLow ? (rec.specificity ?? 0) : rec.score;

    const bar = document.createElement('div');
    bar.className = 'sloplast-bar'
      + (barAnchor === textEl ? '' : ' sloplast-bar--inline')
      + (marked ? '' : ' sloplast-bar--diag');
    bar.dataset.tier = rec.tier;
    if (rec.aiJ && rec.aiJ.ok) bar.dataset.ai = rec.aiJ.verdict;
    bar.setAttribute('role', 'button');
    bar.tabIndex = 0;
    bar.title = skipped ? `未参与判定：${rec.skipReason}`
      : isLow ? `具体信息 ${shown}（0–100，越低越空；这不是 AI 判定）· 空话指数 ${rec.score}。点开看依据`
      : marked ? (folded ? `空话指数 ${rec.score}（越高越空）· 套路化 ${rec.templated ?? '-'} / 具体信息 ${rec.specificity ?? '-'}。点开查看依据`
        : `空话指数 ${rec.score} · 套路化 ${rec.templated ?? '-'} / 具体信息 ${rec.specificity ?? '-'}。点开看依据；判错了请点一下`)
      : `空话指数 ${rec.score}，低于当前灵敏度阈值，所以不标记`;

    const dot = document.createElement('span');
    dot.className = 'sloplast-dot';

    const label = document.createElement('span');
    const compact = barAnchor !== textEl;
    label.textContent = skipped ? rec.skipReason
      : folded ? '已折叠'
      : rec.tier === 'high' ? (compact ? '空话' : '空话较多')
      : rec.tier === 'uncertain' ? '存疑'
      : isLow ? '低信息'
      : '未标记';

    const scoreEl = document.createElement('span');
    scoreEl.className = 'sloplast-score';
    // 诊断模式下，没标记的那批显示「具体信息」——这才看得出低信息为什么不触发
    scoreEl.textContent = skipped ? ''
      : (diag && rec.tier === 'none') ? `具体 ${rec.specificity ?? '-'}`
      : String(shown);

    bar.append(dot, label, scoreEl);

    // 角标在 header 里，点击很容易顺带触发 X 的「打开推文」，
    // 所以这里必须同时 preventDefault + stopPropagation。
    // 跳过的推文没有内容可看，就不挂点击了。
    if (!skipped) {
      const toggle = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        rec.open = !rec.open;
        if (rec.open) rec.expanded = true;
        article.dataset.sloplastKey = '';
        ensureUI(article, rec);
      };
      bar.addEventListener('click', toggle);
      bar.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') toggle(ev);
      });
    }

    barAnchor.insertAdjacentElement('afterend', bar);

    if (!skipped) {
      // 面板永远放在正文后面，避免撑坏 header 的 flex 行
      const panelAnchor = (barAnchor !== textEl && textEl) ? textEl : bar;
      const panel = buildPanel(article, rec);
      panel.hidden = !rec.open;
      panelAnchor.insertAdjacentElement('afterend', panel);
    }

    article.classList.toggle('sloplast-folded', folded);
    return true;
  }

  function buildPanel(article, rec) {
    const panel = document.createElement('div');
    panel.className = 'sloplast-panel';

    // 先把「这个分数是什么方向」说清楚，否则用户会以为高=好
    const head = document.createElement('div');
    head.className = 'sloplast-head';
    const two = (typeof rec.templated === 'number' && typeof rec.specificity === 'number')
      ? `套路化 ${rec.templated} · 具体信息 ${rec.specificity}`
      : '';
    const low = rec.tier === 'low';
    head.textContent = low
      ? `具体信息 ${rec.specificity ?? 0} / 100（越低越空）　空话指数 ${rec.score}${two ? '　' + two : ''}`
      : `空话指数 ${rec.score} / 100（越高越空）${two ? '　' + two : ''}`;

    const rule = document.createElement('div');
    rule.className = 'sloplast-head';
    rule.textContent = low
      ? '低信息 = 没有数字、时间、地点、亲历细节、直接引语。真人写的空话也在这里，所以它只标记、不折叠。'
      : '折叠条件：套路化高 且 具体信息低。只有套路高但内容有料的，只标记不折叠。';

    panel.append(head, rule);

    const list = document.createElement('ul');
    list.className = 'sloplast-reasons';
    const feats = rec.features.slice(0, 5);
    if (!feats.length) {
      const li = document.createElement('li');
      li.textContent = '没有命中明显特征';
      list.appendChild(li);
    }
    for (const f of feats) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = f.name;
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = (f.weight > 0 ? '+' : '') + f.weight;
      li.append(name, w);
      list.appendChild(li);
    }
    panel.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'sloplast-actions';

    [['ai', '这是 AI'], ['human', '这是真人'], ['unsure', '说不清']].forEach(([v, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (rec.verdict === v) b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        rec.verdict = rec.verdict === v ? null : v;
        if (rec.verdict) saveSample(rec);
        article.dataset.sloplastKey = '';
        ensureUI(article, rec);
      });
      actions.appendChild(b);
    });

    if (rec.verdict) {
      const s = document.createElement('span');
      s.className = 'sloplast-saved';
      s.textContent = '已记录';
      actions.appendChild(s);
    }

    // ---- 深检（可选，用户自己的 key）----
    const deepBtn = document.createElement('button');
    deepBtn.type = 'button';
    deepBtn.textContent = rec.deep && rec.deep.ok ? '重新深检' : '深检';
    deepBtn.title = '把这条发给你在设置里填的模型，结果只显示在这里，不影响折叠';
    if (rec.deepBusy) { deepBtn.disabled = true; deepBtn.textContent = '检测中…'; }
    deepBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (rec.deepBusy) return;
      rec.deepBusy = true;
      article.dataset.sloplastKey = '';
      ensureUI(article, rec);

      chrome.runtime.sendMessage({ type: 'deepCheck', text: rec.text })
        .then(res => { rec.deep = res || { ok: false, error: 'internal' }; })
        .catch(e => { rec.deep = { ok: false, error: 'internal', message: String(e && e.message) }; })
        .finally(() => {
          rec.deepBusy = false;
          article.dataset.sloplastKey = '';
          ensureUI(article, rec);
        });
    });
    actions.appendChild(deepBtn);

    // ---- AI 预判（可选，用户自己的 key）----
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.textContent = rec.aiJ && rec.aiJ.ok ? '重新预判' : 'AI 预判';
    aiBtn.title = '让模型给一个初判和证据，你只需要确认或否决';
    if (rec.aiBusy) { aiBtn.disabled = true; aiBtn.textContent = '预判中…'; }
    aiBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (rec.aiBusy) return;
      rec.aiBusy = true;
      article.dataset.sloplastKey = '';
      ensureUI(article, rec);

      chrome.runtime.sendMessage({ type: 'aiJudge', text: rec.text })
        .then(res => { rec.aiJ = res || { ok: false, error: 'internal' }; })
        .catch(e => { rec.aiJ = { ok: false, error: 'internal', message: String(e && e.message) }; })
        .finally(() => {
          rec.aiBusy = false;
          article.dataset.sloplastKey = '';
          ensureUI(article, rec);
        });
    });
    actions.appendChild(aiBtn);

    panel.appendChild(actions);

    // ---- AI 预判结果 ----
    if (rec.aiJ) panel.appendChild(buildAiBlock(article, rec));

    // ---- 深检结果 ----
    if (rec.deep) {
      const box = document.createElement('div');
      box.className = 'sloplast-deep';
      if (rec.deep.ok) {
        box.textContent = `深检 ${rec.deep.score} · 模板化 ${rec.deep.templated} / 具体信息 ${rec.deep.specificity}`;
        if (rec.deep.reasons && rec.deep.reasons.length) {
          const ul = document.createElement('ul');
          ul.className = 'sloplast-reasons';
          for (const r of rec.deep.reasons) {
            const li = document.createElement('li');
            li.textContent = r;
            ul.appendChild(li);
          }
          box.appendChild(ul);
        }
      } else {
        box.textContent = '深检失败：' + deepErrorText(rec.deep.error);
        box.title = rec.deep.message || '';
      }
      panel.appendChild(box);
    }

    return panel;
  }

  function buildAiBlock(article, rec) {
    const box = document.createElement('div');
    box.className = 'sloplast-ai';
    const r = rec.aiJ;

    if (!r.ok) {
      box.textContent = 'AI 预判失败：' + deepErrorText(r.error);
      box.title = r.message || '';
      return box;
    }

    const vText = r.verdict === 'ai' ? '像 AI' : r.verdict === 'human' ? '像真人' : '不确定';
    const head = document.createElement('div');
    head.textContent = `AI 预判：${vText} · 置信 ${r.confidence}`;
    box.appendChild(head);

    const sc = document.createElement('div');
    sc.className = 'sloplast-head';
    sc.textContent = `结构 ${r.scores.A} · 套路 ${r.scores.B} · 具体 ${r.scores.C} · 自然 ${r.scores.D}（各 0-3）`;
    box.appendChild(sc);

    if (r.evidence && r.evidence.length) {
      const ul = document.createElement('ul');
      ul.className = 'sloplast-reasons';
      for (const e of r.evidence) {
        const li = document.createElement('li');
        const q = document.createElement('span');
        q.textContent = `「${e.quote}」${e.why ? ' ' + e.why : ''}`;
        const d = document.createElement('span');
        d.className = 'w';
        d.textContent = e.dim;
        li.append(q, d);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    if (r.note) {
      const n = document.createElement('div');
      n.className = 'sloplast-head';
      n.textContent = r.note;
      box.appendChild(n);
    }

    const bar = document.createElement('div');
    bar.className = 'sloplast-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '采纳这个判断';
    ok.title = '采纳后仍可在上面改';
    ok.addEventListener('click', ev => {
      ev.stopPropagation();
      rec.verdict = r.verdict;
      rec.labelSource = 'ai-confirmed';
      saveSample(rec);
      article.dataset.sloplastKey = '';
      ensureUI(article, rec);
    });
    bar.appendChild(ok);
    box.appendChild(bar);

    return box;
  }

  function deepErrorText(code) {
    switch (code) {
      case 'config': return '还没在设置里填 key 或启用深检';
      case 'permission': return '没有这个接口地址的访问权限，回设置里重新保存一次';
      case 'auth': return 'key 无效或被拒绝';
      case 'rate': return '触发限流，过一会儿再试';
      case 'budget': return '今天的调用额度用完了';
      case 'network': return '连不上接口（国内可能需要代理）';
      case 'parse': return '模型返回的格式不对';
      case 'server': return '服务端报错';
      default: return code || '未知错误';
    }
  }

  // ---------------- 存样本 ----------------
  function saveSample(rec) {
    const sample = {
      id: rec.id,
      text: rec.text,
      handle: rec.handle,
      score: rec.score,
      templated: rec.templated,
      specificity: rec.specificity,
      tier: rec.tier,
      truncated: !!rec.truncated,
      partial: !!rec.partial,
      verdict: rec.verdict,
      // 谁下的结论很重要：ai-confirmed 的标签不能和人工标签同等对待
      labelSource: rec.labelSource || 'human',
      ai: rec.aiJ && rec.aiJ.ok ? {
        verdict: rec.aiJ.verdict,
        confidence: rec.aiJ.confidence,
        scores: rec.aiJ.scores,
        note: rec.aiJ.note,
      } : null,
      features: rec.features,
      engine: rec.engine,
      at: Date.now(),
    };
    state.samples = state.samples.filter(s => s.id !== rec.id);
    state.samples.unshift(sample);
    if (state.samples.length > 500) state.samples.length = 500;
    try { chrome.storage.local.set({ samples: state.samples }); } catch (_) {}
  }

  let statsTimer = null;
  function persistStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      try { chrome.storage.local.set({ stats: state.stats }); } catch (_) {}
    }, 2000);
  }

  // 诊断快照：把「扫到了什么、打了多少分」整个存下来，
  // 用来区分「判分低」和「根本没扫到」——不然只能靠猜。
  let diagTimer = null;
  function persistDiag() {
    if (!state.settings.diagnostics) return;
    if (diagTimer) return;
    diagTimer = setTimeout(() => {
      diagTimer = null;
      try {
        const all = [...state.recs.values()];
        const items = all.slice(-300).map(r => ({
          id: r.id,
          handle: r.handle,
          score: r.score,
          templated: r.templated,
          specificity: r.specificity,
          tier: r.tier,
          truncated: !!r.truncated,
          partial: !!r.partial,
          skipReason: r.skipReason || null,
          verdict: r.verdict || null,
          labelSource: r.labelSource || null,
          features: (r.features || []).slice(0, 6),
          text: (r.text || '').slice(0, 400),
        }));
        chrome.storage.local.set({
          diag: {
            at: Date.now(),
            engine: E.ENGINE_VERSION,
            url: location.href,
            settings: state.settings,
            total: all.length,
            items,
          },
        });
      } catch (_) {}
    }, 1500);
  }

  // ---------------- 选中文字检测（右键菜单） ----------------
  function showFloat(rawText) {
    const text = (rawText || '').trim();
    document.querySelectorAll('.sloplast-float').forEach(e => e.remove());
    if (!text) return;

    const res = E.analyze(text, {});
    const box = document.createElement('div');
    box.className = 'sloplast-float';

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.addEventListener('click', () => box.remove());

    const h = document.createElement('h4');
    h.textContent = `空话指数 ${res.score} · ${res.score >= preset().high ? '空话较多' : res.score >= preset().mid ? '存疑' : '正常'}`;

    const ul = document.createElement('ul');
    const feats = res.features.slice(0, 5);
    if (!feats.length) {
      const li = document.createElement('li');
      li.textContent = '没有命中明显特征';
      ul.appendChild(li);
    }
    for (const f of feats) {
      const li = document.createElement('li');
      li.textContent = `${f.name}（${f.weight > 0 ? '+' : ''}${f.weight}）`;
      ul.appendChild(li);
    }

    box.append(close, h, ul);
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 20000);
  }

  // ---------------- 批量预判 ----------------
  let toastEl = null, toastTimer = null;
  function toast(text, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'sloplast-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.hidden = true; }, ms || 2200);
  }

  function rerenderById(id) {
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (tweetId(a) !== id) continue;
      const rec = state.recs.get(id);
      if (!rec) continue;
      a.dataset.sloplastKey = '';
      ensureUI(a, rec);
    }
  }

  async function batchJudge() {
    const list = [...state.recs.values()].filter(r =>
      r.tier !== 'skipped' && !r.verdict && !r.aiJ && (r.text || '').length >= 20);

    if (!list.length) {
      toast('没有待预判的内容');
      return { total: 0, done: 0 };
    }

    let done = 0;
    toast(`AI 预判 0/${list.length}`, 60000);

    for (const rec of list) {
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'aiJudge', text: rec.text });
      } catch (e) {
        res = { ok: false, error: 'internal', message: String(e && e.message) };
      }
      rec.aiJ = res || { ok: false, error: 'internal' };

      // 出错立刻停，免得把额度烧在一个坏配置上
      if (!rec.aiJ.ok) {
        toast(`AI 预判中断：${deepErrorText(rec.aiJ.error)}`, 5000);
        rerenderById(rec.id);
        break;
      }

      done++;
      toast(`AI 预判 ${done}/${list.length}`, 60000);
      rerenderById(rec.id);
    }

    if (done) toast(`AI 预判完成 ${done}/${list.length}`, 3000);
    return { total: list.length, done };
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'checkSelection') {
        showFloat(window.getSelection() ? window.getSelection().toString() : '');
        return;
      }

      if (msg.type === 'batchJudge') {
        batchJudge().then(
          r => sendResponse({ ok: true, ...r }),
          e => sendResponse({ ok: false, message: String(e && e.message) })
        );
        return true; // 保持通道，等异步完成
      }
    });
  } catch (_) {}

  // ---------------- 启动 ----------------
  //
  // 扫描分两档，不再「任何 DOM 变动就整页重扫」：
  //   - 平时只重扫「这次真的变了」的那几条（dirty），由 mutation 收集
  //   - 启动 / 换页 / 改设置时整页扫一次（fullScan）
  //
  // 为什么要改：X 的 DOM 每秒都在动（计时器、hover、播放控件、骨架屏），
  // 而虚拟列表会把同一批已经判完的推文反复交回来。整页重扫等于把 30 条推文
  // 的 querySelectorAll 每秒白跑 5 遍，全是重复计算。
  //
  // 但也不能只看新增节点：线上真实存在三种情况，缺一种就漏扫 ——
  //   1. 新推文是作为某个容器的子树插进来的（addedNodes 里没有 <article> 本身）
  //   2. 推文节点早就在文档里，只是角标锚点（时间/正文）晚了几帧才渲染
  //   3. 虚拟列表把同一个 <article> 回收去装另一条推文（只换内部内容）
  // 所以：target 在推文里 → 扫那条；addedNode 子树里有推文 → 全扫出来。
  const dirty = new Set();   // 这一轮要重扫的 article
  const pending = new Set(); // 上一轮锚点还没渲染出来、要再试一次的 article
  let fullScan = true;

  const isTweet = n => !!(n && n.matches && n.matches('article[data-testid="tweet"]'));

  const ownerArticle = node =>
    (node && node.nodeType === 1 && node.closest) ? node.closest('article[data-testid="tweet"]') : null;

  // 把一个新增节点里挂着的推文全收进 dirty；返回是否收到了东西
  function harvest(node) {
    if (!node || node.nodeType !== 1) return false;
    let found = false;
    if (isTweet(node)) { dirty.add(node); return true; }
    if (node.querySelectorAll) {
      for (const a of node.querySelectorAll('article[data-testid="tweet"]')) {
        dirty.add(a);
        found = true;
      }
    }
    return found;
  }

  function onMutations(list) {
    let relevant = false;
    for (const m of list) {
      // 2/3：变动发生在某条推文内部
      const owner = ownerArticle(m.target);
      if (owner) { dirty.add(owner); relevant = true; }
      // 1：变动带进来了新的推文
      for (const n of m.addedNodes) if (harvest(n)) relevant = true;
    }
    // 跟推文无关的变动（侧边栏、悬浮球、播放进度）直接扔掉，不排扫描
    if (relevant) schedule();
  }

  function runScan() {
    if (fullScan) {
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) dirty.add(a);
      fullScan = false;
    }
    for (const a of pending) {
      if (a.isConnected) dirty.add(a); else pending.delete(a);
    }

    const list = [...dirty];
    dirty.clear();

    for (const a of list) {
      if (!a.isConnected) { pending.delete(a); continue; }
      let settled;
      try {
        settled = process(a) !== false;
      } catch (_) {
        // 单条出错不影响整体；也不把它挂进重试队列，免得每秒重跑同一个异常
        pending.delete(a);
        continue;
      }
      if (settled) pending.delete(a); else pending.add(a);
    }
  }

  // 节流而不是防抖：定时器已在就不重置，保证第一次变更后 200ms 内必定扫一次。
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; runScan(); }, 200);
  }

  const obs = new MutationObserver(onMutations);
  obs.observe(document.body, { childList: true, subtree: true });

  // 路由切换（X 是 SPA）。整页扫一次：新页面的推文不保证每条都从 mutation 里进来。
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; fullScan = true; schedule(); }
  }, 1200);

  try {
    chrome.storage.local.get(['settings', 'samples', 'stats'], d => {
      if (d && d.settings) state.settings = { ...state.settings, ...d.settings };
      if (d && Array.isArray(d.samples)) state.samples = d.samples;
      if (d && d.stats) state.stats = { ...state.stats, ...d.stats };
      runScan();
    });
  } catch (_) {
    runScan();
  }

  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.settings) return;
      state.settings = { ...state.settings, ...ch.settings.newValue };
      // 设置变了，重算全部可见推文的档位（走同一个入口，别重写一遍规则）
      for (const rec of state.recs.values()) {
        if (rec.tier === 'skipped') continue;
        rec.tier = tierFor(rec);
      }
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        a.dataset.sloplastKey = '';
      }
      fullScan = true; // 所有推文都要重画，不能只扫变过的
      schedule();
    });
  } catch (_) {}
})();
