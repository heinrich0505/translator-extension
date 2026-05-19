/**
 * 后台 Service Worker
 * 负责：消息路由、配置读取、翻译调度、LRU 缓存
 */

importScripts('../utils/translators.js');

// LRU 缓存：最近 500 条翻译结果
const MAX_CACHE = 500;
const cache = new Map();

/** 缓存 key 生成 */
function cacheKey(text, targetLang, sourceLang, provider) {
  return `${provider}:${sourceLang}:${targetLang}:${text.substring(0, 200)}`;
}

/** 加入缓存，超过上限则淘汰最旧的 */
function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, value);
}

/** 读取用户配置 */
async function getConfig() {
  const defaults = {
    provider: 'google',
    apiKey: '',
    apiEndpoint: '',
    modelName: 'gpt-3.5-turbo',
    sourceLang: '',
    targetLang: 'zh-CN',
    stylePreset: 'general',
    customPrompt: ''
  };
  try {
    const result = await chrome.storage.sync.get(defaults);
    return { ...defaults, ...result };
  } catch (e) {
    return defaults;
  }
}

/** 处理翻译请求 */
async function handleTranslate(request) {
  const { text, sourceLang: reqSource, targetLang: reqTarget } = request;
  const config = await getConfig();

  const sourceLang = reqSource || config.sourceLang || '';
  const targetLang = reqTarget || config.targetLang || 'zh-CN';

  // 检查缓存
  const key = cacheKey(text, targetLang, sourceLang, config.provider);
  const cached = cache.get(key);
  if (cached) {
    return { ...cached, cached: true };
  }

  // 调用翻译器
  const result = await Translators.translate(text, targetLang, sourceLang, config);

  // 入缓存
  cacheSet(key, result);

  return { ...result, cached: false };
}

/** 向当前 tab 的 content script 转发消息 */
async function sendToCurrentTab(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { error: '未找到打开的标签页' };
  }
  // 无法注入 content script 的页面（chrome:// 等）
  if (tab.url && !tab.url.startsWith('http')) {
    return { error: '请在普通网页上使用此功能' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return { success: true };
  } catch (e) {
    return { error: '请刷新页面后重试（Content Script 未就绪）' };
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TRANSLATE') {
    handleTranslate(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'GET_CONFIG') {
    getConfig().then(sendResponse);
    return true;
  }

  // popup 触发整页翻译：转发到 content script
  if (request.type === 'TRIGGER_PAGE_TRANSLATE') {
    sendToCurrentTab({ type: 'TOGGLE_PAGE_TRANSLATE' }).then(sendResponse);
    return true;
  }

  // popup 查询翻译状态
  if (request.type === 'GET_STATE') {
    sendToCurrentTab({ type: 'GET_STATE' }).then(resp => {
      sendResponse(resp || { isPageTranslated: false });
    });
    return true;
  }
});

// 快捷键监听：切换整页翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-page-translate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PAGE_TRANSLATE' });
    }
  }
});
