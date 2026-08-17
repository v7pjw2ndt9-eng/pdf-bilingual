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

function httpError(status, body) {
  const snippet = String(body || '').slice(0, 400);
  const retriable = status === 429 || status === 408 || status >= 500;
  let hint = '';
  if (status === 401 || status === 403) hint = ' —— API key 无效或没权限，去设置页检查。';
  if (status === 429) hint = ' —— 触发限速，正在退避重试。';
  return new ApiError(`HTTP ${status}${hint}\n${snippet}`, status, retriable);
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

async function openai(cfg, { system, user, signal }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // o 系列 / gpt-5 系列推理模型不接受 temperature，也不用 max_tokens
  if (!/^(o\d|gpt-5)/i.test(cfg.model)) {
    body.temperature = 0.2;
    body.max_tokens = 8192;
  }

  const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res.status, await res.text());
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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
