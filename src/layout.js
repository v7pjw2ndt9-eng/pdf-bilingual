/**
 * 段落重建引擎 —— 这个扩展的核心。
 *
 * pdf.js 的 getTextContent() 给出的是一堆碎片化的 text item（常常一行被切成
 * 十几段，甚至一个词一段）。绝大多数 PDF 翻译工具直接把「一行」当成翻译单元，
 * 于是译文被硬生生按行截断，语义全丢。
 *
 * 这里做四件事：
 *   1. item -> line      按基线聚合，处理上下标
 *   2. line -> column    用 x 轴占用直方图找竖直白沟（gutter），识别单栏/双栏/三栏
 *   3. column -> band    识别跨栏元素（标题、通栏图表），确定阅读顺序
 *   4. line -> paragraph 用行距、行尾留白、首行缩进、字号变化判断段落边界
 *
 * 坐标系：一律用 PDF 用户空间（y 轴向上，原点左下角），渲染时再翻成屏幕坐标。
 */

const BLANK = /^\s*$/;

/* ---------------------------------------------------------------- 1. items */

function toBoxes(items, rotated) {
  const out = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || BLANK.test(it.str)) continue;
    const t = it.transform;
    if (!t) continue;
    // 丢掉非水平的文字。arXiv 那种印在左边距上的竖排水印如果不滤掉，
    // 会被按基线并进正文，得到 "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023best models from…"。
    if (Math.abs(t[1]) > 0.2 * Math.max(Math.abs(t[0]), 1e-6)) {
      rotated.push({ x: t[4], y: t[5] });
      continue;
    }
    // 字号 = 变换矩阵的竖直缩放量
    const fs = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 1;
    const x0 = t[4];
    const w = it.width || 0;
    out.push({
      str: it.str,
      x0,
      x1: x0 + w,
      y: t[5], // 基线
      fs,
      font: it.fontName || '',
      len: it.str.trim().length,
    });
  }
  return out;
}

/**
 * 摘掉页边距上的行号。
 *
 * 投稿稿件、bioRxiv 预印本会给每行打行号。这些数字不摘掉有两个后果：
 *   1. 被并进正文送去翻译，译文里冒出 "…外套层发育和结构，24已有所了解"
 *   2. "23 enabled the generation of…" 会被编号标题规则命中，于是每一行
 *      都被切成独立段落 —— 正是要消灭的「按行打断」
 *
 * 判据：纯数字、x 坐标聚成一条窄带、落在正文块之外的页边距上、自上而下递增。
 * 四条同时满足才删，避免误伤表格里的数字列。
 */
function stripLineNumbers(boxes) {
  const isNum = (b) => /^\d{1,4}$/.test(b.str.trim());
  const nums = boxes.filter(isNum);
  if (nums.length < 6) return boxes;

  const others = boxes.filter((b) => !isNum(b));
  if (others.length < 10) return boxes;
  const textL = Math.min(...others.map((b) => b.x0));
  const textR = Math.max(...others.map((b) => b.x1));

  const clusters = new Map();
  for (const b of nums) {
    const k = Math.round(b.x0 / 4);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(b);
  }

  const drop = new Set();
  for (const g of clusters.values()) {
    if (g.length < 6) continue;
    // 必须在正文块外侧的页边距上，表格里的数字列不在这个位置
    const inMargin = Math.max(...g.map((b) => b.x1)) <= textL + 2 ||
                     Math.min(...g.map((b) => b.x0)) >= textR - 2;
    if (!inMargin) continue;
    // 窄带
    if (Math.max(...g.map((b) => b.x1)) - Math.min(...g.map((b) => b.x0)) > 30) continue;
    // 自上而下递增
    const seq = g.slice().sort((a, b) => b.y - a.y).map((b) => +b.str.trim());
    let inc = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] > seq[i - 1]) inc++;
    if (inc < (seq.length - 1) * 0.8) continue;

    for (const b of g) drop.add(b);
  }

  return drop.size ? boxes.filter((b) => !drop.has(b)) : boxes;
}

