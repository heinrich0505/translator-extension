/**
 * 整页双语翻译模块
 * 渐进式体验：先注入加载占位 → 逐批翻译 → 实时替换为译文
 * 自动跳过代码、样式、LaTeX 公式等
 */

class PageTranslator {
  constructor() {
    this.isActive = false;
    this._placeholderMap = new Map();
    this._placeholderIdx = 0;
    this._translatedCount = 0;
    this._totalCount = 0;
    this._aborted = false;
    this._progressBadge = null;
    this._observer = null;
    this._observerDebounce = null;
    this._translateCache = new Map();
    this._runId = 0;
    this._batchInProgress = false;
  }

  /** 触发整页翻译 */
  async translatePage(targetLang) {
    if (this.isActive) {
      this.removeTranslations();
      return;
    }

    this.isActive = true;
    this._aborted = false;
    this._runId++;
    const runId = this._runId;
    this._translatedCount = 0;
    this._placeholderMap.clear();
    this._placeholderIdx = 0;

    // Step 1: 提取段落
    this._showProgress('正在分析页面内容...');
    const segments = this._extractSegments();
    this._totalCount = segments.length;

    if (segments.length === 0) {
      this._showProgress('未找到可翻译的文本内容', true);
      this.isActive = false;
      return;
    }
    // Step 2: 过滤不可翻译内容（标签/指标/代码）
    const filtered = segments.filter(s => this._isContentText(s.text));
    console.log(`[翻译] 提取 ${segments.length} 段，过滤后 ${filtered.length} 段`);
    this._totalCount = filtered.length;


    if (filtered.length === 0) {
      this._showProgress('未找到可翻译的文本内容', true);
      this.isActive = false;
      return;
    }

    // Step 3: 为有效段落注入加载占位符
    const placeholders = this._insertPlaceholders(filtered);
    this._createProgressBadge();

    const target = targetLang || 'zh-CN';
    
    const BATCH_SIZE = Math.max(20, Math.min(30, Math.ceil(filtered.length / 10)));
    const CONCURRENCY = 3;

    // Step 3: 用并发池处理批次（3 路并发，每批 20-30 段）
    this._batchInProgress = true;
    try {
      await this._processBatchesConcurrently(filtered, placeholders, target, runId, BATCH_SIZE, CONCURRENCY);
    } finally {
      this._batchInProgress = false;
    }

    // 清理
    this._removeProgressBadge();
    this._placeholderMap.clear();
    this._placeholderIdx = 0;

    // 初始翻译完成后启动 Observer
    this.startObserver(target);

    if (this._translatedCount > 0) {
      this._showProgress(
        `翻译完成，共 ${this._translatedCount} 段（按 Alt+T 可移除）`,
        true
      );
    }
  }

  /**
   * 并发池处理翻译批次
   * CONCURRENCY 个 Worker 从队列取批次，并行发送请求
   */
  async _processBatchesConcurrently(segments, placeholders, targetLang, runId, BATCH_SIZE, CONCURRENCY) {
    const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

    // 构建批次队列
    const batches = [];
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      batches.push({
        index: i,
        segs: segments.slice(i, i + BATCH_SIZE),
        phs: placeholders.slice(i, i + BATCH_SIZE)
      });
    }

    // 处理单个批次
    const processOne = async (batch) => {
      // 更新占位符为"翻译中..."
      for (const p of batch.phs) {
        const el = document.getElementById(p.id);
        if (el) el.classList.add('tr-translating');
      }
      try {
        const batchText = batch.segs.map(s => s.text).join('|||');

        let result;
        const cached = this._translateCache.get(batchText);
        if (cached !== undefined) {
          result = { translated: cached };
        } else {
          result = await chrome.runtime.sendMessage({
            type: 'TRANSLATE',
            text: batchText,
            targetLang: targetLang
          });
        }

        if (this._aborted || this._runId !== runId) return;

        if (result.error) {
          for (const p of batch.phs) {
            const el = document.getElementById(p.id);
            if (el) { el.className = 'tr-error-badge'; el.textContent = '⚠ ' + result.error; }
          }
        } else {
          if (cached === undefined) {
            this._translateCache.set(batchText, result.translated);
          }
          let chunks = (result.translated || '').split('|||').map(c => c.trim());
          if (chunks.length !== batch.segs.length) {
            chunks = Translators._splitNumberedResult(result.translated || '', batch.segs.length);
          }
          for (let j = 0; j < batch.segs.length; j++) {
            const chunk = chunks[j] || '';
            this._replacePlaceholder(batch.phs[j].id, chunk, batch.segs[j].element);
            this._translatedCount++;
          }
        }

      } catch (e) {
        for (const p of batch.phs) {
          const el = document.getElementById(p.id);
          if (el) { el.className = 'tr-error-badge'; el.textContent = '⚠ ' + e.message; }
        }
      }

      this._updateProgressBadge();
    };

