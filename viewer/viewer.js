import * as pdfjsLib from '../lib/pdf.mjs';
import { analyzePage, isReferencesHeading } from '../src/layout.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { translateUnits } from '../src/translate.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

const $ = (id) => document.getElementById(id);
const px = (v) => `${v.toFixed(2)}px`;

const S = {
  doc: null,
  settings: null,
  recs: [],              // 每页一条记录
  scale: 1.25,
  fitWidth: true,
  dpr: Math.min(2, window.devicePixelRatio || 1),
  translations: new Map(),   // "页:块" -> 译文
  errors: new Map(),
  abort: null,
  title: '',
  maxW: 612,
};

/* =============================================================== 启动 */

init();

async function init() {
  S.settings = await loadSettings();
  S.scale = 1.25;

  $('layout').value = S.settings.layout;
  $('provider').value = S.settings.provider;

  bindUI();

  const file = new URLSearchParams(location.search).get('file');
  if (file) {
    document.title = decodeURIComponent(file).split('/').pop() + ' - 双语阅读';
    loadFromUrl(file);
  }
}

function bindUI() {
  $('zoomIn').onclick = () => setScale(S.scale * 1.15);
  $('zoomOut').onclick = () => setScale(S.scale / 1.15);
  $('zoomFit').onclick = () => { S.fitWidth = true; fitWidth(); };

  $('layout').onchange = async (e) => {
    S.settings = await saveSettings({ layout: e.target.value });
    // 分栏模式要给右侧译文栏留地方，缩放基准跟着变
    if (S.fitWidth) fitWidth(); else rebuild();
  };
  $('provider').onchange = async (e) => {
    S.settings = await saveSettings({ provider: e.target.value });
    toast(`后端已切到 ${e.target.selectedOptions[0].textContent}`);
  };

  $('translate').onclick = () => startTranslate();
  $('stop').onclick = () => S.abort?.abort();
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
  $('openLocal').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) loadFromFile(f);
  };

  $('pageNum').onchange = (e) => {
    const n = parseInt(e.target.value, 10);
    const rec = S.recs[n - 1];
    if (rec) rec.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 拖放
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) drop.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f && /pdf$/i.test(f.name)) loadFromFile(f);
  });

  window.addEventListener('resize', () => { if (S.fitWidth) fitWidth(); });

  $('viewport').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setScale(S.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
}

/* =============================================================== 载入 */

async function loadFromFile(file) {
  S.title = file.name;
  document.title = `${file.name} - 双语阅读`;
  loadDoc({ data: new Uint8Array(await file.arrayBuffer()) });
}

