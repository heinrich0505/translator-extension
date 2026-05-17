/**
 * Content Script 主入口
 * - 划词翻译：选中文本 → 弹出双语翻译面板
 * - 整页翻译：接收后台快捷键 → 遍历 DOM 批量翻译注入
 */

(() => {
  const popup = new Translators.TranslatePopup();
  const pageTranslator = new Translators.PageTranslator();
  let selectionTimer = null;

  /** 获取当前页面语言设置 */
  async function getTargetLang() {
    try {
      const config = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
      return (config && config.targetLang) || 'zh-CN';
    } catch (e) {
      return 'zh-CN';
    }
  }

  /** 处理文本选择 */
  function handleSelection(e) {
    // 忽略弹出面板内部的点击
    if (popup.isVisible()) return;

    clearTimeout(selectionTimer);

    selectionTimer = setTimeout(async () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text || text.length < 2 || text.length > 5000) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      const targetLang = await getTargetLang();
      popup.show(text, rect, targetLang);
    }, 300);
  }

  /** 全局点击处理：点击面板外关闭 */
  function handleClickOutside(e) {
    if (!popup.isVisible()) return;
    // 检查是否点击在弹出面板内
    const host = document.getElementById('tr-popup-host');
    if (host && host.shadowRoot) {
      const panel = host.shadowRoot.getElementById('tr-panel');
      if (panel && !panel.contains(e.target) && !host.contains(e.target)) {
        popup.hide();
      }
    }
  }

  /** 键盘处理 */
  function handleKeyDown(e) {
    // Esc 关闭弹窗
    if (e.key === 'Escape' && popup.isVisible()) {
      popup.hide();
      return;
    }
  }

  /** 切换整页翻译 */
  async function togglePageTranslation() {
    const targetLang = await getTargetLang();
    pageTranslator.translatePage(targetLang);
  }

  // ===== 事件监听 =====
  document.addEventListener('mouseup', handleSelection);
  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleKeyDown);

  // ===== 后台消息监听 =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'TOGGLE_PAGE_TRANSLATE') {
      togglePageTranslation();
      sendResponse({ success: true, isPageTranslated: pageTranslator.isActive });
    }
    if (request.type === 'GET_STATE') {
      sendResponse({ isPageTranslated: pageTranslator.isActive });
    }
    return true;
  });

  console.log('[双语翻译助手] 已加载');
})();