/** 按「字符数加权」取众数字号，得到正文字号。标题/脚注不会干扰结果。 */
function bodyFontSize(boxes) {
  const hist = new Map();
  for (const b of boxes) {
    const k = Math.round(b.fs * 2) / 2; // 0.5pt 一档
    hist.set(k, (hist.get(k) || 0) + b.len);
  }
  let best = 10, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/* -------------------------------------------------------------- 2. columns */

/**
 * 找竖直白沟。
 *
 * 简单地在 x 轴上做一维投影是不够的：通栏标题会把中缝填满，导致双栏被误判成单栏。
 * 所以这里做二维判据 —— 把页面切成若干横带，一条 x 区间只有在「绝大多数横带里
 * 都没有文字」时才算白沟。
 */
function findGutters(boxes, page) {
  if (boxes.length < 40) return [];

  const left = Math.min(...boxes.map((b) => b.x0));
  const right = Math.max(...boxes.map((b) => b.x1));
  const top = Math.max(...boxes.map((b) => b.y));
  const bottom = Math.min(...boxes.map((b) => b.y));
  const cw = right - left;
  const ch = top - bottom;
  if (cw <= 0 || ch <= 0) return [];

  const NX = 120, NY = 40;
  const binW = cw / NX, bandH = ch / NY;
  // occ[x][y] = 该格子里是否有文字
  const occ = Array.from({ length: NX }, () => new Uint8Array(NY));
  const bandUsed = new Uint8Array(NY);

  for (const b of boxes) {
    const yi = Math.min(NY - 1, Math.max(0, Math.floor((top - b.y) / bandH)));
    bandUsed[yi] = 1;
    const i0 = Math.max(0, Math.floor((b.x0 - left) / binW));
    const i1 = Math.min(NX - 1, Math.ceil((b.x1 - left) / binW) - 1);
    for (let i = i0; i <= i1; i++) occ[i][yi] = 1;
  }

  const liveBands = bandUsed.reduce((a, v) => a + v, 0) || 1;
  // 一个 x 分箱被占用的横带数
  const usage = new Array(NX).fill(0);
  for (let i = 0; i < NX; i++) {
    let n = 0;
    for (let j = 0; j < NY; j++) if (occ[i][j]) n++;
    usage[i] = n / liveBands;
  }

  const EMPTY = 0.12;         // 占用率低于此视为空
  const MIN_W = 0.018 * cw;   // 白沟最小宽度
  const gutters = [];
  let run = -1;
  for (let i = 0; i <= NX; i++) {
    const empty = i < NX && usage[i] <= EMPTY;
    if (empty && run < 0) run = i;
    if (!empty && run >= 0) {
      const gx0 = left + run * binW;
      const gx1 = left + i * binW;
      // 贴着页面左右边缘的空白是页边距，不是白沟
      const atEdge = run === 0 || i === NX;
      if (!atEdge && gx1 - gx0 >= MIN_W) gutters.push({ x0: gx0, x1: gx1 });
      run = -1;
    }
  }

  // 白沟两侧的栏都必须够宽，否则那多半是个居中标题造成的假白沟
  const bounds = [left, ...gutters.flatMap((g) => [g.x0, g.x1]), right];
  const widths = [];
  for (let i = 0; i < bounds.length; i += 2) widths.push(bounds[i + 1] - bounds[i]);
  if (widths.some((w) => w < 0.14 * cw)) return [];
  if (gutters.length > 2) return []; // 四栏以上多半是误判（表格）

  return gutters;
}

function buildColumns(boxes, page) {
  const gutters = findGutters(boxes, page);
  const left = Math.min(...boxes.map((b) => b.x0));
  const right = Math.max(...boxes.map((b) => b.x1));

  const cols = [];
  let cursor = left;
  for (const g of gutters) {
    cols.push({ x0: cursor, x1: g.x0 });
    cursor = g.x1;
  }
  cols.push({ x0: cursor, x1: right });

  // 给每个 box 标栏号；跨白沟的（通栏标题、宽表格）标成 -1
  for (const b of boxes) {
    b.col = -1;
    for (let i = 0; i < cols.length; i++) {
      // 允许 2pt 的容差，避免斜体尾巴溢出栏边界导致误判为通栏
      if (b.x0 >= cols[i].x0 - 2 && b.x1 <= cols[i].x1 + 2) { b.col = i; break; }
    }
  }
  return cols;
}

/* ---------------------------------------------------------------- 3. lines */

/**
 * 必须先按栏分组再聚合基线 —— 否则双栏论文里左右栏处在同一水平线上的文字
 * 会被拼成一行，得到 "…Unlike left-to- These approaches have been…" 这种鬼东西。
 */
function buildLines(boxes) {
  const groups = new Map();
  for (const b of boxes) {
    if (!groups.has(b.col)) groups.set(b.col, []);
    groups.get(b.col).push(b);
  }
  const out = [];
  for (const g of groups.values()) out.push(...buildLinesIn(g));
  return out;
}

function buildLinesIn(boxes) {
  const sorted = boxes.slice().sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];
  let cur = null;

  for (const b of sorted) {
    // 容差取 0.4 倍字号：足以把上标引文 [12]、下标 x_i 吸进同一行，
    // 又不至于把行距很紧的两行并成一行。
    const tol = 0.4 * Math.max(b.fs, cur ? cur.fs : b.fs);
    if (cur && Math.abs(b.y - cur.y) <= tol) {
      cur.items.push(b);
      if (b.fs > cur.fs) { cur.fs = b.fs; cur.y = b.y; } // 基线以最大字号的那个为准
    } else {
      cur = { y: b.y, fs: b.fs, col: b.col, items: [b] };
      lines.push(cur);
    }
  }

  for (const ln of lines) {
    ln.items.sort((a, b) => a.x0 - b.x0);
    ln.x0 = Math.min(...ln.items.map((i) => i.x0));
    ln.x1 = Math.max(...ln.items.map((i) => i.x1));
    ln.top = ln.y + ln.fs * 0.85;
    ln.bottom = ln.y - ln.fs * 0.25;
    ln.text = joinItems(ln.items);
    ln.font = dominantFont(ln.items);
    ln.col = ln.items[0].col;
  }
  return lines.filter((l) => l.text.trim());
}

