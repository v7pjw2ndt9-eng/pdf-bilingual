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

// 显示快捷键的「实际绑定」，而不是写死一段文字。
// Chrome 在快捷键冲突时是静默不绑定的 —— 写死文字的话，用户按了没反应
// 只会以为扩展坏了。Linux 上 Alt+字母 常被窗口管理器或 GTK 助记符抢走。
try {
  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'toggle-translate');
  if (c && c.shortcut) {
    $('kbd').textContent = c.shortcut;
  } else {
    $('kbd').textContent = '未绑定';
    const w = $('kbdWarn');
    w.hidden = false;
    w.innerHTML = '快捷键没能绑定（多半和别的扩展或系统快捷键冲突）。' +
                  '<a href="#" id="kbdLink">点这里去设置一个</a>。';
    $('kbdLink').onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      window.close();
    };
  }
} catch { $('kbd').textContent = ''; }

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