    // 并发池：CONCURRENCY 个 Worker 抢队列
    let batchIdx = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, batches.length) },
      async () => {
        while (batchIdx < batches.length && !this._aborted) {
          const batch = batches[batchIdx++];
          await processOne(batch);
        }
      }
    );

    await Promise.all(workers);
  }

  /**
   * 判断文本是否为有意义的可翻译内容
   * 只跳过明确的非自然语言：纯符号/代码/标识符/极短文本
   */
  _isContentText(text) {
    if (!text || text.length < 4) return false;

    // 纯数字/指标/符号（如 "~27k", "2.1×", "+5 pp"）
    if (/^[\d\s,.%×±≈~+‑−–—/:;()\[\]{}<>^@#$&*!'"?|\\]{1,30}$/.test(text)) return false;

    // camelCase 标识符（如 "isActive", "translatePage"）
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(text)) return false;

    // snake_case / kebab-case 标识符
    if (/^[a-z0-9]+[_\-][a-z0-9]+([_\-][a-z0-9]+)*$/i.test(text)) return false;

    // 点分隔的技术标识符（如 "debug.enabled"），不匹配 ·•（自然语言列举）
    if (/^[\w._-]+(\s*\.\s*[\w._-]+)+$/.test(text)) return false;

    // 纯大写缩写 2-3 字符（如 "LSP", "DAP", "API"，不误杀 "DOCS" "URLS" 等导航标签）
    if (/^[A-Z]{2,3}$/.test(text)) return false;


    return true;
  }

  
  /** 移除已注入的译文 */
  removeTranslations() {
    this._aborted = true;
    this.isActive = false;
    this.stopObserver();
    // 移除注入的元素
    document.querySelectorAll('[data-translator]').forEach(el => el.remove());
    // 清除已翻译标记，允许再次翻译
    document.querySelectorAll('[data-translated]').forEach(el => el.removeAttribute('data-translated'));
    this._removeProgressBadge();
    this._translatedCount = 0;
    this._totalCount = 0;
  }

  /* ================================================================
   * 核心：DOM 遍历提取段落
   * ================================================================ */

  _extractSegments() {
    const segments = [];
    const seen = new WeakSet();

    const skipSelector = [
      'script', 'style', 'code', 'pre', 'svg',
      'input', 'textarea', 'noscript', 'math', 'canvas',
      'iframe', 'object', 'embed', 'audio', 'video',
      '[data-translator]', '[data-translated]',
      '.tr-bilingual', '.tr-loading',
      '.tr-progress-badge', '.tr-progress-toast',
      '.pretex-inline', '.pretex-bind', '.pretex',
      '.MathJax', '.katex', '.mjx-container', '.mjx'
    ].join(',');

    const blockTags = new Set([
      'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'LI', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE',
      'DD', 'DT', 'SUMMARY',
      'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER'
    ]);

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (!node || !node.tagName) return NodeFilter.FILTER_REJECT;
          if (node.matches && node.matches(skipSelector)) return NodeFilter.FILTER_REJECT;
          // 跳过 nav 容器本身（其子链接会被单独提取）
          if (node.tagName === 'NAV') return NodeFilter.FILTER_SKIP;
          // 允许 nav/header 内的 <a> 链接作为独立翻译段
          if (node.tagName === 'A' && node.closest && node.closest('nav, header')) {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          if (!blockTags.has(node.tagName)) return NodeFilter.FILTER_SKIP;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (seen.has(el)) continue;
      if (el.closest && el.closest(skipSelector)) continue;

      const text = this._getMeaningfulText(el);
      if (!text || text.length < 2) continue;
      if (/^[\s\d\p{P}]+$/u.test(text)) continue;

      const innerBlock = this._findInnerBlockWithSameText(el, text, seen);
      if (innerBlock) {
        seen.add(el);
        continue;
      }

      seen.add(el);

      const { cleanText } = this._protectLatex(text);
      // 去掉所有公式占位符后若没有文字，说明是纯公式元素（如展示矩阵），跳过不翻译
      const pureText = cleanText.replace(/\s*\{LX\d+\}\s*/g, '').trim();
      if (pureText.length < 2) continue;

      segments.push({ element: el, text: cleanText.trim() });
    }

    // 去重：如果 A 包含 B 且文本高度重叠，保留 B（更细粒度）
    return this._dedupSegments(segments);
  }
  /**
   * 去重：移除包含其他段落的祖先元素
   * 例如 <div> 包裹 <p>，两者的 innerText 重叠 → 保留 <p>
   */
  _dedupSegments(segments) {
    const segmentMap = new Map(segments.map(s => [s.element, s]));
    const elementSet = new Set(segments.map(s => s.element));

    return segments.filter(seg => {
      // 跳过 nav/header 容器（其子链接已被单独提取翻译）
      if (seg.element.tagName === 'NAV' || seg.element.tagName === 'HEADER') {
        const hasTranslatableChildren = segments.some(s =>
          s.element !== seg.element && seg.element.contains(s.element));
        if (hasTranslatableChildren) return false;
      }

      for (const other of elementSet) {
        if (other === seg.element) continue;
        if (seg.element.contains(other) && this._textsOverlap(seg.text, segmentMap.get(other)?.text || '')) {
          return false; // 是祖先，且文本重叠 → 移除
        }
      }
      if (this._isAggregateContainer(seg, segments, segmentMap)) {
        return false;
      }
      return true;
    });
  }


  /**
   * 检测元素是否为聚合容器
   * 当父元素包含 ≥3 个子段落，且每个子段落文本都是父文本的子串时，
   * 说明父文本仅仅是子文本的拼接，父元素并非独立文本块
   */
  _isAggregateContainer(seg, segments, segmentMap) {
    const children = segments.filter(s =>
      s.element !== seg.element && seg.element.contains(s.element));
    if (children.length < 3) return false;

    let matched = 0;
    for (const child of children) {
      const childText = child.text;
      if (childText.length >= 2 && seg.text.includes(childText)) {
        matched++;
      }
    }
    return matched >= 3;
  }
  /** 判断两段文本是否有重叠（简化：子串匹配或 80%+ 相似度） */
  _textsOverlap(parentText, childText) {
    if (!parentText || !childText) return false;
    // 子串包含关系：仅当子文本占父文本 60%+ 才视为重叠，避免 "yours" ⊂ "but this one is yours." 误删父级
    if (childText.includes(parentText)) return true;
    if (parentText.includes(childText)) return childText.length > parentText.length * 0.6;
    // 简单 Jaccard 相似度估算
    const parentWords = new Set(parentText.split(/\s+/));
    const childWords = new Set(childText.split(/\s+/));
    if (parentWords.size === 0 || childWords.size === 0) return false;
    const intersection = [...childWords].filter(w => parentWords.has(w)).length;
    const union = new Set([...parentWords, ...childWords]).size;
    return (intersection / union) > 0.7;
  }


  _getMeaningfulText(el) {
    if (el.offsetParent === null && el.tagName !== 'BODY') {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
    }

    const fullText = (el.innerText || el.textContent || '').trim();
    if (fullText.length < 2) return '';

    let directText = '';
    let childElementCount = 0;

    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        directText += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        childElementCount++;
        const tag = node.tagName.toLowerCase();
        if (['strong', 'em', 'b', 'i', 'a', 'sub', 'sup', 'mark', 'small', 'u', 's', 'span', 'font'].includes(tag)) {
          if (this._hasLatex(node)) {
            // DOM 渲染型公式 → 占位符，存 textContent（公式文字），原件 SVG 依旧可见
            directText += this._getLatexPlaceholder(node);
          } else {
            directText += node.textContent || '';
          }
        } else if (node.matches && node.matches('svg, [class*="pretex"], [class*="MathJax"], [class*="katex"], [class*="mjx"]')) {
          // DOM 渲染型公式 → 占位符
          directText += this._getLatexPlaceholder(node);
        }
      }
    }

    directText = directText.trim();

    if (directText.length < 2 && fullText.length >= 2 && childElementCount > 0) {
      const complexChildren = el.querySelectorAll(
        'h1, h2, h3, h4, h5, h6, ul, ol, table, img, svg, iframe, pre, code'
      );
      if (complexChildren.length === 0) {
        return fullText;
      }
      return '';
    }

    return directText;
  }

  _findInnerBlockWithSameText(el, text, seen) {
    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DIV'];
    for (const tag of blockTags) {
      const inner = el.querySelector(tag);
      if (inner && !seen.has(inner)) {
        const innerText = (inner.innerText || inner.textContent || '').trim();
        if (innerText === text) return inner;
      }
    }
    return null;
  }

  /* ================================================================
   * LaTeX 公式保护
   * ================================================================ */

  _nextLatexId() {
    // {LX0} 格式：花括号是标准 i18n 占位符，LX 不是可识别单词，
    // 翻译引擎（Google/MyMemory）不会拆散或改写它
    return `{LX${this._placeholderIdx++}}`;
  }

  _protectLatex(text) {
    const placeholders = new Map();
    let result = text;

    // $$...$$ 展示公式 → 占位符
    result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match) => {
      const id = this._nextLatexId();
      placeholders.set(id, match);
      return id;
    });

    // $...$ 行内公式
    result = result.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match) => {
      const id = this._nextLatexId();
      placeholders.set(id, match);
      return id;
    });

    // \(...\) 行内公式
    result = result.replace(/\\\(([\s\S]*?)\\\)/g, (match) => {
      const id = this._nextLatexId();
      placeholders.set(id, match);
      return id;
    });

    // \[...\] 展示公式
    result = result.replace(/\\\[([\s\S]*?)\\\]/g, (match) => {
      const id = this._nextLatexId();
      placeholders.set(id, match);
      return id;
    });

    for (const [k, v] of placeholders) {
      this._placeholderMap.set(k, v);
    }
    return { cleanText: result };
  }

  _restoreLatex(text) {
    // 先对翻译结果做 HTML 转义，避免译者返回的 < > & 被解释为标签
    let result = Translators.escapeHtml(text);
    // 恢复占位符：文本公式为 LaTeX 源码，DOM 公式为 outerHTML
    for (const [id, original] of this._placeholderMap) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp('\\s*' + escaped + '\\s*', 'g'), original || '');
    }
    // 清理残留（不在 map 中的占位符，新旧格式兼顾）
    result = result.replace(/\s*\{LX\d+\}\s*/g, '');
    result = result.replace(/\s*__LATEX_\d+__\s*/g, '');
    return result;
  }

  /** 去除 HTML 标签，用于与原文 innerText 做相等比较 */
  _stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || div.textContent || '').trim();
  }

  _hasLatex(el) {
    const className = el.className || '';
    const classStr = typeof className === 'string' ? className : className.baseVal || '';
    if (/MathJax|katex|mjx|pretex/i.test(classStr)) return true;
    if (el.getAttribute && el.getAttribute('type') === 'math/tex') return true;
    return false;
  }

  _getLatexPlaceholder(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // 纯标点符号（逗号、句号等）作为普通文本，不走公式克隆，避免半角标点混入译文
    if (text && /^[\p{P}]+$/u.test(text) && text.length <= 2) return text;
    const id = this._nextLatexId();
    this._placeholderMap.set(id, el.outerHTML || '');
    return id;
  }

  /* ================================================================
   * 渐进式 UI：加载占位 → 逐批翻译 → 替换
   * ================================================================ */

  /**
   * 在每个原文元素内部追加加载占位符
   * 译文注入到元素内部，不改变 DOM 兄弟结构 → 不会破坏页面布局
   */
  _insertPlaceholders(segments) {
    const placeholders = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const id = `tr-ph-${i}-${Date.now()}`;

      const ph = document.createElement('span');
      ph.id = id;
      ph.className = 'tr-loading';
      ph.setAttribute('data-translator', 'placeholder');
      ph.innerHTML = `
        <span class="tr-loading-line tr-loading-line--long"></span>
        <span class="tr-loading-line tr-loading-line--medium"></span>
        <span class="tr-loading-line tr-loading-line--short"></span>
        <span class="tr-loading-hint">翻译中...</span>
      `;

      // flex/grid 容器保护：译文注入的子元素不干扰原有排列
      this._applyLayoutProtection(ph, seg.element);



      // 注入到原文元素内部，不改变同级 DOM 结构
      seg.element.appendChild(ph);
      placeholders.push({ id, element: seg.element });
    }

    return placeholders;
  }

  /**
   * flex/grid 容器保护：根据上下文智能选择 inline 或 block 注入模式
   * - 内联 flex（如导航栏）：译文用 inline + 空格分隔，保持同一行
   * - 块级 flex/grid：译文独占一行，不干扰原有排列
   * - 非 flex/grid：不干预，由 CSS 默认 display:block 控制
   */
  _applyLayoutProtection(el, host) {
    const isFlexGrid = (e) => {
      if (!e) return false;
      const d = getComputedStyle(e).display;
      return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
    };

    // 检测：元素自身或父容器是否为 flex/grid
    const hostIsFlex = isFlexGrid(host);
    const parentIsFlex = host.parentElement && isFlexGrid(host.parentElement);

    if (!hostIsFlex && !parentIsFlex) return; // 非 flex/grid，不干预

    // 判断是否为内联级容器（inline-flex/inline-grid 或导航栏等紧凑型容器）
    const hostDisplay = getComputedStyle(host).display || '';
    const parentDisplay = host.parentElement ? getComputedStyle(host.parentElement).display : '';
    const isInlineContext = hostDisplay.startsWith('inline') || parentDisplay.startsWith('inline');

    if (isInlineContext) {
      // 内联上下文（如导航栏）：译文用 inline 模式，保持同行
      // 清除可能冲突的 flex/grid 属性
      el.style.setProperty('display', 'inline', 'important');
      el.style.setProperty('margin-left', '0.5em', 'important');
      el.style.setProperty('vertical-align', 'baseline', 'important');
      el.style.removeProperty('flex');
      el.style.removeProperty('min-width');
      el.style.removeProperty('max-width');
      el.style.removeProperty('grid-column');
    } else {
      // 块级 flex/grid：译文独占一行
      el.style.setProperty('flex', '0 0 100%', 'important');
      el.style.setProperty('min-width', '100%', 'important');
      el.style.setProperty('max-width', '100%', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('grid-column', '1 / -1', 'important');
    }
  }



  /**
   * 替换占位符 → 译文。
   * 对 flex/grid 容器自动应用布局保护，译文独占一行不干扰原始排列。
   */
  _replacePlaceholder(id, translatedText, origElement) {
    const restored = this._restoreLatex(translatedText);

    if (!restored.trim()) {
      const el = document.getElementById(id);
      if (el) el.remove();
      return;
    }
    // 检查是否与原文相同（比较时去除 restored 中的 HTML 标签）
    const origText = (origElement.innerText || origElement.textContent || '').trim();
    if (this._stripHtml(restored) === origText) {
      // 短文本（< 15 字符）即使译后相同也注入，保持视觉流程一致
      // 长文本跳过（确无有效翻译）
      if (origText.length >= 15) {
        const el = document.getElementById(id);
        if (el) el.remove();
        return;
      }
    }

    const transSpan = document.createElement('span');
    transSpan.className = 'tr-bilingual tr-bilingual--done';
    transSpan.setAttribute('data-translator', 'true');
    transSpan.innerHTML = restored.trim();

    // flex/grid 容器保护：根据上下文智能选择 inline/block 模式
    this._applyLayoutProtection(transSpan, origElement);

    // 短文本（< 25字符）在非 flex 上下文中也用 inline 模式，保持视觉紧凑
    // 类似 Immersive Translate 的做法：原文  译文（同行显示）
    const plainText = this._stripHtml(restored);
    if (plainText.length < 25 && origText.length < 40
        && !transSpan.style.getPropertyValue('display')) {
      transSpan.style.setProperty('display', 'inline', 'important');
      transSpan.style.setProperty('margin-left', '0.5em', 'important');
      // 清除可能冲突的 flex/grid 属性
      transSpan.style.removeProperty('flex');
      transSpan.style.removeProperty('min-width');
      transSpan.style.removeProperty('max-width');
      transSpan.style.removeProperty('grid-column');
    }

    const oldEl = document.getElementById(id);
    if (oldEl && oldEl.parentNode) {
      // 不注入 <br>（flex 容器中 br 可能成为多余的 flex 子项）
      // 靠 CSS .tr-bilingual 的 display:block 自然换行
      oldEl.parentNode.insertBefore(transSpan, oldEl);
      oldEl.remove();
    } else {
      // 兜底：直接追加到原文元素末尾
      origElement.appendChild(transSpan);
    }


    origElement.setAttribute('data-translated', 'true');
  }



  /* ================================================================
   * 进度指示
   * ================================================================ */

  _createProgressBadge() {
    this._removeProgressBadge();

    const badge = document.createElement('div');
    badge.className = 'tr-progress-badge';
    badge.setAttribute('data-translator', 'progress');
    badge.innerHTML = `
      <span class="tr-progress-spinner"></span>
      <span class="tr-progress-text">已翻译 <strong>0</strong> / ${this._totalCount} 段</span>
    `;
    document.body.appendChild(badge);
    this._progressBadge = badge;
  }

  _updateProgressBadge() {
    if (!this._progressBadge) return;
    const strong = this._progressBadge.querySelector('strong');
    if (strong) strong.textContent = this._translatedCount;
  }

  _removeProgressBadge() {
    if (this._progressBadge) {
      this._progressBadge.remove();
      this._progressBadge = null;
    }
  }

  _showProgress(msg, autoHide) {
    document.querySelectorAll('.tr-progress-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = 'tr-progress-toast';
    toast.setAttribute('data-translator', 'progress');
    toast.textContent = msg;
    document.body.appendChild(toast);

    if (autoHide) {
      setTimeout(() => {
        const t = document.querySelector('.tr-progress-toast');
        if (t) {
          t.style.opacity = '0';
          setTimeout(() => t.remove(), 400);
        }
      }, 3000);
    }
  }

  /* ================================================================
   * MutationObserver：监听动态加载内容，自动翻译
   * ================================================================ */

  startObserver(targetLang) {
    this.stopObserver();
    this._observer = new MutationObserver(() => {
      clearTimeout(this._observerDebounce);
      this._observerDebounce = setTimeout(() => {
        if (!this.isActive) return;
        this._translateNewContent(targetLang);
      }, 1200);
    });
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  stopObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    clearTimeout(this._observerDebounce);
  }

  async _translateNewContent(targetLang) {
    // 批量翻译进行中时不处理，避免冲突
    if (this._batchInProgress) return;

    // _extractSegments 会自动跳过 [data-translated] 元素
    let segments = this._extractSegments();
    // 过滤：元素本身或其子元素已有翻译的，不重复翻译
    segments = segments.filter(s => {
      if (s.element.querySelector('[data-translated]')) return false;
      if (s.element.querySelector('.tr-bilingual')) return false;
      if (s.element.hasAttribute('data-translated')) return false;
      return true;
    });
    if (segments.length === 0) return;

    try {
      const batchText = segments.map(s => s.text).join('|||');

      // 查缓存
      let result;
      const cached = this._translateCache.get(batchText);
      if (cached !== undefined) {
        result = { translated: cached };
      } else {
        result = await chrome.runtime.sendMessage({
          type: 'TRANSLATE', text: batchText, targetLang
        });
      }

      if (result.error) return;
      if (cached === undefined) {
        this._translateCache.set(batchText, result.translated);
      }

      let chunks = result.translated.split('|||').map(c => c.trim());
      // 当分隔符拆分不匹配时，使用 _splitNumberedResult 兜底
      if (chunks.length !== segments.length) {
        chunks = Translators._splitNumberedResult(result.translated || '', segments.length);
      }
      for (let i = 0; i < Math.min(segments.length, chunks.length); i++) {
        const restored = this._restoreLatex(chunks[i] || '');
        if (!restored.trim()) continue;
        const origText = (segments[i].element.innerText || '').trim();
        if (this._stripHtml(restored) === origText) continue;

        const transSpan = document.createElement('span');
        transSpan.className = 'tr-bilingual tr-bilingual--done';
        transSpan.setAttribute('data-translator', 'observer');
        transSpan.innerHTML = restored.trim();

        const origEl = segments[i].element;

        // flex/grid 容器保护：根据上下文智能选择 inline/block 模式
        this._applyLayoutProtection(transSpan, origEl);

        // 短文本用 inline 模式
        const origTextLen = (origEl.innerText || '').trim().length;
        const plainText = this._stripHtml(restored);
        if (plainText.length < 25 && origTextLen < 40
            && !transSpan.style.getPropertyValue('display')) {
          transSpan.style.setProperty('display', 'inline', 'important');
          transSpan.style.setProperty('margin-left', '0.5em', 'important');
          // 清除可能冲突的 flex/grid 属性
          transSpan.style.removeProperty('flex');
          transSpan.style.removeProperty('min-width');
          transSpan.style.removeProperty('max-width');
          transSpan.style.removeProperty('grid-column');
        }

        origEl.appendChild(transSpan);

        origEl.setAttribute('data-translated', 'true');
      }
    } catch (e) {
      // 静默失败
    }
  }
}

if (typeof Translators !== 'undefined') {
  Translators.PageTranslator = PageTranslator;
}