/** pdf.js 经常不吐空格 —— 靠 item 之间的水平间隙自己补。 */
function joinItems(items) {
  let s = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const gap = it.x0 - items[i - 1].x1;
      const needSpace = gap > 0.18 * it.fs;
      const already = /\s$/.test(s) || /^\s/.test(it.str);
      if (needSpace && !already) s += ' ';
    }
    s += it.str;
  }
  return s.replace(/\s+/g, ' ').trim();
}

function dominantFont(items) {
  const hist = new Map();
  for (const it of items) hist.set(it.font, (hist.get(it.font) || 0) + it.len);
  let best = '', bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { best = k; bestN = n; }
  return best;
}

/* ---------------------------------------------------------------- 4. bands */

/**
 * 把通栏行聚成「通栏带」，通栏带之间的部分就是「分栏带」。
 * 这样才能得到正确的阅读顺序：标题 -> 左栏 -> 右栏 -> 通栏图 -> 左栏 -> ...
 */
function buildBands(lines, cols) {
  if (cols.length === 1) {
    return [{ type: 'cols', cols: [lines.slice().sort((a, b) => b.y - a.y)] }];
  }

  const span = lines.filter((l) => l.col === -1).sort((a, b) => b.y - a.y);
  const colLines = lines.filter((l) => l.col >= 0);

  // 相邻的通栏行合并成一个带
  const spanBands = [];
  for (const l of span) {
    const last = spanBands[spanBands.length - 1];
    if (last && last.top - l.top < 3 * Math.max(l.fs, 1)) {
      last.bottom = Math.min(last.bottom, l.bottom);
      last.lines.push(l);
    } else {
      spanBands.push({ top: l.top, bottom: l.bottom, lines: [l] });
    }
  }

  const bands = [];
  let cut = Infinity; // 当前分栏带的上边界
  for (const sb of spanBands) {
    const between = colLines.filter((l) => l.y < cut && l.y > sb.top);
    if (between.length) bands.push(makeColBand(between, cols));
    bands.push({ type: 'full', lines: sb.lines.sort((a, b) => b.y - a.y) });
    cut = sb.bottom;
  }
  const tail = colLines.filter((l) => l.y < cut);
  if (tail.length) bands.push(makeColBand(tail, cols));

  return bands.filter((b) => (b.type === 'full' ? b.lines.length : b.cols.some((c) => c.length)));
}

function makeColBand(lines, cols) {
  const buckets = cols.map(() => []);
  for (const l of lines) buckets[Math.min(l.col, cols.length - 1)].push(l);
  for (const b of buckets) b.sort((a, c) => c.y - a.y);
  return { type: 'cols', cols: buckets };
}

/* ----------------------------------------------------------- 5. paragraphs */

