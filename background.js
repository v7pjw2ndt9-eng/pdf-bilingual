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
