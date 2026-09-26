/**
 * 网页版的「段落划分」—— PDF 那边要从碎片重建段落，网页这边结构本来就在
 * DOM 里，难点反过来了：怎么找到「一个完整的散文单元」而不把它切碎，
 * 也不把整块无关的界面文字裹进来。
 *
 * 核心是 processElement 里的「行内游程分组」：一个元素的子节点里，连续的
 * 文本节点和行内元素攒成一个单元，遇到块级子元素就先收尾再递归下去。
 * 这样 <li>文字<ul>嵌套</ul></li> 会得到「文字」和嵌套项各自独立的单元，
 * 而 <p>前面<a>链接</a>后面</p> 始终是一整段。
 *
 * 不是 ES module —— content script 里多个文件共享同一个隔离世界的全局，
 * 用全局挂载最省事，顺便让测试台能拿普通 <script> 加载它。
 */
var PBXBlocks = (function () {
  'use strict';

  // 整棵子树都不要碰的
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'FRAME',
    'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'OPTGROUP', 'MATH', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE',
    'RUBY', 'RT', 'RP', 'PROGRESS', 'METER', 'DIALOG',
  ]);

  // 原样保留、用占位符替代的行内元素（代码、公式）
  const ATOMIC = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'TT']);
  const ATOMIC_SEL = '.katex, .MathJax, .mwe-math-element, mjx-container, [data-latex], [data-tex]';

  // 行内元素：不打断段落
  const INLINE = new Set([
    'A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'MARK', 'ABBR',
    'CITE', 'Q', 'TIME', 'SUP', 'SUB', 'LABEL', 'FONT', 'BDI', 'BDO', 'WBR',
    'DEL', 'INS', 'BIG', 'STRIKE', 'ACRONYM', 'DFN', 'DATA', 'OUTPUT',
    'BR', 'IMG', 'PICTURE', 'NOBR',
    ...ATOMIC,
  ]);

  // 界面外壳：里面的短文本是导航/按钮标签，翻了只有噪音
  // 纯导航容器：里面不会有正文，一律跳过
  const NAV_SEL = 'nav, [role="navigation"], [role="tablist"], [role="menubar"], [role="menu"], ' +
                  '.navbar, .breadcrumb, .pagination';
  // 可能夹带正文的外壳：只跳过其中的短标签
  const CHROME_SEL = NAV_SEL + ', header, footer, aside, [role="banner"], [role="contentinfo"], ' +
                     '[role="search"], button, [role="button"], .nav, .menu';

  const OURS = 'pbx-tr';                    // 我们插进去的译文块
  const MARK = 'data-pbx';                  // 处理过的标记

  const PH_OPEN = '⟦';                 // ⟦
  const PH_CLOSE = '⟧';                // ⟧

  /* ------------------------------------------------------------ 判定 */

  const isEl = (n) => n && n.nodeType === 1;
  const isText = (n) => n && n.nodeType === 3;

  function isOurs(el) {
    return isEl(el) && (el.classList?.contains(OURS) || el.hasAttribute?.('data-pbx-tr'));
  }

  function isAtomic(el) {
    if (ATOMIC.has(el.tagName)) return true;
    try { return el.matches(ATOMIC_SEL); } catch { return false; }
  }

  /**
   * 行内还是块级，必须由 CSS 说了算，标签名只能当兜底。
   *
   * React Native Web（X、Bluesky 等一大批应用都用它）把所有布局都交给 CSS：
   * 实测 Bluesky 一页里 337 个 <span>/<a>，183 个是 display:block、75 个是
   * display:flex，真正 inline 的只有 79 个。先看标签名就返回的话，这些块级盒子
   * 会被塞进同一个游程，结果是「34.9M followers15 following」这种粘成一坨的
   * 烂文本被送去翻译。
   *
   * 代价可以接受：对整页 5178 个元素取计算样式只要 3ms，而且结果有缓存。
   */
  const INLINE_DISPLAY = new Set([
    'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
    'ruby', 'ruby-base', 'ruby-text', 'math',
  ]);

  // 这几个无论 CSS 怎么写都不该切断段落
  const ALWAYS_INLINE = new Set(['BR', 'IMG', 'WBR', 'PICTURE', 'SVG']);

  // 语义标签听语义的，不听 CSS。Wikipedia 的 Vector 2022 把 <h2> 设成
  // display:inline（为了让 [edit] 链接贴在标题旁边），纯按 CSS 判断的话
  // 所有章节标题都会并进相邻游程、连带丢掉「这是标题」这个身份。
  // React Native Web 只会吐 div/span/a，所以保留语义标签的判断不影响推特那边。
  const ALWAYS_BLOCK = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
    'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'ARTICLE', 'SECTION', 'MAIN', 'ASIDE',
    'NAV', 'HEADER', 'FOOTER', 'FORM', 'FIELDSET', 'HR', 'ADDRESS', 'DETAILS', 'SUMMARY',
  ]);

  const dispCache = new WeakMap();

  function displayOf(el) {
    if (dispCache.has(el)) return dispCache.get(el);
    let d = '';
    try { d = getComputedStyle(el).display || ''; } catch { d = ''; }
    dispCache.set(el, d);
    return d;
  }

  function isInline(el) {
    if (ALWAYS_INLINE.has(el.tagName)) return true;
    if (ALWAYS_BLOCK.has(el.tagName)) return false;
    const d = displayOf(el);
    return d ? INLINE_DISPLAY.has(d) : INLINE.has(el.tagName);   // 取不到样式时按标签兜底
  }

  /**
   * display:contents 是「透明层」：自己不生成盒子，子节点直接参与父级布局。
   * 既不能当隐藏（会丢整棵子树），也不能当行内 —— 当行内的话里面的块级段落
   * 会被一起卷进同一个游程。Google AI Mode 整篇回答就是这样挤成一条的。
   * 正确做法是递归进去，但把子节点当作父元素的子节点来处理。
   */
  function isTransparent(el) {
    if (ALWAYS_INLINE.has(el.tagName) || ALWAYS_BLOCK.has(el.tagName)) return false;
    return displayOf(el) === 'contents';
  }

  /**
   * checkVisibility 是原生实现，比取整份计算样式快一个量级。但有两个坑：
   *
   * 1. display:contents 的元素自己不生成盒子（这正是它的用途 —— 让包装层从
   *    布局树里消失、子节点照常参与父级布局），checkVisibility 按规范返回
   *    false。当成隐藏就会把整棵子树丢掉。Google AI Mode 的正文就藏在这样
   *    一个 wrapper 下面，整页 5000 字只能抓到 3 条无障碍标签。
   *
   * 2. contentVisibilityAuto 会把 content-visibility:auto 的屏幕外内容判为
   *    不可见。那些文字在 DOM 里、滚过去就会显示，对翻译器来说该算可见，
   *    所以这个选项不能开。
   */
  function isHidden(el) {
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return true;

    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      // 返回 false 的少数情况才值得多花一次计算样式去甄别
      try { return getComputedStyle(el).display !== 'contents'; } catch { return true; }
    }

    try {
      const st = getComputedStyle(el);
      if (st.display === 'contents') return false;
      return st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0;
    } catch { return false; }
  }

  function shouldSkip(el) {
    if (SKIP.has(el.tagName)) return true;
    if (isOurs(el)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute?.('translate') === 'no') return true;
    if (el.classList?.contains('notranslate')) return true;
    if (isHidden(el)) return true;
    return false;
  }

  /* -------------------------------------------------- 文本与占位符 */

  /**
   * 把一串节点抽成纯文本。行内代码和公式换成 ⟦1⟧ 这样的占位符，
   * 翻完再替换回去 —— 比只在提示词里叮嘱「不要翻译代码」可靠得多。
   */
  function extractText(nodes) {
    let s = '';
    const ph = [];
    // 刚跨过一个元素边界。现代框架的模板里元素之间没有空白文本节点，
    // <span>Market</span><span>topchicken</span> 直接拼起来就成了
    // "Markettopchicken"，送去翻译的原文本身就是烂的。
    let boundary = false;

    const put = (txt) => {
      if (!txt) return;
      if (boundary && /\w$/.test(s) && /^\w/.test(txt)) s += ' ';
      boundary = false;
      s += txt;
    };

    const visit = (n) => {
      if (isText(n)) { put(n.nodeValue); return; }
      if (!isEl(n)) return;
      if (n.tagName === 'BR') { s += ' '; boundary = false; return; }
      if (isOurs(n)) return;
      if (isAtomic(n)) {
        const t = n.textContent.trim();
        if (t) { ph.push(t); put(PH_OPEN + ph.length + PH_CLOSE); }
        return;
      }
      if (shouldSkip(n)) return;
      boundary = true;
      for (const c of n.childNodes) visit(c);
      if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) visit(c);
      boundary = true;
    };

    nodes.forEach(visit);
    return { text: s.replace(/\s+/g, ' ').trim(), ph };
  }

  function restore(text, ph) {
    if (!ph.length) return text;
    return text.replace(
      new RegExp(PH_OPEN + '\\s*(\\d+)\\s*' + PH_CLOSE, 'g'),
      (m, i) => ph[+i - 1] ?? m,
    );
  }

  /* ---------------------------------------------------- 值不值得翻 */

  const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;
  // 社交媒体信息流里满地都是这些：用户名、@handle、域名、计数
  const HANDLE_RE = /^[@#][\w.\-]+$/;
  const DOMAINISH_RE = /^[\w-]+(?:\.[\w-]+)+$/;
  const COUNTISH_RE = /^\d[\d.,]*\s*[KMB]?\s+\w+$/i;
  const SENTENCE_END_RE = /[.!?。！？…][\"'”’）)\]]?\s*$/;
  const LATIN = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

  function nearestBlock(node) {
    let el = isEl(node) ? node : node.parentElement;
    while (el && isInline(el)) el = el.parentElement;
    return el;
  }

  /** 纯导航容器里不会有正文，长短都跳过。 */
  const navCache = new WeakMap();
  function inNav(node) {
    const el = isEl(node) ? node : node.parentElement;
    if (!el) return false;
    if (navCache.has(el)) return navCache.get(el);
    let hit = false;
    try { hit = !!el.closest(NAV_SEL); } catch { hit = false; }
    navCache.set(el, hit);
    return hit;
  }

  const chromeCache = new WeakMap();
  /** 标题类元素里的单词值得翻（Wikipedia 的 "History"），信息流里的用户名不值得。 */
  function isHeadingish(node) {
    const el = isEl(node) ? node : node.parentElement;
    if (!el) return false;
    // 用 closest 而不是「一路向上跳过行内元素」—— 标题元素自己就可能被
    // CSS 设成 inline，那种写法会直接跳过它、丢掉标题身份。
    try { return !!el.closest('h1,h2,h3,h4,h5,h6,th,dt,[role="heading"]'); }
    catch { return false; }
  }

  function inChrome(node) {
    const el = isEl(node) ? node : node.parentElement;
    if (!el) return false;
    if (chromeCache.has(el)) return chromeCache.get(el);
    let hit = false;
    try { hit = !!el.closest(CHROME_SEL); } catch { hit = false; }
    chromeCache.set(el, hit);
    return hit;
  }

  function worthTranslating(text, nodes, opts) {
    if (text.length < 2) return false;

    const latin = (text.match(LATIN) || []).length;
    const cjk = (text.match(CJK) || []).length;

    // 一个字母都没有：纯数字、符号、日期
    if (latin === 0 && cjk === 0) return false;
    // 已经是目标语言（中文占比高）就别翻了
    if (opts.targetIsCJK && cjk > 0 && cjk / Math.max(latin + cjk, 1) > 0.3) return false;
    // 占位符掏空之后没剩什么实义内容
    if (latin + cjk < 4) return false;

    if (opts.skipUI) {
      const words = text.split(/\s+/).filter(Boolean).length;
      // 导航栏里不会有正文，长短都跳过。Google 那条
      // "AI Mode All Images Videos News Forums Shopping More Tools" 有 9 个词，
      // 只按词数卡是拦不住的。
      if (inNav(nodes[0])) return false;
      // 页眉页脚可能夹带正文，只跳其中的短标签
      if (words < 5 && inChrome(nodes[0])) return false;
      // 纯链接标签：游程里没有一个裸文本节点，内容全在链接/按钮里，且只有一两个词。
      // Wikipedia 每个小节标题后面的 [edit] 就是这种，不挡住会在每个标题下
      // 挂一个「编辑」。这是结构判据，不针对具体站点。
      if (words <= 2 && isPureControl(nodes)) return false;
      // 纯锚点链接（href="#..."）永远是界面：跳转链接、返回顶部、章节编辑。
      // 这类不受 2 词限制，"Skip to main content" 也要挡掉。
      if (words <= 6 && isPureControl(nodes) && isFragmentOnly(nodes)) return false;

      // 用户名、@handle、域名、"863 posts" 这类计数，翻了没意义
      if (HANDLE_RE.test(text) || DOMAINISH_RE.test(text) || COUNTISH_RE.test(text)) return false;

      // 短的非句子片段只在标题位置才翻。Wikipedia 的 <h2>History</h2> 要翻，
      // 信息流里的 "Bluesky"、"Pinned"、"Reposted by X" 不翻 —— 否则每条
      // 推文的用户名下面都挂一句译文，整个时间线会被糊满。
      if (words < 4 && !SENTENCE_END_RE.test(text) && text.length < 30 && !isHeadingish(nodes[0])) {
        return false;
      }
    }
    return true;
  }

  function isFragmentOnly(nodes) {
    const links = [];
    for (const n of nodes) {
      if (!isEl(n)) continue;
      if (n.tagName === 'A') links.push(n);
      try { links.push(...n.querySelectorAll('a')); } catch { /* 忽略 */ }
    }
    if (!links.length) return false;
    return links.every((a) => (a.getAttribute('href') || '').startsWith('#'));
  }

  /** 后面紧跟着（可能隔着空白）另一个 <br> 就算分段。 */
  function isDoubleBreak(br) {
    let n = br.nextSibling;
    while (n && isText(n) && !n.nodeValue.trim()) n = n.nextSibling;
    return !!(n && isEl(n) && n.tagName === 'BR');
  }

  function isPureControl(nodes) {
    if (nodes.some((n) => isText(n) && n.nodeValue.trim())) return false;
    return nodes.some((n) => {
      if (!isEl(n)) return false;
      if (n.tagName === 'A' || n.tagName === 'BUTTON') return true;
      try { return !!n.querySelector('a, button, [role="button"]'); } catch { return false; }
    });
  }

  /* ------------------------------------------------------ 单元收集 */

  /**
   * @param {Element} root
   * @param {object} opts { targetIsCJK, skipUI }
   * @returns {Array<{key,text,ph,nodes,anchor}>}
   */
  function alreadyDone(anchor) {
    if (isEl(anchor) && anchor.hasAttribute(MARK)) return true;
    const next = anchor.nextSibling;
    return !!(next && isEl(next) && isOurs(next));
  }

  function collectUnits(root, opts = {}) {
    const o = { targetIsCJK: true, skipUI: true, ...opts };
    const out = [];
    let seq = 0;

    const addUnit = (run) => {
      // 去掉游程两端的纯空白节点，锚点才不会飘
      while (run.length && isText(run[0]) && !run[0].nodeValue.trim()) run.shift();
      while (run.length && isText(run[run.length - 1]) && !run[run.length - 1].nodeValue.trim()) run.pop();
      if (!run.length) return;

      const { text, ph } = extractText(run);
      if (!worthTranslating(text, run, o)) return;

      const anchor = run[run.length - 1];
      // 判重必须看「锚点后面是不是已经跟着我们的译文节点」。
      // 早先用 setAttribute 打标记，但锚点常常是文本节点（<div>纯文本</div>
      // 这种最常见的写法），文本节点没有属性，标记根本打不上 —— SPA 上
      // MutationObserver 一触发重扫就会把同一段反复翻译、反复插入。
      if (alreadyDone(anchor)) return;
      out.push({ key: 'w' + seq++, text, ph, nodes: run.slice(), anchor });
    };

    const walk = (el) => {
      if (shouldSkip(el)) return;

      let run = [];
      const flush = () => { if (run.length) { addUnit(run); run = []; } };

      // 把一批子节点并进当前游程上下文。display:contents 的透明层会递归调用
      // 它自己，这样层里的块级子元素仍然能正常断开游程。
      const consume = (parent) => {
        for (const node of Array.from(parent.childNodes)) {
          if (isText(node)) { run.push(node); continue; }
          if (!isEl(node)) continue;

          // 自己插的译文当作游程边界：不 flush 的话它两侧的文本会被并成
          // 一个「新」单元，绕过判重又翻一遍。
          if (isOurs(node)) { flush(); continue; }

          if (shouldSkip(node)) {
            // 被跳过的行内元素（图标、输入框）不该把段落劈开
            if (!isInline(node)) flush();
            continue;
          }

          if (isTransparent(node)) {
            consume(node);
            if (node.shadowRoot) consume(node.shadowRoot);
            continue;
          }

          if (isInline(node)) {
            // 连续 <br> 是分段（老式 HTML、论坛正文全靠它），必须断开，
            // 否则整页会并成一个巨型单元。单个 <br> 只当空格 —— 有些站点
            // 用它给长句做软换行，在那里断开就又变成「按行打断」了。
            if (node.tagName === 'BR' && isDoubleBreak(node)) flush();
            else run.push(node);
          } else {
            flush();
            walk(node);
          }
        }
      };

      consume(el);
      // 进入 open shadow root。Web Components 的内容不在 childNodes 里，
      // 不下去的话整块看不见。closed 的拿不到，只能放弃。
      if (el.shadowRoot) consume(el.shadowRoot);
      flush();
    };

    walk(root);
    return out;
  }

  /* ---------------------------------------------------------- 插入 */

  /**
   * 用 <span> 而不是 <div>：<div> 塞进 <p> 里是非法嵌套，浏览器会把 <p> 截断。
   * span 在任何允许行内内容的地方都合法，靠 CSS display:block 表现成块。
   */
  function insert(unit, translated, opts = {}) {
    const text = restore(translated, unit.ph);
    const anchor = unit.anchor;
    if (!anchor || !anchor.parentNode) return null;

    let el = unit.el;
    if (!el || !el.parentNode) {
      el = document.createElement('span');
      el.className = OURS;
      el.setAttribute('data-pbx-tr', '1');
      anchor.parentNode.insertBefore(el, anchor.nextSibling);
      unit.el = el;
      if (isEl(anchor)) anchor.setAttribute(MARK, '1');
    }

    el.textContent = text;
    el.classList.remove('pbx-pending', 'pbx-error');
    if (opts.mode === 'translated') hideOriginals(unit, true);
    return el;
  }

  function placeholder(unit) {
    const anchor = unit.anchor;
    if (!anchor || !anchor.parentNode) return null;
    const el = document.createElement('span');
    el.className = OURS + ' pbx-pending';
    el.setAttribute('data-pbx-tr', '1');
    el.textContent = ' ';
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    unit.el = el;
    if (isEl(anchor)) anchor.setAttribute(MARK, '1');
    return el;
  }

  function fail(unit, message) {
    const el = unit.el || placeholder(unit);
    if (!el) return;
    el.classList.remove('pbx-pending');
    el.classList.add('pbx-error');
    el.textContent = message;
  }

  function hideOriginals(unit, hide) {
    for (const n of unit.nodes) {
      if (isEl(n)) n.classList.toggle('pbx-hidden', hide);
      else if (isText(n) && n.parentElement && unit.nodes.length === 1) {
        n.parentElement.classList.toggle('pbx-hidden-text', hide);
      }
    }
  }

  function revert(root = document) {
    const sweep = (r) => {
      r.querySelectorAll('.' + OURS).forEach((el) => el.remove());
      r.querySelectorAll('[' + MARK + ']').forEach((el) => el.removeAttribute(MARK));
      r.querySelectorAll('.pbx-hidden').forEach((el) => el.classList.remove('pbx-hidden'));
      r.querySelectorAll('.pbx-hidden-text').forEach((el) => el.classList.remove('pbx-hidden-text'));
      // 译文可能插在 shadow root 里，还原时也得进去扫
      r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) sweep(el.shadowRoot); });
    };
    sweep(root);
  }

  return {
    collectUnits, extractText, restore, insert, placeholder, fail, revert,
    hideOriginals, worthTranslating,
    _internals: { isInline, shouldSkip, isAtomic, nearestBlock, PH_OPEN, PH_CLOSE },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PBXBlocks;
