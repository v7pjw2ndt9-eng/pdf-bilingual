import { loadSettings, saveSettings, DEFAULTS } from '../src/settings.js';
import { listModels } from '../src/providers.js';
import { cacheSize, clearCache } from '../src/store.js';

const $ = (id) => document.getElementById(id);

const FIELDS = [
  'provider', 'targetLang', 'layout', 'autoTranslate', 'interceptPdf',
  'concurrency', 'charsPerRequest', 'skipReferences', 'translateCaptions',
  'glossary', 'transFontScale', 'transColor',
  'anthropic.apiKey', 'anthropic.baseUrl', 'anthropic.model',
  'openai.apiKey', 'openai.baseUrl', 'openai.model',
  'bridge.url', 'bridge.engine', 'bridge.model',
];

const NUMERIC = new Set(['concurrency', 'charsPerRequest', 'transFontScale']);

const dig = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function nest(path, val) {
  const parts = path.split('.');
  const out = {};
  let cur = out;
  parts.forEach((k, i) => {
    if (i === parts.length - 1) cur[k] = val;
    else cur = cur[k] = {};
  });
  return out;
}

let settings;

init();

async function init() {
  settings = await loadSettings();

  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    const v = dig(settings, f);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }

  showPane();
  $('provider').addEventListener('change', showPane);
  $('save').onclick = save;
  $('clearCache').onclick = async () => {
    await clearCache();
    refreshCache();
    status('缓存已清空');
  };
  $('fetchAnthropic').onclick = () => fetchModels('anthropic');
  $('fetchOpenai').onclick = () => fetchModels('openai');
  $('pingBridge').onclick = pingBridge;

  // Cmd/Ctrl+S 保存
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  });

  refreshCache();
  bindBackup();
}

/**
 * 设置导出/导入。
 *
 * 扩展 ID 已经用 manifest 的 key 字段钉死，换目录重装不会再丢设置了；
 * 这里是给换机器（作者在 Mac 和 Linux 上都用）和意外情况留的后路。
 * 没走 chrome.storage.sync —— 那会把 API key 传到 Google 账号里去，
 * 要不要这么做应该由用户自己决定，不该默认替他选。
 */
function bindBackup() {
  $('exportBtn').onclick = async () => {
    const s = await loadSettings();
    const keepKeys = $('exportKeys').checked;
    const out = JSON.parse(JSON.stringify(s));
    if (!keepKeys) {
      if (out.anthropic) out.anthropic.apiKey = '';
      if (out.openai) out.openai.apiKey = '';
    }
    const blob = new Blob(
      [JSON.stringify({ _app: 'pdf-bilingual', _version: 1, settings: out }, null, 2)],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pdf-bilingual-settings' + (keepKeys ? '-含key' : '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status(keepKeys ? '已导出（含 API key，注意保管）' : '已导出（不含 API key）');
  };

  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const incoming = j.settings || j;
      if (!incoming || typeof incoming !== 'object') throw new Error('格式不对');
      // 导入的空 key 不要覆盖掉现有的
      const cur = await loadSettings();
      for (const p of ['anthropic', 'openai']) {
        if (incoming[p] && !incoming[p].apiKey && cur[p]?.apiKey) {
          incoming[p].apiKey = cur[p].apiKey;
        }
      }
      settings = await saveSettings(incoming);
      $('importState').textContent = '✓ 已导入，刷新页面看结果';
      status('设置已导入');
    } catch (err) {
      $('importState').textContent = '✗ ' + (err.message || err);
    } finally {
      e.target.value = '';
    }
  };
}

function showPane() {
  const p = $('provider').value;
  for (const el of document.querySelectorAll('.pane')) el.classList.toggle('on', el.dataset.p === p);
}

async function save() {
  let patch = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (!el) continue;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (NUMERIC.has(f)) {
      const n = parseFloat(v);
      v = Number.isFinite(n) ? n : dig(DEFAULTS, f);
    }
    patch = deepAssign(patch, nest(f, v));
  }
  settings = await saveSettings(patch);
  status('已保存');
}

function deepAssign(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepAssign(a[k] || {}, v);
    else a[k] = v;
  }
  return a;
}

async function fetchModels(which) {
  const btn = $(which === 'anthropic' ? 'fetchAnthropic' : 'fetchOpenai');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    await save();
    const ids = await listModels(settings, which);
    const dl = $(which === 'anthropic' ? 'anthropicModels' : 'openaiModels');
    dl.textContent = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      dl.append(o);
    }
    status(`拿到 ${ids.length} 个模型，点输入框看下拉`);
  } catch (e) {
    status('拉取失败：' + String(e.message || e).split('\n')[0]);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取列表';
  }
}

async function pingBridge() {
  const el = $('bridgeState');
  el.textContent = '连接中…';
  try {
    const res = await fetch($('bridge.url').value.replace(/\/+$/, '') + '/health');
    const d = await res.json();
    const cli = d.cli || {};
    el.textContent = `✓ 在线 · claude:${cli.claude ? '有' : '没装'} codex:${cli.codex ? '有' : '没装'}`;
  } catch {
    el.textContent = '✗ 连不上，先在终端启动 bridge.py';
  }
}

async function refreshCache() {
  try { $('cacheN').textContent = `${await cacheSize()} 段`; }
  catch { $('cacheN').textContent = '—'; }
}

let t;
function status(msg) {
  const s = $('status');
  s.textContent = msg;
  s.classList.add('on');
  clearTimeout(t);
  t = setTimeout(() => s.classList.remove('on'), 1800);
}
