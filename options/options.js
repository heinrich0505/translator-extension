/**
 * 设置页面逻辑
 */

const defaults = {
  provider: 'google',
  apiKey: '',
  apiEndpoint: '',
  modelName: 'gpt-3.5-turbo',
  ltEndpoint: 'https://libretranslate.com',
  sourceLang: '',
  targetLang: 'zh-CN',
  enableSelection: true,
  enablePageTranslate: true,
  selectionDelay: 300,
  stylePreset: 'general',
  customPrompt: ''
};

// DOM 元素
const els = {
  provider: document.getElementById('provider'),
  apiKey: document.getElementById('apiKey'),
  apiKeyGroup: document.getElementById('api-key-group'),
  apiHint: document.getElementById('api-hint'),
  toggleKey: document.getElementById('toggle-key'),
  openaiConfig: document.getElementById('openai-config'),
  apiEndpoint: document.getElementById('apiEndpoint'),
  modelName: document.getElementById('modelName'),
  ltConfig: document.getElementById('libretranslate-config'),
  ltEndpoint: document.getElementById('ltEndpoint'),
  sourceLang: document.getElementById('sourceLang'),
  targetLang: document.getElementById('targetLang'),
  enableSelection: document.getElementById('enableSelection'),
  enablePageTranslate: document.getElementById('enablePageTranslate'),
  selectionDelay: document.getElementById('selectionDelay'),
  delayValue: document.getElementById('delay-value'),
  styleCard: document.getElementById('style-card'),
  stylePreset: document.getElementById('stylePreset'),
  customPromptGroup: document.getElementById('custom-prompt-group'),
  customPrompt: document.getElementById('customPrompt'),
  status: document.getElementById('status')
};

/** 根据选择的服务显示对应配置项 */
function updateProviderUI() {
  const provider = els.provider.value;

  // API Key 区域
  const needKey = ['deepl', 'openai', 'microsoft', 'libretranslate'];
  els.apiKeyGroup.style.display = needKey.includes(provider) ? 'block' : 'none';

  // OpenAI 兼容配置
  els.openaiConfig.style.display = provider === 'openai' ? 'block' : 'none';

  // LibreTranslate 实例地址
  els.ltConfig.style.display = provider === 'libretranslate' ? 'block' : 'none';

  // AI 翻译风格卡片（仅 OpenAI 引擎可见）
  els.styleCard.style.display = provider === 'openai' ? 'block' : 'none';

  // 提示信息
  const hints = {
    deepl: '免费版 Key 以 :fx 结尾，Pro 版 Key 不需要',
    openai: '支持任何 OpenAI 兼容接口（DeepSeek/通义千问/智谱等）',
    microsoft: '在 Azure Portal 创建 Translator 资源获取 Key',
    libretranslate: '可选，不填则使用无 Key 模式（请求频率受限）'
  };
  els.apiHint.textContent = hints[provider] || '';
}

/** 预设切换时显示/隐藏自定义输入框 */
function updateStyleUI() {
  els.customPromptGroup.style.display = els.stylePreset.value === 'custom' ? 'block' : 'none';
}

/** 读取所有配置值 */
function getConfig() {
  return {
    provider: els.provider.value,
    apiKey: els.apiKey.value.trim(),
    apiEndpoint: els.provider.value === 'libretranslate'
      ? els.ltEndpoint.value.trim()
      : els.apiEndpoint.value.trim(),
    modelName: els.modelName.value.trim() || 'gpt-3.5-turbo',
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    enableSelection: els.enableSelection.checked,
    enablePageTranslate: els.enablePageTranslate.checked,
    selectionDelay: parseInt(els.selectionDelay.value),
    stylePreset: els.stylePreset.value,
    customPrompt: els.customPrompt.value.trim()
  };
}

/** 保存设置 */
function saveSettings() {
  chrome.storage.sync.set(getConfig(), () => {
    els.status.textContent = '已保存';
    els.status.style.opacity = '1';
    setTimeout(() => { els.status.style.opacity = '0'; }, 1500);
  });
}

/** 加载设置 */
function loadSettings() {
  chrome.storage.sync.get(defaults, (config) => {
    els.provider.value = config.provider || 'google';
    els.apiKey.value = config.apiKey || '';
    els.apiEndpoint.value = config.apiEndpoint || '';
    els.modelName.value = config.modelName || 'gpt-3.5-turbo';
    els.ltEndpoint.value = config.apiEndpoint || 'https://libretranslate.com';
    els.sourceLang.value = config.sourceLang || '';
    els.targetLang.value = config.targetLang || 'zh-CN';
    els.enableSelection.checked = config.enableSelection !== false;
    els.enablePageTranslate.checked = config.enablePageTranslate !== false;
    els.selectionDelay.value = config.selectionDelay || 300;
    els.delayValue.textContent = (config.selectionDelay || 300) + 'ms';
    els.stylePreset.value = config.stylePreset || 'general';
    els.customPrompt.value = config.customPrompt || '';
    updateProviderUI();
    updateStyleUI();
  });
}

// 事件绑定
els.provider.addEventListener('change', () => { updateProviderUI(); saveSettings(); });
els.apiKey.addEventListener('input', saveSettings);
els.apiEndpoint.addEventListener('input', saveSettings);
els.modelName.addEventListener('input', saveSettings);
els.ltEndpoint.addEventListener('input', saveSettings);
els.sourceLang.addEventListener('change', saveSettings);
els.targetLang.addEventListener('change', saveSettings);
els.enableSelection.addEventListener('change', saveSettings);
els.enablePageTranslate.addEventListener('change', saveSettings);
els.selectionDelay.addEventListener('input', () => {
  els.delayValue.textContent = els.selectionDelay.value + 'ms';
  saveSettings();
});
els.toggleKey.addEventListener('click', () => {
  const isPass = els.apiKey.type === 'password';
  els.apiKey.type = isPass ? 'text' : 'password';
  els.toggleKey.textContent = isPass ? '🙈' : '👁';
});
els.stylePreset.addEventListener('change', () => { updateStyleUI(); saveSettings(); });
els.customPrompt.addEventListener('input', saveSettings);

// 初始化
loadSettings();
