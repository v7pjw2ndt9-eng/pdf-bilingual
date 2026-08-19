import { loadSettings, saveSettings } from '../src/settings.js';

const $ = (id) => document.getElementById(id);
const VIEWER = chrome.runtime.getURL('viewer/viewer.html');

const s = await loadSettings();
for (const k of ['provider', 'layout', 'interceptPdf', 'autoTranslate']) {
  const el = $(k);
  if (el.type === 'checkbox') el.checked = !!s[k];
  else el.value = s[k];
  el.onchange = () => saveSettings({ [k]: el.type === 'checkbox' ? el.checked : el.value });
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

const host = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
const isWeb = /^https?:/.test(tab?.url || '');

// 站点自动翻译开关
if (host) {
  chrome.runtime.sendMessage({ type: 'should-auto', host }).then((r) => {
    $('siteAuto').checked = !!(r && r.auto);
  });
  $('siteAuto').onchange = () => chrome.runtime.sendMessage({ type: 'toggle-site-auto', host });
}

$('translatePage').disabled = !isWeb;
$('translatePage').onclick = async () => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'pbx-toggle' });
  } catch {
    $('tip').textContent = '这个页面注入不了脚本（chrome:// 或商店页面），换个普通网页试试。';
    return;
  }
  window.close();
};

$('openHere').onclick = async () => {
  if (!tab?.url) return;
  if (tab.url.startsWith(VIEWER)) { window.close(); return; }
  await chrome.tabs.update(tab.id, { url: `${VIEWER}?file=${encodeURIComponent(tab.url)}` });
  window.close();
};

$('openBlank').onclick = async () => {
  await chrome.tabs.create({ url: VIEWER });
  window.close();
};

$('opts').onclick = () => chrome.runtime.openOptionsPage();

if (s.provider === 'bridge') {
  fetch(s.bridge.url.replace(/\/+$/, '') + '/health')
    .then((r) => r.json())
    .then((d) => { $('tip').textContent = `桥接在线 · ${d.cli?.claude ? 'claude ✓ ' : ''}${d.cli?.codex ? 'codex ✓' : ''}`; })
    .catch(() => { $('tip').textContent = '桥接未启动：终端跑 python3 bridge/bridge.py'; });
}
