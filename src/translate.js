/**
 * 翻译调度：合批 -> 并发 -> 重试 -> 回填缓存。
 *
 * 合批是这里的重点。逐段请求既慢又贵，而且模型看不到上下文，术语会前后不一致。
 * 所以把同一页（不够就跨页）的若干段落打包成一次请求，用 <seg id> 包裹，
 * 让模型一次看到整段上下文，再按 id 拆回来。
 */

import { getProvider, isPlainProvider } from './providers.js';
import { hashKey, getMany, putMany } from './store.js';

const SYSTEM = (lang, glossary, docTitle) => `你是一位专业的学术文献译者，正在翻译一篇 PDF 文档${docTitle ? `《${docTitle}》` : ''}。

翻译要求：
1. 目标语言：${lang}。译文要通顺、符合中文表达习惯，不要逐词硬译，不要翻译腔。
2. 保持学术语域。专业术语首次出现时用「中文（English）」的形式，之后只用中文。
3. 以下内容原样保留，不要翻译、不要改动：
   - 数学公式、变量名、符号（如 $x_i$、λ、O(n log n)）
   - 引用标记（如 [12]、(Smith et al., 2020)）
   - 代码、URL、DOI、专有缩写（如 BERT、GPU、mRNA）
   - 图表编号（Figure 3、Table 2 译作「图 3」「表 2」）
4. 输入的每一段都是完整段落（已经过段落重建，不是按行切碎的），请按整段的语义翻译，
   不要在段内插入换行。
5. 只输出译文，不要任何解释、注释、前后缀。
${glossary ? `\n术语对照表（必须遵守）：\n${glossary}` : ''}

输出格式：对每个输入的 <seg id="N">，输出一个对应的 <seg id="N">译文</seg>，
id 必须与输入完全一致，顺序一致，一个都不能少。除此之外不要输出任何内容。`;

function buildUser(segs) {
  return segs.map((s) => `<seg id="${s.id}">\n${s.text}\n</seg>`).join('\n\n');
}

function parseSegs(out) {
  const map = new Map();
  const re = /<seg\s+id=["']?(\d+)["']?\s*>([\s\S]*?)<\/seg>/g;
  let m;
  while ((m = re.exec(out))) map.set(Number(m[1]), m[2].trim());
  return map;
}

/** 按字符预算把段落切成若干批，尽量不跨页拆分同一段上下文。 */
function makeBatches(items, budget) {
  const batches = [];
  let cur = [];
  let n = 0;
  for (const it of items) {
    const len = it.text.length;
    if (cur.length && n + len > budget) { batches.push(cur); cur = []; n = 0; }
    cur.push(it);
    n += len;
    // 单批段落数也设个上限，太多的话模型容易漏 seg
    if (cur.length >= 24) { batches.push(cur); cur = []; n = 0; }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      last = e;
      if (e.retriable === false || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await sleep(Math.min(16000, 900 * 2 ** i) + Math.random() * 400);
    }
  }
  throw last;
}

/**
 * @param {Array<{key:string, text:string}>} units 待译单元，key 用于缓存与回调标识
 * @param {object} settings
 * @param {object} hooks { onResult(key, text), onProgress(done, total), onError(err) }
 * @param {AbortSignal} signal
 */
export async function translateUnits(units, settings, hooks = {}, signal) {
  const { onResult = () => {}, onProgress = () => {}, onError = () => {} } = hooks;
  if (!units.length) return;

  const modelId =
    settings.provider === 'anthropic' ? settings.anthropic.model :
    settings.provider === 'openai' ? settings.openai.model :
    settings.provider === 'bridge' ? `bridge:${settings.bridge.engine}:${settings.bridge.model}` :
    'google';

  // 1. 查缓存
  const withHash = await Promise.all(
    units.map(async (u) => ({ ...u, h: await hashKey(modelId, settings.targetLang, u.text) })),
  );
  const cached = await getMany(withHash.map((u) => u.h));
  const todo = [];
  let done = 0;
  for (const u of withHash) {
    const hit = cached.get(u.h);
    if (hit != null) { onResult(u.key, hit, true); done++; } else todo.push(u);
  }
  onProgress(done, withHash.length);
  if (!todo.length) return;

  const provider = getProvider(settings);
  const plain = isPlainProvider(settings);
  const system = SYSTEM(settings.targetLang, settings.glossary.trim(), settings.docTitle || '');

  // 2. 分批
  const batches = plain
    ? todo.map((u) => [u])                                   // google 不支持分段协议
    : makeBatches(todo, settings.charsPerRequest);

  // 3. 并发跑
  let idx = 0;
  const writeBack = [];

  const worker = async () => {
    while (idx < batches.length) {
      if (signal?.aborted) return;
      const batch = batches[idx++];
      const segs = batch.map((u, i) => ({ id: i + 1, text: u.text }));
      try {
        const out = await withRetry(() =>
          provider({ system, user: plain ? batch[0].text : buildUser(segs), signal }),
        );

        if (plain) {
          const t = out.trim();
          onResult(batch[0].key, t);
          writeBack.push([batch[0].h, t]);
          done++;
        } else {
          const map = parseSegs(out);
          const missing = [];
          for (let i = 0; i < batch.length; i++) {
            const t = map.get(i + 1);
            if (t) {
              onResult(batch[i].key, t);
              writeBack.push([batch[i].h, t]);
              done++;
            } else {
              missing.push(batch[i]);
            }
          }
          // 模型漏了几段就单独补译，不整批重来
          for (const u of missing) {
            if (signal?.aborted) return;
            try {
              const one = await withRetry(() =>
                provider({ system, user: buildUser([{ id: 1, text: u.text }]), signal }),
              );
              const t = parseSegs(one).get(1) || one.trim();
              onResult(u.key, t);
              writeBack.push([u.h, t]);
              done++;
            } catch (e) { onError(e, u.key); }
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        for (const u of batch) onError(e, u.key);
      }
      onProgress(done, withHash.length);
      if (writeBack.length >= 20) await putMany(writeBack.splice(0));
    }
  };

  const n = Math.max(1, Math.min(8, settings.concurrency));
  await Promise.all(Array.from({ length: n }, worker));
  await putMany(writeBack);
}