const NUM_HEADING_RE = /^\d+(?:\.\d+)*\.?\s+\S/;
const NAMED_HEADING_RE = /^(?:[IVXLC]+\.\s+\S|(?:abstract|introduction|related work|background|method(?:s|ology)?|experiments?|results?|discussion|conclusions?|acknowledg(?:e)?ments?|references|bibliography|appendix)\b)/i;

/**
 * 编号小节标题必然是短行。不加长度限制的话，带行号稿件里的
 * "23 enabled the generation of diverse neuron types…" 会被当成小节标题，
 * 于是每一行都被切成独立段落 —— 也就是最要命的「按行打断」。
 */
function looksLikeHeading(t) {
  if (NAMED_HEADING_RE.test(t)) return true;
  return NUM_HEADING_RE.test(t) && t.length < 90;
}
const CAPTION_RE = /^(?:fig(?:ure)?\.?|table|tab\.|algorithm|listing|scheme)\s*\.?\s*\d/i;
const REFHEAD_RE = /^(?:references|bibliography|参考文献|works cited)\s*$/i;
const PAGENUM_RE = /^[\s\-–—|]*(?:\d{1,4}|[ivxlcdm]{1,7})[\s\-–—|]*$/i;
// 预印本/期刊每页盖的水印横幅。不滤掉的话每页都要花 token 翻一遍版权声明。
const STAMP_RE = /(?:bio|med)Rxiv preprint|preprint doi:\s*https?:\/\/|copyright holder for this preprint|granted (?:bio|med)Rxiv a license|No reuse allowed without permission|made available under a\s+CC-BY|Downloaded from https?:\/\//i;
// 数字上限卡在两位：不然 "2014) methods. Pre-trained word embeddings…" 这种
// 跨行的引文年份残片会被当成有序列表项，把段落从中间劈开。
const BULLET_RE = /^\s*(?:[•·▪◦‣∙*]|\(\d{1,2}\)|\d{1,2}\)|[a-z]\))\s+/i;

/** 判断这一段是不是不该送去翻译（页码、页眉页脚、纯公式、纯符号）。 */
function classify(block, ctx) {
  const t = block.text.trim();
  if (STAMP_RE.test(t)) return 'skip';
  const letters = (t.match(/[A-Za-z一-鿿]/g) || []).length;

  if (block.lines.length === 1) {
    const nearEdge = block.top > ctx.pageTop - 0.06 * ctx.pageH ||
                     block.bottom < ctx.pageBottom + 0.06 * ctx.pageH;
    if (nearEdge && (PAGENUM_RE.test(t) || t.length < 60)) return 'skip';
  }
  if (letters < 3) return 'skip';
  // 字母占比过低 = 行间公式、表格数字行
  if (letters / Math.max(t.length, 1) < 0.34) return 'skip';

  if (CAPTION_RE.test(t)) return 'caption';
  if (REFHEAD_RE.test(t)) return 'heading';
  if (
    block.lines.length <= 2 &&
    t.length < 90 &&
    !/[.。;；]$/.test(t) &&
    (block.fs > ctx.bodyFs * 1.05 || looksLikeHeading(t) || /bold/i.test(block.font))
  ) return 'heading';

  return 'body';
}