async function loadFromUrl(url) {
  try {
    // 自己 fetch 而不是把 url 交给 pdf.js —— 这样能带上 cookie，取到需要登录的 PDF
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.title = decodeURIComponent(url).split('/').pop().split(/[?#]/)[0];
    loadDoc({ data: new Uint8Array(await res.arrayBuffer()) });
  } catch (e) {
    $('dropErr').textContent =
      `取不到这个 PDF（${e.message}）。如果是本地文件，去 chrome://extensions 打开本扩展的` +
      `「允许访问文件网址」，或者直接把文件拖进来。`;
  }
}

async function loadDoc(src) {
  $('drop').classList.add('hide');
  S.translations.clear();
  S.errors.clear();
  S.abort?.abort();

  S.doc = await pdfjsLib.getDocument({
    ...src,
    cMapUrl: chrome.runtime.getURL('lib/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
  }).promise;

  try {
    const meta = await S.doc.getMetadata();
    if (meta?.info?.Title?.trim()) S.title = meta.info.Title.trim();
  } catch { /* 元数据缺失不影响 */ }

  $('title').textContent = S.title;
  $('title').title = S.title;
  $('pageCount').textContent = `/ ${S.doc.numPages}`;

  // 先把全文文本抽出来做版面分析（不渲染，很快），再决定 DOM 结构
  S.recs = [];
  S.maxW = 0;
  let inRefs = false;
  const vocab = new Set();   // 跨页共享词表，断词符判得更准

  for (let n = 1; n <= S.doc.numPages; n++) {
    const page = await S.doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const rotated = (page.rotate % 360) !== 0;
    const text = await page.getTextContent();
    // 旋转页（横向扫描件）没法按段落切片，直接整页渲染，走分栏模式
    const analysis = rotated
      ? { blocks: [], bands: [], cols: [], bodyFs: 10, cropX0: 0, cropX1: vp.width }
      : analyzePage(text, { width: vp.width, height: vp.height }, { vocab });

    for (const b of analysis.blocks) {
      if (b.kind === 'heading' && isReferencesHeading(b.text)) inRefs = true;
      b.inRefs = inRefs;
    }

    S.recs.push({
      num: n, page, w: vp.width, h: vp.height, rotated,
      analysis, lines: collectLines(analysis), el: null, painted: false,
    });
    S.maxW = Math.max(S.maxW, vp.width);
  }

  if (S.fitWidth) fitWidth(true);
  rebuild();

  const n = countUnits();
  toast(`${S.doc.numPages} 页，重建出 ${n} 个段落`);
  if (S.settings.autoTranslate && n) startTranslate();
}

function collectLines(analysis) {
  const out = [];
  for (const band of analysis.bands) {
    const groups = band.type === 'full' ? [band.lines] : band.cols;
    for (const g of groups) out.push(...g);
  }
  return out;
}

/* ========================================================== 缩放 / 重建 */

function fitWidth(silent) {
  const avail = $('viewport').clientWidth - 90;
  const factor = S.settings.layout === 'side' ? 0.54 : 1;
  S.scale = Math.max(0.4, Math.min(3, (avail * factor) / (S.maxW || 612)));
  $('zoomVal').textContent = `${Math.round(S.scale * 100)}%`;
  if (!silent) rebuild();
}

function setScale(v) {
  S.fitWidth = false;
  S.scale = Math.max(0.3, Math.min(4, v));
  $('zoomVal').textContent = `${Math.round(S.scale * 100)}%`;
  rebuild();
}

let io = null;

function rebuild() {
  const host = $('pages');
  const anchor = currentPage();
  host.textContent = '';
  io?.disconnect();

  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const rec = S.recs[Number(en.target.dataset.page) - 1];
      if (!rec) continue;
      if (en.isIntersecting) {
        $('pageNum').value = rec.num;
        paintPage(rec);
      }
    }
  }, { root: $('viewport'), rootMargin: '600px 0px' });

  for (const rec of S.recs) {
    rec.painted = false;
    rec.slices = [];
    rec.el = buildPage(rec);
    host.append(rec.el);
    io.observe(rec.el);
  }

  if (anchor > 1) S.recs[anchor - 1]?.el.scrollIntoView({ block: 'start' });
}

function currentPage() {
  return parseInt($('pageNum').value, 10) || 1;
}

/* ============================================================ DOM 构建 */

const translatable = (b, st) =>
  b.kind !== 'skip' &&
  !(st.skipReferences && b.inRefs) &&
  !(b.kind === 'caption' && !st.translateCaptions);

function countUnits() {
  let n = 0;
  for (const rec of S.recs) for (const b of rec.analysis.blocks) if (translatable(b, S.settings)) n++;
  return n;
}

