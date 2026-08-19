export const DEFAULTS = {
  provider: 'anthropic',         // anthropic | openai | bridge | google
  targetLang: '简体中文',
  layout: 'insert',              // insert 插入 | side 分栏 | hover 悬停
  autoTranslate: true,
  interceptPdf: true,

  anthropic: {
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5',
  },
  openai: {
    apiKey: '',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4.1-mini',
  },
  bridge: {
    url: 'http://127.0.0.1:8765',
    engine: 'claude',            // claude | codex
    model: '',                   // 留空用 CLI 默认模型
  },

  // 网页翻译
  webAutoTranslate: false,       // 所有站点自动翻
  webAutoSites: [],              // 只有这些域名自动翻
  webSkipUI: true,               // 跳过导航/按钮里的短标签
  webMode: 'bilingual',          // bilingual 双语对照 | translated 只看译文

  concurrency: 3,
  charsPerRequest: 3000,
  skipReferences: true,
  translateCaptions: true,
  glossary: '',                  // 每行一条：English=中文
  transFontScale: 1,
  transColor: '#1a5fb4',
};

export async function loadSettings() {
  const got = await chrome.storage.local.get('settings');
  return deepMerge(structuredClone(DEFAULTS), got.settings || {});
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = deepMerge(cur, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] && typeof base[k] === 'object' ? base[k] : {}, v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}
