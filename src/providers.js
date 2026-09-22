/**
 * 翻译后端。四种实现同一个接口：
 *   call({ system, user, signal }) -> string
 *
 * anthropic / openai  : 官方 API，按 token 计费
 * bridge              : 本地 Python 桥接，背后是 claude / codex CLI，走你的订阅额度
 * google              : translate.googleapis.com 免密钥端点，兜底用
 */

class ApiError extends Error {
  constructor(msg, status, retriable) {
    super(msg);
    this.status = status;
    this.retriable = retriable;
  }
}

/**
 * 把服务端的真实解释提出来。
 *
 * 之前这里把消息拼成 "HTTP 400\n<body>"，而各处显示时都取 .split('\n')[0]，
 * 于是用户只看到光秃秃一个 "HTTP 400"，API 到底嫌弃什么完全看不到。
 * 现在压成一行，原因跟着一起走。
 */
function apiMessage(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message || j?.message || j?.error?.code || j?.detail;
    if (m) return String(m);
  } catch { /* 不是 JSON 就用原文 */ }
  return raw.replace(/\s+/g, ' ');
}

function httpError(status, body) {
  const detail = apiMessage(body).slice(0, 300);
  const retriable = status === 429 || status === 408 || status >= 500;
  let hint = '';
  if (status === 401 || status === 403) hint = '（API key 无效或没权限，去设置页检查）';
  if (status === 429) hint = '（触发限速，正在退避重试）';
  if (status === 404) hint = '（模型名或 Base URL 不对）';
  const e = new ApiError(`HTTP ${status}${hint}${detail ? ' · ' + detail : ''}`, status, retriable);
  e.detail = detail;
  return e;
}

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

/* ------------------------------------------------------------- Anthropic */

async function anthropic(cfg, { system, user, signal }) {
  const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器里直连 Anthropic API 必须显式开这个头，否则被 CORS 拦掉
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  const data = await res.json();
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

/* ---------------------------------------------------------------- OpenAI */

/**
 * OpenAI 兼容端点的参数协商。
 *
 * 原先靠 /^(o\d|gpt-5)/ 这样的模型名白名单决定发不发 temperature、用
 * max_tokens 还是 max_completion_tokens。这种写法必然过期 —— 白名单不认识的
 * 新模型（gpt-6-luna 之类）会被当成老模型，带上它不接受的参数，直接 400。
 * 而且第三方中转（DeepSeek、Qwen、one-api）各家支持的字段也不一样，
 * 按名字根本猜不准。
 *
 * 所以改成：先按最兼容的形状发，被拒绝就从错误信息里读出服务端要什么，
 * 调整后立刻重试，并把学到的形状按「Base URL + 模型」记下来，下次直接用。
 */
const PROFILES = new Map();
const PROFILE_KEY = 'openaiProfiles';
let profilesLoaded = false;

async function loadProfiles() {
  if (profilesLoaded) return;
  profilesLoaded = true;
  try {
    const g = await chrome.storage.local.get(PROFILE_KEY);
    for (const [k, v] of Object.entries(g[PROFILE_KEY] || {})) PROFILES.set(k, v);
  } catch { /* 没有 storage（测试台）就只用内存 */ }
}

async function saveProfile(key, profile) {
  PROFILES.set(key, profile);
  try {
    await chrome.storage.local.set({ [PROFILE_KEY]: Object.fromEntries(PROFILES) });
  } catch { /* 同上 */ }
}

/** 从服务端的抱怨里看出该改什么。返回 true 表示已调整、值得重试。 */
function adapt(profile, detail) {
  const d = (detail || '').toLowerCase();

  if (/reasoning_effort|reasoning\.effort/.test(d)) {
    if (profile.reasoningEffort) { profile.reasoningEffort = null; return true; }
  }

  if (/max_completion_tokens/.test(d) && /max_tokens/.test(d)) {
    // "Use 'max_completion_tokens' instead"
    if (profile.tokenField !== 'max_completion_tokens') {
      profile.tokenField = 'max_completion_tokens';
      return true;
    }
  }
  if (/unsupported|unknown|unrecognized|invalid/.test(d) && /max_completion_tokens/.test(d)) {
    if (profile.tokenField !== 'max_tokens') { profile.tokenField = 'max_tokens'; return true; }
  }
  if (/temperature/.test(d)) {
    if (profile.temperature) {
      profile.temperature = false;
      // 拒收 temperature 基本就是推理模型的标志。翻译不需要它先想一轮 ——
      // 默认档位（medium）既慢又要多烧一大截推理 token，这里顺手压到最低。
      // 万一这个字段它也不认，下一轮 adapt 会把它摘掉。
      if (profile.reasoningEffort === undefined) profile.reasoningEffort = 'low';
      return true;
    }
  }
  if (/max_tokens/.test(d)) {
    if (profile.tokenField !== 'max_completion_tokens') {
      profile.tokenField = 'max_completion_tokens';
      return true;
    }
    if (profile.tokenField) { profile.tokenField = null; return true; }   // 干脆不发
  }
  // 兜底：泛泛的"不支持的参数"，把可选项逐个摘掉
  if (/unsupported parameter|unrecognized request argument|extra fields/.test(d)) {
    if (profile.temperature) { profile.temperature = false; return true; }
    if (profile.tokenField) { profile.tokenField = null; return true; }
  }
  return false;
}

async function openai(cfg, { system, user, signal }) {
  await loadProfiles();
  const key = `${trimSlash(cfg.baseUrl)}|${cfg.model}`;
  const profile = {
    tokenField: 'max_tokens',
    temperature: true,
    reasoningEffort: undefined,   // undefined = 还没判断出是不是推理模型
    ...(PROFILES.get(key) || {}),
  };
  const original = JSON.stringify(profile);

  for (let attempt = 0; attempt < 4; attempt++) {
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (profile.temperature) body.temperature = 0.2;
    if (profile.tokenField) body[profile.tokenField] = 8192;
    if (profile.reasoningEffort) body.reasoning_effort = profile.reasoningEffort;

    const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      if (JSON.stringify(profile) !== original) await saveProfile(key, profile);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }

    const err = httpError(res.status, await res.text());
    // 只有 400 这种"参数不对"才值得调整重试；401/404/429 调了也没用
    if (res.status !== 400 || !adapt(profile, err.detail)) throw err;
  }
  throw new ApiError(`${cfg.model}：试了几种参数组合服务端都不接受，换个模型名看看`, 400, false);
}

