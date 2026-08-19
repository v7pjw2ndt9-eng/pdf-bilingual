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
  const CHROME_SEL = 'nav, header, footer, aside, [role="navigation"], [role="banner"], ' +
                     '[role="contentinfo"], [role="search"], [role="menu"], [role="tablist"], ' +
                     'button, [role="button"], .nav, .navbar, .menu, .breadcrumb, .pagination';

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

  // 已知的块级标签。有了这张表，绝大多数元素都不必碰 getComputedStyle ——
  // Wikipedia 这类上万节点的页面上，逐元素取计算样式会让扫描卡死好几秒。
  const BLOCK = new Set([
    'DIV', 'P', 'LI', 'UL', 'OL', 'DL', 'DD', 'DT', 'TABLE', 'THEAD', 'TBODY', 'TFOOT',
    'TR', 'TD', 'TH', 'CAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
    'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'FIGURE',
    'FIGCAPTION', 'FORM', 'FIELDSET', 'LEGEND', 'DETAILS', 'SUMMARY', 'ADDRESS',
    'HGROUP', 'BODY', 'HTML', 'CENTER', 'MENU', 'DIR',
  ]);

  const dispCache = new WeakMap();

  function isInline(el) {
    const t = el.tagName;
    if (INLINE.has(t)) return true;
    if (BLOCK.has(t)) return false;
    // 只有自定义元素、未知标签才需要真去问浏览器
    if (dispCache.has(el)) return dispCache.get(el);
    let inline = false;
    try {
      const d = getComputedStyle(el).display;
      inline = d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'ruby';
    } catch { inline = false; }
    dispCache.set(el, inline);
    return inline;
  }

  /**
   * checkVisibility 是原生实现，比取整份计算样式快一个量级，
   * 而且一次就把 display:none、visibility、opacity:0、content-visibility 都覆盖了。
   */
  function isHidden(el) {
    if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return true;
    if (typeof el.checkVisibility === 'function') {
      return !el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
    }
    try {
      const st = getComputedStyle(el);
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

    const visit = (n) => {
      if (isText(n)) { s += n.nodeValue; return; }
      if (!isEl(n)) return;
      if (n.tagName === 'BR') { s += ' '; return; }
      if (isOurs(n)) return;
      if (isAtomic(n)) {
        const t = n.textContent.trim();
        if (t) { ph.push(t); s += PH_OPEN + ph.length + PH_CLOSE; }
        return;
      }
      if (shouldSkip(n)) return;
      for (const c of n.childNodes) visit(c);
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
  const LATIN = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

  function nearestBlock(node) {
    let el = isEl(node) ? node : node.parentElement;
    while (el && isInline(el)) el = el.parentElement;
    return el;
  }

  const chromeCache = new WeakMap();
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
      // 导航/页眉页脚/按钮里的短标签是界面文字，翻了满屏噪音
      if (words < 5 && inChrome(nodes[0])) return false;
      // 纯链接标签：游程里没有一个裸文本节点，内容全在链接/按钮里，且只有一两个词。
      // Wikipedia 每个小节标题后面的 [edit] 就是这种，不挡住会在每个标题下
      // 挂一个「编辑」。这是结构判据，不针对具体站点。
      if (words <= 2 && isPureControl(nodes)) return false;
      // 纯锚点链接（href="#..."）永远是界面：跳转链接、返回顶部、章节编辑。
      // 这类不受 2 词限制，"Skip to main content" 也要挡掉。
      if (words <= 6 && isPureControl(nodes) && isFragmentOnly(nodes)) return false;
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

      for (const node of Array.from(el.childNodes)) {
        if (isText(node)) {
          run.push(node);
        } else if (isEl(node)) {
          // 自己插的译文当作游程边界：不 flush 的话它两侧的文本会被并成
          // 一个「新」单元，绕过判重又翻一遍。
          if (isOurs(node)) { flush(); continue; }
          if (shouldSkip(node)) {
            // 被跳过的行内元素（图标、输入框）不该把段落劈开
            if (!isInline(node)) flush();
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
      }
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
    root.querySelectorAll('.' + OURS).forEach((el) => el.remove());
    root.querySelectorAll('[' + MARK + ']').forEach((el) => el.removeAttribute(MARK));
    root.querySelectorAll('.pbx-hidden').forEach((el) => el.classList.remove('pbx-hidden'));
    root.querySelectorAll('.pbx-hidden-text').forEach((el) => el.classList.remove('pbx-hidden-text'));
  }

  return {
    collectUnits, extractText, restore, insert, placeholder, fail, revert,
    hideOriginals, worthTranslating,
    _internals: { isInline, shouldSkip, isAtomic, nearestBlock, PH_OPEN, PH_CLOSE },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PBXBlocks;