function buildPage(rec) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = rec.num;
  el.setAttribute('data-page', rec.num);

  const mode = rec.rotated ? 'side' : S.settings.layout;

  if (mode === 'insert') {
    el.style.width = px((rec.analysis.cropX1 - rec.analysis.cropX0) * S.scale);
    buildInsert(rec, el);
  } else if (mode === 'side') {
    el.classList.add('side');
    const left = document.createElement('div');
    left.className = 'side-canvas';
    left.style.width = px(rec.w * S.scale);
    left.append(makeSlice(rec, 0, rec.w, rec.h, 0));
    const list = document.createElement('div');
    list.className = 'side-list';
    for (const b of rec.analysis.blocks) {
      if (!translatable(b, S.settings)) continue;
      const item = document.createElement('div');
      item.className = 'side-item';
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = b.text;
      item.append(src, makeTransDiv(rec, b));
      list.append(item);
    }
    el.append(left, list);
  } else {
    el.style.width = px(rec.w * S.scale);
    el.append(makeSlice(rec, 0, rec.w, rec.h, 0));
    for (const b of rec.analysis.blocks) {
      if (!translatable(b, S.settings)) continue;
      const hb = document.createElement('div');
      hb.className = 'hitbox';
      hb.style.left = px(b.x0 * S.scale);
      hb.style.top = px((rec.h - b.top) * S.scale);
      hb.style.width = px((b.x1 - b.x0) * S.scale);
      hb.style.height = px((b.top - b.bottom) * S.scale);
      hb.onmouseenter = (e) => showHover(e, rec, b);
      hb.onmouseleave = hideHover;
      el.append(hb);
    }
  }
  return el;
}

/** 插入模式：把页面画布按段落切成横条，译文插进横条之间。 */
function buildInsert(rec, el) {
  const { bands, cols, cropX0, cropX1 } = rec.analysis;
  if (!bands.length) {
    el.append(makeSlice(rec, cropX0, cropX1, rec.h, 0));
    return;
  }

  // 每个 band 的内容下边界，用来划分各 band 在竖直方向的地盘
  const bottoms = bands.map((band) => {
    const groups = band.type === 'full' ? [band.blocks || []] : (band.colBlocks || []);
    const all = groups.flat();
    return all.length ? Math.min(...all.map((b) => b.bottom)) : rec.h;
  });

  // 分栏的横向分界取白沟中点，这样图片、分隔线不会被漏掉
  const xCuts = [cropX0];
  for (let i = 1; i < cols.length; i++) xCuts.push((cols[i - 1].x1 + cols[i].x0) / 2);
  xCuts.push(cropX1);

  bands.forEach((band, i) => {
    const yTop = i === 0 ? rec.h : bottoms[i - 1];
    const yBot = i === bands.length - 1 ? 0 : bottoms[i];

    if (band.type === 'full') {
      const wrap = document.createElement('div');
      wrap.className = 'band-full';
      buildStack(rec, wrap, band.blocks || [], cropX0, cropX1, yTop, yBot);
      el.append(wrap);
    } else {
      const row = document.createElement('div');
      row.className = 'band-cols';
      (band.colBlocks || []).forEach((blocks, ci) => {
        const c = document.createElement('div');
        c.className = 'col';
        c.style.width = px((xCuts[ci + 1] - xCuts[ci]) * S.scale);
        buildStack(rec, c, blocks, xCuts[ci], xCuts[ci + 1], yTop, yBot);
        row.append(c);
      });
      el.append(row);
    }
  });
}

function buildStack(rec, host, blocks, x0, x1, yTop, yBot) {
  let cursor = yTop;
  for (const b of blocks) {
    const bot = Math.min(cursor, Math.max(b.bottom, yBot));
    if (cursor - bot > 0.5) host.append(makeSlice(rec, x0, x1, cursor, bot));
    cursor = bot;
    if (translatable(b, S.settings)) host.append(makeTransDiv(rec, b, x1 - x0));
  }
  if (cursor - yBot > 0.5) host.append(makeSlice(rec, x0, x1, cursor, yBot));
}

