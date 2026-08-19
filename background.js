/**
 * 接管 PDF 导航。
 *
 * Chrome 自带的 PDF 阅读器是 PDFium 插件渲染的，content script 注入不进去，
 * 拿不到任何文本 —— 所以必须在导航发生时把 URL 换成我们自己的 pdf.js 阅读器。
 *
 * 两道拦截：
 *   1. onBeforeNavigate  —— URL 以 .pdf 结尾，抢在加载前换掉，无闪烁
 *   2. onHeadersReceived —— Content-Type 是 application/pdf 但 URL 没后缀
 *                           （arxiv.org/pdf/2401.12345 这种）
 */

import { translateUnits } from './src/translate.js';
import { loadSettings, saveSettings } from './src/settings.js';

const VIEWER = chrome.runtime.getURL('viewer/viewer.html');
const PDF_EXT = /\.pdf(?:[?#].*)?$/i;

let enabled = true;
chrome.storage.local.get('settings').then((g) => {
  if (g.settings && g.settings.interceptPdf === false) enabled = false;
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.settings?.newValue) enabled = ch.settings.newValue.interceptPdf !== false;
});

const viewerUrl = (file) => `${VIEWER}?file=${encodeURIComponent(file)}`;

function shouldSkip(url) {
  return (
    !url ||
    url.startsWith(VIEWER) ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('chrome://') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')
  );
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (!enabled || d.frameId !== 0) return;
  if (shouldSkip(d.url) || !PDF_EXT.test(d.url)) return;
  chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) }).catch(() => {});
});

// 观察式 webRequest（MV3 里只读，不阻塞），用来兜住没有 .pdf 后缀的情况
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (!enabled || d.type !== 'main_frame') return;
    if (shouldSkip(d.url) || PDF_EXT.test(d.url)) return; // 后缀情形已被第一道拦下
    const ct = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-type');
    if (!ct || !/application\/pdf/i.test(ct.value)) return;
    const cd = d.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-disposition');
    if (cd && /attachment/i.test(cd.value)) return; // 明确要下载的就别劫持
    chrome.tabs.update(d.tabId, { url: viewerUrl(d.url) }).catch(() => {});
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders'],
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'open-in-viewer',
      title: '用双语阅读器打开此 PDF 链接',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf*', '*://*/pdf/*'],
    });
    chrome.contextMenus.create({
      id: 'open-page-in-viewer',
      title: '用双语阅读器打开当前页面',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'open-in-viewer' ? info.linkUrl : info.pageUrl;
  if (url) chrome.tabs.create({ url: viewerUrl(url), index: tab ? tab.index + 1 : undefined });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'open-viewer') {
    chrome.tabs.update(sender.tab?.id ?? msg.tabId, { url: viewerUrl(msg.url) });
    reply({ ok: true });
  }
  return false;
});


/* ==================================================== 网页翻译中枢 ====

   content script 不能直接调 API：Chrome 把它的 fetch 纳入所在页面的 CORS
   管辖，打 api.anthropic.com 会被拦。所以翻译统一在这里做 —— 顺带好处是
   API key 不进页面上下文，各标签页共用同一个并发池和 IndexedDB 缓存。   */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  let abort = null;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'abort') { abort?.abort(); return; }
    if (msg.type !== 'translate') return;

    abort = new AbortController();
    const settings = await loadSettings();
    try {
      await translateUnits(
        msg.units,
        { ...settings, docTitle: msg.title || '', docKind: 'web' },
        {
          onResult: (key, text) => post(port, { type: 'result', key, text }),
          onProgress: (done, total) => post(port, { type: 'progress', done, total }),
          onError: (err, key) => post(port, {
            type: 'error', key, message: String(err?.message || err).split('\n')[0],
          }),
        },
        abort.signal,
      );
    } catch (e) {
      post(port, { type: 'fatal', message: String(e?.message || e).split('\n')[0] });
    }
    post(port, { type: 'done' });
  });

  port.onDisconnect.addListener(() => abort?.abort());
});

/** 端口可能在翻译途中断开（标签关闭、导航走了），postMessage 会抛。 */
function post(port, msg) {
  try { port.postMessage(msg); } catch { /* 对端已走 */ }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'get-settings') {
    loadSettings().then(reply);
    return true;
  }
  if (msg?.type === 'should-auto') {
    loadSettings().then((s) => {
      const list = s.webAutoSites || [];
      const host = msg.host || '';
      const hit = s.webAutoTranslate ||
        list.some((h) => host === h || host.endsWith('.' + h));
      reply({ auto: !!hit });
    });
    return true;
  }
  if (msg?.type === 'toggle-site-auto') {
    loadSettings().then(async (s) => {
      const list = new Set(s.webAutoSites || []);
      list.has(msg.host) ? list.delete(msg.host) : list.add(msg.host);
      await saveSettings({ webAutoSites: [...list] });
      reply({ auto: list.has(msg.host) });
    });
    return true;
  }
  return false;
});

/* 快捷键（默认 Alt+T）*/
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (tab.url?.startsWith(VIEWER)) return;   // PDF 阅读器自己有按钮
  chrome.tabs.sendMessage(tab.id, { type: 'pbx-toggle' }).catch(() => {});
});