function paragraphize(lines, colBox, ctx) {
  if (!lines.length) return [];

  // 行距中位数 —— 用它当「这里有没有多余竖直空白」的基准
  const leads = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i - 1].y - lines[i].y;
    if (d > 0 && d < 4 * ctx.bodyFs) leads.push(d);
  }
  leads.sort((a, b) => a - b);
  const medLead = leads.length ? leads[leads.length >> 1] : ctx.bodyFs * 1.2;

  // 左右边界必须取「局部」值。用整栏的 min/max 会被离群元素（脚注横线、
  // 宽表格、居中标题）带偏，一旦偏了，每一行看上去都「没写满」或「有缩进」，
  // 于是每行都被判成段落 —— 就退化成了按行翻译。
  const W = 4;
  const localRight = (i) => {
    let m = -Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(lines.length - 1, i + W); j++) m = Math.max(m, lines[j].x1);
    return m;
  };
  const localLeft = (i) => {
    let m = Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(lines.length - 1, i + W); j++) m = Math.min(m, lines[j].x0);
    return m;
  };

  // 两端对齐的版面里「行尾留白」是很强的段落信号；左对齐（右侧参差）的版面里
  // 它几乎没有意义，此时把阈值放宽，主要靠行距和缩进判断。
  let flush = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].x1 > localRight(i) - 1.0 * lines[i].fs) flush++;
  const justified = lines.length >= 4 && flush / lines.length > 0.62;
  const shortTail = justified ? 2.6 : 7.0;

  const groups = [];
  let cur = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const ln = lines[i];
    const lead = prev.y - ln.y;

    const indent = ln.x0 - localLeft(i);

    // (a) 竖直空白变大
    const bigGap = lead > medLead * 1.45;
    // (b) 字号跳变（正文 -> 标题 / 正文 -> 脚注）
    const fsJump = Math.abs(ln.fs - prev.fs) > 0.14 * prev.fs;
    // (c) 上一行没写满，右边留了一大截 —— 段落自然结束
    const shortPrev = prev.x1 < localRight(i - 1) - shortTail * prev.fs;
    // (d) 本行是首行缩进。缩进量在 1~2 个字宽之间；差得更多的多半是居中行，
    //     交给 (c) 去判。
    //     还要跟「悬挂缩进」区分开 —— 项目符号列表的续行也比左边界靠右，
    //     但它跟自己的下一行对齐。真正的首行缩进是：比上一行靠右，也比下一行靠右。
    const nextLn = lines[i + 1];
    const indented =
      indent > 0.5 * ln.fs && indent < 4.5 * ln.fs &&
      prev.x0 < ln.x0 - 0.5 * ln.fs &&
      (!nextLn || ln.x0 > nextLn.x0 + 0.5 * ln.fs);
    // (e) 本行是标题、图表题或列表项
    const headStart = looksLikeHeading(ln.text) || CAPTION_RE.test(ln.text) || BULLET_RE.test(ln.text);
    // (f) 上一行本身就是个独立的小节标题，标题不能跟正文粘在一起
    const headEnd = looksLikeHeading(prev.text) && prev.text.length < 70;

    let brk = bigGap || fsJump || shortPrev || indented || headStart || headEnd;

    // 反否决 1：唯一的理由是「上一行没写满」，但那一行明显话没说完
    // （以逗号/连词/左括号结尾，下一行以小写字母或 "2018)" 这种残片开头）。
    // ACL 那种密集引文的排版经常这样，不挡住就会把一段切成好几截。
    if (brk && !bigGap && !fsJump && !indented && !headStart && !headEnd &&
        /[a-z,;:(\[-]$/.test(prev.text) && /^[a-z0-9)\]]/.test(ln.text)) brk = false;

    // 反否决 2：行末连字符断词，这两行必然是连着的
    if (/[‐-―-]$/.test(prev.text) && !bigGap && !fsJump) brk = false;

    if (brk) { groups.push(cur); cur = [ln]; } else cur.push(ln);
  }
  groups.push(cur);

  return groups.map((g) => {
    const block = {
      lines: g,
      text: mergeLines(g, ctx.vocab),
      x0: Math.min(...g.map((l) => l.x0)),
      x1: Math.max(...g.map((l) => l.x1)),
      top: Math.max(...g.map((l) => l.top)),
      bottom: Math.min(...g.map((l) => l.bottom)),
      fs: g[0].fs,
      font: g[0].font,
      colX0: colBox ? colBox.x0 : Math.min(...g.map((l) => l.x0)),
      colX1: colBox ? colBox.x1 : Math.max(...g.map((l) => l.x1)),
    };
    block.kind = classify(block, ctx);
    return block;
  });
}

/**
 * 行末连字符有两种，长得一模一样：
 *   断词符   "internation-\nalization"  -> 要删掉  -> internationalization
 *   复合词符 "fine-\ntuning"            -> 要保留  -> fine-tuning
 * 删错了会得到 "finetuning"、"left-toright" 这种词，翻译质量跟着掉。
 * 判据依次是：全文词表里见过哪种写法 -> 左半截自己是否已含连字符 -> 常见构词前缀。
 */
const HYPHEN_PREFIX = new Set([
  'pre', 'post', 'non', 'self', 'semi', 'multi', 'sub', 'co', 'anti', 'intra', 'inter',
  'cross', 'fine', 'coarse', 'well', 'high', 'low', 'long', 'short', 'large', 'small',
  'open', 'closed', 'end', 'state', 'task', 'word', 'sentence', 'token', 'left', 'right',
  'top', 'bottom', 'real', 'full', 'half', 'per', 'meta', 'micro', 'macro', 'mini',
  'over', 'under', 'bi', 'tri', 'uni', 'auto', 'quasi', 'pseudo', 'so', 'in', 'out',
  'two', 'three', 'first', 'second', 'human', 'machine', 'data', 'model', 'context',
]);