/** 一个横条：等到这页真正被渲染时才把像素画进去。 */
function makeSlice(rec, x0, x1, yTop, yBot) {
  const wrap = document.createElement('div');
  wrap.className = 'slice slice-wrap';
  const w = (x1 - x0) * S.scale;
  const h = (yTop - yBot) * S.scale;
  wrap.style.width = px(w);
  wrap.style.height = px(h);

  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round((x1 - x0) * S.scale * S.dpr));
  cv.height = Math.max(1, Math.round((yTop - yBot) * S.scale * S.dpr));
  cv.style.height = px(h);
  wrap.append(cv);

  const slice = { x0, x1, yTop, yBot, canvas: cv, wrap, textDone: false };
  rec.slices.push(slice);
  return wrap;
}

function makeTransDiv(rec, block, widthPdf) {
  const key = `${rec.num}:${block.i}`;
  const d = document.createElement('div');
  d.className = 'tr' + (block.kind === 'heading' ? ' tr-heading' : block.kind === 'caption' ? ' tr-caption' : '');
  d.dataset.key = key;

  const fontPx = Math.max(9, rec.analysis.bodyFs * S.scale * S.settings.transFontScale);
  d.style.fontSize = px(fontPx);
  d.style.color = S.settings.transColor;

  const done = S.translations.get(key);
  if (done) {
    d.textContent = done;
    addCopy(d, done);
  } else if (S.errors.get(key)) {
    d.classList.add('error');
    d.textContent = '× ' + S.errors.get(key);
  } else {
    d.classList.add('pending');
    d.textContent = '';
    // 预留高度，免得译文回来时页面往下跳
    const cssW = (widthPdf || (block.colX1 - block.colX0)) * S.scale;
    const perLine = Math.max(6, Math.floor(cssW / fontPx));
    const lines = Math.max(1, Math.ceil((block.text.length * 0.52) / perLine));
    d.style.minHeight = px(lines * fontPx * 1.55 + 8);
  }
  return d;
}

function addCopy(d, text) {
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.textContent = '复制';
  btn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    toast('译文已复制');
  };
  d.append(btn);
}

/* ============================================================== 渲染 */

async function paintPage(rec) {
  if (rec.painted || rec.painting) return;
  rec.painting = true;
  try {
    const vp = rec.page.getViewport({ scale: S.scale * S.dpr });
    const full = document.createElement('canvas');
    full.width = Math.round(vp.width);
    full.height = Math.round(vp.height);
    await rec.page.render({ canvasContext: full.getContext('2d', { alpha: false }), viewport: vp }).promise;

    const k = S.scale * S.dpr;
    for (const sl of rec.slices) {
      const ctx = sl.canvas.getContext('2d');
      const sx = sl.x0 * k;
      const sy = (rec.h - sl.yTop) * k;
      const sw = (sl.x1 - sl.x0) * k;
      const sh = (sl.yTop - sl.yBot) * k;
      ctx.drawImage(full, sx, sy, sw, sh, 0, 0, sl.canvas.width, sl.canvas.height);
    }
    full.width = full.height = 0;   // 及时放掉大画布

    if (!rec.rotated) buildTextLayers(rec);
    rec.painted = true;
  } catch (e) {
    console.error('渲染第', rec.num, '页失败', e);
  } finally {
    rec.painting = false;
  }
}

