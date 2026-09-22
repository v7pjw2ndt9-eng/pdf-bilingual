/**
 * 网页翻译的页面侧。
 *
 * 只做三件事：找出该翻的段落、按可见性排队、把回来的译文插进 DOM。
 * 真正的 API 调用在 background —— Chrome 把 content script 的 fetch 纳入
 * 页面的 CORS 管辖，从这里直接打 api.anthropic.com 会被拦掉，而且也不该
 * 让 API key 出现在页面上下文里。
 */
(function () {
  'use strict';
  if (window.__pbxLoaded) return;
  window.__pbxLoaded = true;

  const B = PBXBlocks;

  const S = {
    on: false,
    settings: null,
    units: new Map(),      // key -> unit
    byAnchor: new WeakMap(),// 锚点节点 -> unit，防止同一段重复排队
    dirty: new Set(),      // 待重扫的子树根
    queue: [],             // 等着送去翻译的 key
    inflight: false,
    io: null,              // 可见性观察
    mo: null,              // DOM 变动观察
    port: null,
    done: 0,
    total: 0,
    rescanTimer: null,
    flushTimer: null,
  };

  /* ------------------------------------------------------- 与后台通信 */

  function connect() {
    if (S.port) return S.port;
    S.port = chrome.runtime.connect({ name: 'translate' });

    S.port.onMessage.addListener((msg) => {
      if (msg.type === 'result') {
        const u = S.units.get(msg.key);
        if (u) B.insert(u, msg.text, { mode: S.settings.webMode });
        S.done++;
        badge();
      } else if (msg.type === 'error') {
        const u = S.units.get(msg.key);
        if (u) B.fail(u, '× ' + msg.message);
        S.done++;
        badge();
      } else if (msg.type === 'fatal') {
        toast('翻译失败：' + msg.message);
        // 把这一批还在转圈的占位符标成失败，别让它们一直转
        for (const key of S.sent || []) {
          const u = S.units.get(key);
          if (u && u.el && u.el.classList.contains('pbx-pending')) B.fail(u, '× ' + msg.message);
        }
      } else if (msg.type === 'done') {
        S.inflight = false;
        S.sent = null;
        flushSoon(0);
      }
    });

    S.port.onDisconnect.addListener(() => {
      S.port = null;
      S.inflight = false;
    });
    return S.port;
  }

  /* ----------------------------------------------------------- 队列 */

  function flushSoon(delay = 250) {
    clearTimeout(S.flushTimer);
    S.flushTimer = setTimeout(flush, delay);
  }

  function flush() {
    if (!S.on || S.inflight || !S.queue.length) return;

    // 一批最多 40 段：太多的话首屏要等很久才出结果
    const batch = S.queue.splice(0, 40);
    const units = [];
    for (const key of batch) {
      const u = S.units.get(key);
      if (!u || u.sent) continue;
      u.sent = true;
      B.placeholder(u);
      units.push({ key, text: u.text });
    }
    if (!units.length) { flushSoon(0); return; }

    S.inflight = true;
    S.sent = units.map((u) => u.key);
    S.total += units.length;
    badge();
    connect().postMessage({ type: 'translate', units, title: document.title });
  }

  /* --------------------------------------------------- 扫描与可见性 */

  /**
   * 只扫变动过的子树。信息流是无限滚动的，每次 DOM 变动都从 document.body
   * 重扫一遍，页面越长越卡。
   */
  function scan(roots) {
    const targets = roots && roots.length ? topRoots(roots) : [document.body];
    let added = 0;
    for (const root of targets) {
      if (!root || !root.isConnected) continue;
      const found = B.collectUnits(root, {
        targetIsCJK: /中文|chinese|zh/i.test(S.settings.targetLang || ''),
        skipUI: S.settings.webSkipUI !== false,
      });
      for (const u of found) {
        // 判重靠 DOM 本身（webblocks 里看锚点后面有没有译文节点）加这个
        // WeakMap（挡住同一轮里排过队但还没插占位符的）。
        // 不能用「文本+路径」的字符串集合 —— 虚拟化列表把条目摘掉再装回来时，
        // 那种集合会永久挡住它，导致滚回去的内容再也拿不到译文。
        if (S.byAnchor.has(u.anchor)) continue;
        u.key = 'u' + (S.nextKey++);
        S.byAnchor.set(u.anchor, u);
        S.units.set(u.key, u);
        observe(u);
        added++;
      }
    }
    prune();
    return added;
  }

  /** 去掉被其它根包含的根，免得同一片 DOM 扫好几遍。 */
  function topRoots(list) {
    const uniq = [...new Set(list)].filter((el) => el && el.nodeType === 1 && el.isConnected);
    return uniq.filter((el) => !uniq.some((o) => o !== el && o.contains(el)));
  }

  /**
   * 虚拟化列表会把滚出视口的条目从 DOM 里摘掉。不清理的话 units 和
   * IntersectionObserver 的观察目标会随滚动无限堆积。
   */
  function prune() {
    if (S.units.size < 400) return;
    for (const [key, u] of S.units) {
      if (u.anchor && u.anchor.isConnected) continue;
      if (u.target) S.io && S.io.unobserve(u.target);
      S.units.delete(key);
    }
  }

  /** 只翻进入视口附近的段落 —— 长文章一次全翻既慢又浪费 token。 */
  function observe(u) {
    const target = u.anchor.nodeType === 1 ? u.anchor : u.anchor.parentElement;
    if (!target) return;
    u.target = target;
    if (!S.io) {
      S.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const key = en.target.__pbxKey;
          const u2 = S.units.get(key);
          if (u2 && !u2.sent) S.queue.push(key);
          S.io.unobserve(en.target);
        }
        flushSoon();
      }, { rootMargin: '800px 0px' });
    }
    target.__pbxKey = u.key;
    S.io.observe(target);
  }

  function watchDom() {
    if (S.mo) return;
    S.mo = new MutationObserver((records) => {
      for (const r of records) {
        let real = false;
        for (const n of r.addedNodes) {
          // 自己插的译文会触发变动，别把自己算进去
          if (n.nodeType === 1 && n.classList && n.classList.contains('pbx-tr')) continue;
          if (n.nodeType === 1 || n.nodeType === 3) { real = true; break; }
        }
        if (real && r.target) S.dirty.add(r.target);
      }
      if (!S.dirty.size) return;
      clearTimeout(S.rescanTimer);
      S.rescanTimer = setTimeout(() => {
        if (!S.on) return;
        const roots = [...S.dirty];
        S.dirty.clear();
        scan(roots);
      }, 500);
    });
    S.mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ----------------------------------------------------------- 开关 */

  async function start() {
    S.settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
    S.on = true;
    S.nextKey = S.nextKey || 0;
    document.documentElement.classList.add('pbx-active');
    document.documentElement.style.setProperty('--pbx-color', S.settings.transColor || '#1a5fb4');
    document.documentElement.style.setProperty('--pbx-scale', S.settings.transFontScale || 1);

    const n = scan();
    watchDom();
    toast(n ? `找到 ${n} 段，开始翻译` : '这个页面没找到可翻译的段落');
  }

  function stop() {
    S.on = false;
    S.io?.disconnect(); S.io = null;
    S.mo?.disconnect(); S.mo = null;
    clearTimeout(S.flushTimer);
    clearTimeout(S.rescanTimer);
    S.queue = [];
    S.units.clear();
    S.byAnchor = new WeakMap();
    S.dirty.clear();
    S.nextKey = 0;
    S.done = S.total = 0;
    S.port?.postMessage({ type: 'abort' });
    B.revert(document);
    document.documentElement.classList.remove('pbx-active');
    toast('已还原原文');
  }

  function toggle() { S.on ? stop() : start(); }

  /* ------------------------------------------------------- 小提示条 */

  let toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'pbx-toast';
      toastEl.setAttribute('data-pbx-tr', '1');
    }
    toastEl.textContent = msg;
    (document.body || document.documentElement).appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.remove(), 2600);
  }

  function badge() {
    if (!S.on || !S.total) return;
    if (S.done >= S.total) toast(`翻译完成 ${S.done}/${S.total}`);
  }

  /* --------------------------------------------------------- 入口 */

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'pbx-toggle') { toggle(); reply({ on: S.on }); }
    else if (msg.type === 'pbx-state') reply({ on: S.on, done: S.done, total: S.total });
    else if (msg.type === 'pbx-start') { if (!S.on) start(); reply({ on: true }); }
    else if (msg.type === 'pbx-stop') { if (S.on) stop(); reply({ on: false }); }
    return true;
  });

  // 站点在自动列表里就直接开翻
  chrome.runtime.sendMessage({ type: 'should-auto', host: location.hostname })
    .then((r) => { if (r && r.auto) start(); })
    .catch(() => {});
})();