function mergeLines(lines, vocab) {
  let s = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (i === 0) { s = t; continue; }

    const hy = /([A-Za-zÀ-ɏ][\w'‐-―-]*)[‐-―-]$/.exec(s);
    if (hy && /^[a-zß-ɏ]/.test(t)) {
      const left = hy[1];
      const rightWord = (/^([A-Za-zÀ-ɏ][\w']*)/.exec(t) || ['', ''])[1];
      const joined = (left + rightWord).toLowerCase();
      const hyphenated = `${left}-${rightWord}`.toLowerCase();

      let keep;
      if (vocab && vocab.has(hyphenated)) keep = true;
      else if (vocab && vocab.has(joined)) keep = false;
      else keep = /[‐-―-]/.test(left) || HYPHEN_PREFIX.has(left.toLowerCase());

      s = keep ? s + t : s.slice(0, -1) + t;
    } else if (/[一-鿿]$/.test(s) && /^[一-鿿]/.test(t)) {
      s += t;                       // 中文行之间不加空格
    } else {
      s += ' ' + t;
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 全文出现过的词（含带连字符的整词），供上面判断断词符用。 */
function buildVocab(lines) {
  const set = new Set();
  for (const ln of lines) {
    for (const w of ln.text.split(/[^\w'‐-―-]+/)) {
      const t = w.toLowerCase().replace(/^[‐-―-]+|[‐-―-]+$/g, '');
      if (t.length > 2) set.add(t);
    }
  }
  return set;
}

/* ----------------------------------------------------------------- 6. 出口 */

/**
 * @param {object} textContent  page.getTextContent() 的结果
 * @param {object} page         { width, height } PDF 用户单位，scale=1
 * @returns {{ blocks, bands, cols, bodyFs, ok }}
 */
export function analyzePage(textContent, page, opts = {}) {
  const rotated = [];
  const boxes = stripLineNumbers(toBoxes(textContent.items, rotated));
  if (boxes.length < 3) {
    return { blocks: [], bands: [], cols: [], bodyFs: 10, cropX0: 0, cropX1: page.width, ok: true };
  }

  const bodyFs = bodyFontSize(boxes);
  const cols = buildColumns(boxes, page);
  const lines = buildLines(boxes);
  const bands = buildBands(lines, cols);

  // 词表可以由调用方跨页共享，见过的整词越多，断词符判得越准
  const vocab = opts.vocab || new Set();
  for (const w of buildVocab(lines)) vocab.add(w);

  const ctx = {
    bodyFs,
    vocab,
    pageH: page.height,
    pageTop: Math.max(...boxes.map((b) => b.y)),
    pageBottom: Math.min(...boxes.map((b) => b.y)),
  };

  let seq = 0;
  const blocks = [];
  for (const band of bands) {
    if (band.type === 'full') {
      const full = { x0: Math.min(...band.lines.map((l) => l.x0)), x1: Math.max(...band.lines.map((l) => l.x1)) };
      band.blocks = paragraphize(band.lines, full, ctx);
      for (const b of band.blocks) { b.i = seq++; b.band = band; blocks.push(b); }
    } else {
      band.colBlocks = band.cols.map((ls, ci) => {
        const bs = paragraphize(ls, cols[ci], ctx);
        for (const b of bs) { b.i = seq++; b.band = band; b.colIndex = ci; blocks.push(b); }
        return bs;
      });
    }
  }

  // 页边距上的竖排水印（arXiv 戳）会被切片反复截断，看起来像重复了好几次。
  // 只有确实存在这种边距文字时才收窄裁切范围 —— 否则出血图会被切掉。
  const contentL = Math.min(...boxes.map((b) => b.x0));
  const contentR = Math.max(...boxes.map((b) => b.x1));
  const sideStamp = rotated.some((r) => r.x < contentL - 4 || r.x > contentR + 4);

  return {
    blocks, bands, cols, bodyFs, ok: true,
    cropX0: sideStamp ? Math.max(0, contentL - 6) : 0,
    cropX1: sideStamp ? Math.min(page.width, contentR + 6) : page.width,
  };
}

/** 供调用方跨页维护「是否已进入参考文献」状态。 */
export function isReferencesHeading(text) {
  return REFHEAD_RE.test(text.trim());
}