/** 透明文字层：让原文可以被选中和复制。 */
function buildTextLayers(rec) {
  const pending = [];
  for (const sl of rec.slices) {
    if (sl.textDone) continue;
    sl.textDone = true;
    const layer = document.createElement('div');
    layer.className = 'tl';

    for (const ln of rec.lines) {
      if (ln.y > sl.yTop || ln.y < sl.yBot) continue;
      const items = ln.items.filter((it) => it.x1 >= sl.x0 && it.x0 <= sl.x1);
      if (!items.length) continue;

      const row = document.createElement('div');
      row.className = 'ln';
      row.style.left = px((ln.x0 - sl.x0) * S.scale);
      row.style.top = px((sl.yTop - ln.y) * S.scale);
      row.style.fontSize = px(ln.fs * S.scale);
      row.style.fontFamily = 'sans-serif';

      items.forEach((it, k) => {
        const span = document.createElement('span');
        span.textContent = it.str;
        span.style.left = px((it.x0 - ln.x0) * S.scale);
        span.style.fontSize = px(it.fs * S.scale);
        span.style.transform = 'translateY(-0.84em)';
        row.append(span);
        // item 之间的空隙补一个空格文本节点，否则复制出来会黏成一坨
        const next = items[k + 1];
        if (next && next.x0 - it.x1 > 0.18 * it.fs && !/\s$/.test(it.str)) {
          row.append(document.createTextNode(' '));
        }
        pending.push([span, (it.x1 - it.x0) * S.scale]);
      });
      layer.append(row);
    }
    sl.wrap.append(layer);
  }
  // 先一次性读宽度，再一次性写 transform —— 避免逐个元素触发重排
  const widths = pending.map(([sp]) => sp.getBoundingClientRect().width);
  pending.forEach(([sp, want], i) => {
    const got = widths[i];
    const sx = got > 0.5 && want > 0.5 ? Math.min(4, want / got) : 1;
    sp.style.transform = `translateY(-0.84em) scaleX(${sx.toFixed(4)})`;
  });
}

/* ============================================================== 翻译 */

async function startTranslate() {
  if (S.abort && !S.abort.signal.aborted) return;
  if (!S.recs.length) return;

  S.settings = await loadSettings();
  $('provider').value = S.settings.provider;

  const units = [];
  for (const rec of S.recs) {
    for (const b of rec.analysis.blocks) {
      const key = `${rec.num}:${b.i}`;
      if (!translatable(b, S.settings)) continue;
      if (S.translations.has(key)) continue;
      units.push({ key, text: b.text });
    }
  }
  if (!units.length) { toast('没有需要翻译的段落'); return; }

  S.abort = new AbortController();
  $('translate').hidden = true;
  $('stop').hidden = false;
  $('progress').hidden = false;
  setProgress(0, units.length);

  try {
    await translateUnits(
      units,
      { ...S.settings, docTitle: S.title },
      {
        onResult: (key, text) => {
          S.translations.set(key, text);
          S.errors.delete(key);
          const el = document.querySelector(`.tr[data-key="${CSS.escape(key)}"]`);
          if (el) {
            el.classList.remove('pending', 'error');
            el.style.minHeight = '';
            el.textContent = text;
            addCopy(el, text);
          }
        },
        onProgress: setProgress,
        onError: (err, key) => {
          const msg = String(err.message || err).split('\n')[0];
          if (key) {
            S.errors.set(key, msg);
            const el = document.querySelector(`.tr[data-key="${CSS.escape(key)}"]`);
            if (el) {
              el.classList.remove('pending');
              el.classList.add('error');
              el.style.minHeight = '';
              el.textContent = '× ' + msg;
            }
          }
        },
      },
      S.abort.signal,
    );
  } catch (e) {
    toast('翻译失败：' + (e.message || e));
  } finally {
    $('translate').hidden = false;
    $('stop').hidden = true;
    setTimeout(() => { $('progress').hidden = true; }, 1200);
    S.abort = null;
  }
}

function setProgress(done, total) {
  $('progressBar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progressTxt').textContent = `${done} / ${total}`;
}

/* ============================================================== 杂项 */

function showHover(e, rec, block) {
  const card = $('hoverCard');
  const key = `${rec.num}:${block.i}`;
  card.textContent = S.translations.get(key) || S.errors.get(key) || '（尚未翻译）';
  card.hidden = false;
  const r = e.currentTarget.getBoundingClientRect();
  card.style.left = px(Math.min(r.left, window.innerWidth - card.offsetWidth - 16));
  card.style.top = px(r.bottom + 6 + card.offsetHeight > window.innerHeight
    ? Math.max(8, r.top - card.offsetHeight - 6)
    : r.bottom + 6);
}
function hideHover() { $('hoverCard').hidden = true; }

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
