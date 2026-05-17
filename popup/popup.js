/**
 * 工具栏弹窗逻辑
 */
const statusEl = document.getElementById('status');
const btnPageTranslate = document.getElementById('btn-page-translate');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const openOptionsEl = document.getElementById('open-options');

let pageTranslated = false;

/** 更新按钮状态 */
function updateButton() {
  btnPageTranslate.textContent = pageTranslated ? '显示原文' : '翻译整页';
}

/** 查询当前页面翻译状态 */
async function refreshState() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    pageTranslated = resp && resp.isPageTranslated;
  } catch (e) {
    pageTranslated = false;
  }
  updateButton();
  statusEl.textContent = pageTranslated ? '已翻译' : '就绪';
}

/** 触发整页翻译/恢复原文 */
btnPageTranslate.addEventListener('click', async () => {
  chrome.storage.sync.set({
    sourceLang: sourceLangEl.value,
    targetLang: targetLangEl.value
  });

  statusEl.textContent = pageTranslated ? '恢复原文...' : '翻译中...';

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'TRIGGER_PAGE_TRANSLATE' });
    if (resp && resp.success) {
      pageTranslated = !pageTranslated;
      updateButton();
      statusEl.textContent = pageTranslated ? '已翻译' : '已恢复原文';
    } else if (resp && resp.error) {
      statusEl.textContent = resp.error;
    }
  } catch (e) {
    statusEl.textContent = '请刷新页面后重试';
  }
});

sourceLangEl.addEventListener('change', () => {
  chrome.storage.sync.set({ sourceLang: sourceLangEl.value });
});

targetLangEl.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: targetLangEl.value });
});

openOptionsEl.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// 初始化
chrome.storage.sync.get({ sourceLang: '', targetLang: 'zh-CN' }, (config) => {
  sourceLangEl.value = config.sourceLang || '';
  targetLangEl.value = config.targetLang || 'zh-CN';
});
refreshState();