/* ---------------------------------------------------------------- Bridge */

async function bridge(cfg, { system, user, signal }) {
  let res;
  try {
    res = await fetch(`${trimSlash(cfg.url)}/translate`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: cfg.engine, model: cfg.model || null, system, prompt: user }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(
      `连不上本地桥接 ${cfg.url} —— 先在终端跑 python3 bridge/bridge.py`,
      0,
      false,
    );
  }
  if (!res.ok) throw httpError(res.status, await res.text());
  const data = await res.json();
  if (data.error) throw new ApiError(data.error, 0, false);
  return data.text || '';
}

/* ---------------------------------------------------------------- Google */

async function google(cfg, { user, signal, targetLang }) {
  // 免费端点一次别喂太多，这里由上层控制 chunk 大小
  const tl = /中文|chinese|zh/i.test(targetLang || '') ? 'zh-CN' : 'zh-CN';
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=' +
    tl + '&q=' + encodeURIComponent(user);
  const res = await fetch(url, { signal });
  if (!res.ok) throw httpError(res.status, await res.text());
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

/* ------------------------------------------------------------------ 出口 */

export function getProvider(settings) {
  const p = settings.provider;
  if (p === 'anthropic') {
    if (!settings.anthropic.apiKey) throw new ApiError('还没填 Anthropic API key（设置页）', 0, false);
    return (req) => anthropic(settings.anthropic, req);
  }
  if (p === 'openai') {
    if (!settings.openai.apiKey) throw new ApiError('还没填 OpenAI API key（设置页）', 0, false);
    return (req) => openai(settings.openai, req);
  }
  if (p === 'bridge') return (req) => bridge(settings.bridge, req);
  if (p === 'google') return (req) => google(settings, { ...req, targetLang: settings.targetLang });
  throw new ApiError(`未知后端 ${p}`, 0, false);
}

/** google 后端不认识我们的分段协议，需要走逐段裸文本模式。 */
export const isPlainProvider = (settings) => settings.provider === 'google';

export async function listModels(settings, which) {
  if (which === 'anthropic') {
    const cfg = settings.anthropic;
    const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/models?limit=100`, {
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) throw httpError(res.status, await res.text());
    return (await res.json()).data.map((m) => m.id);
  }
  const cfg = settings.openai;
  const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  return (await res.json()).data.map((m) => m.id).sort();
}

export { ApiError };
