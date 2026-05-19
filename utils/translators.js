/**
 * 翻译适配层
 * 统一接口，支持 Google / MyMemory / LibreTranslate / DeepL / OpenAI(兼容) / Microsoft
 * 所有翻译器返回: { translated: string, from: string, to: string }
 */

class Translators {
  /**
   * 根据配置选择翻译器并执行翻译
   */
  static async translate(text, targetLang, sourceLang, config) {
    const provider = config.provider || 'google';

    switch (provider) {
      case 'google':
        try {
          return await Translators.googleTranslate(text, targetLang, sourceLang);
        } catch (e) {
          // Google 不可用时降级到 MyMemory
          console.warn('Google 翻译失败，降级到 MyMemory:', e.message);
          return Translators.mymemoryTranslate(text, targetLang, sourceLang);
        }

      case 'mymemory':
        return Translators.mymemoryTranslate(text, targetLang, sourceLang);

      case 'libretranslate':
        return Translators.libretranslateTranslate(text, targetLang, sourceLang, config);

      case 'deepl':
        return Translators.deeplTranslate(text, targetLang, sourceLang, config.apiKey);

      case 'openai':
        return Translators.openaiTranslate(text, targetLang, sourceLang, config);

      case 'microsoft':
        return Translators.microsoftTranslate(text, targetLang, sourceLang, config.apiKey);

      default:
        // 未知 provider，先尝试 Google，失败则 MyMemory
        try {
          return await Translators.googleTranslate(text, targetLang, sourceLang);
        } catch (e) {
          return Translators.mymemoryTranslate(text, targetLang, sourceLang);
        }
    }
  }

  /* ===== Google Translate（免费） ===== */
  static async googleTranslate(text, targetLang, sourceLang) {
    // 用 ||| 分隔多段文本，直接发送不做换行转换
    // Google 会把 ||| 保留不变，避免换行转换导致的分隔符错乱
    const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({
      client: 'gtx',
      sl: sourceLang || 'auto',
      tl: targetLang,
      dt: 't',
      q: text
    }).toString();

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Google: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || !data[0]) throw new Error('Google: 返回数据为空');

    let translated = '';
    for (const block of data[0]) {
      if (block && block[0]) translated += block[0];
    }

    return {
      translated: translated.trim(),
      from: data[2] || sourceLang || 'auto',
      to: targetLang
    };
  }

  /* ===== MyMemory（免费，无需 API Key，每月 5000 字） ===== */
  static async mymemoryTranslate(text, targetLang, sourceLang) {
    // MyMemory 有长度限制，超长文本分段发送
    const SEP = '|||';
    const maxLen = 4000;
    if (text.length > maxLen) {
      const segments = text.split(SEP);
      const batches = [];
      let batch = '';
      for (const seg of segments) {
        if ((batch + SEP + seg).length > maxLen && batch) {
          batches.push(batch);
          batch = seg;
        } else {
          batch = batch ? batch + SEP + seg : seg;
        }
      }
      if (batch) batches.push(batch);

      const results = [];
      for (const b of batches) {
        const r = await Translators._mymemorySingle(b, targetLang, sourceLang);
        results.push(r.translated);
      }
      return {
        translated: results.join(SEP),
        from: sourceLang || 'auto',
        to: targetLang
      };
    }

    return Translators._mymemorySingle(text, targetLang, sourceLang);
  }

  static async _mymemorySingle(text, targetLang, sourceLang) {
    // MyMemory 要求 langpair 必须是 SOURCE|TARGET 格式，两边都不能为空
    // 也不支持 'auto' 作为源语言代码，源语言未知时默认用 en（大多数网页是英文）
    const src = sourceLang && sourceLang !== 'auto' ? encodeURIComponent(sourceLang) : 'en';
    const langPair = `${src}|${encodeURIComponent(targetLang)}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}&de=someone@example.com`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`MyMemory: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.responseStatus !== 200 && data.responseStatus !== 403) {
      throw new Error(`MyMemory: ${data.responseDetails || '未知错误'}`);
    }

    return {
      translated: data.responseData.translatedText,
      from: data.responseData.match?.source || sourceLang || 'auto',
      to: targetLang
    };
  }

  /* ===== LibreTranslate（免费开源，可自建实例） ===== */
  static async libretranslateTranslate(text, targetLang, sourceLang, config) {
    const baseUrl = config.apiEndpoint || 'https://libretranslate.com';
    const apiKey = config.apiKey || '';

    const body = {
      q: text,
      source: sourceLang || 'auto',
      target: targetLang,
      format: 'text'
    };
    if (apiKey) body.api_key = apiKey;

    const resp = await fetch(baseUrl.replace(/\/$/, '') + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LibreTranslate: HTTP ${resp.status} - ${err}`);
    }

    const data = await resp.json();
    return {
      translated: data.translatedText,
      from: data.detectedLanguage?.language || sourceLang || 'auto',
      to: targetLang
    };
  }

  /* ===== DeepL API ===== */
  static async deeplTranslate(text, targetLang, sourceLang, apiKey) {
    if (!apiKey) throw new Error('请先在设置中填入 DeepL API Key');

    const body = new URLSearchParams();
    body.append('text', text);
    body.append('target_lang', targetLang.toUpperCase());
    if (sourceLang) body.append('source_lang', sourceLang.toUpperCase());

    const isPro = apiKey.endsWith(':fx');
    const baseUrl = isPro
      ? 'https://api.deepl.com/v2/translate'
      : 'https://api-free.deepl.com/v2/translate';

    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`DeepL (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    let translated = data.translations.map(t => t.text).join('|||');
    return {
      translated,
      from: data.translations[0]?.detected_source_language || sourceLang || 'auto',
      to: targetLang
    };
  }

  /* ===== OpenAI 兼容接口 ===== */
  static _getPresetPrompt(preset, sourceHint, targetName) {
    const presets = {
      general: `你是一个专业翻译引擎。请将以下文本${sourceHint}翻译成${targetName}。`,

      academic: `你是一名学术论文翻译专家。请将以下文本${sourceHint}翻译成${targetName}。要求：1. 专业术语翻译准确，符合学术规范 2. 句式严谨，逻辑清晰，保持被动语态 3. 保留原文的学术语气和严谨性。`,

      math: `你是一名数学教材翻译专家。请将以下文本${sourceHint}翻译成${targetName}。要求：1. 数学术语翻译准确（如 basis→基, dimension→维数, span→张成, subspace→子空间, rank→秩, nullity→零度, eigenvalue→特征值, determinant→行列式, linear independence→线性无关, column space→列空间, null space→零空间）2. 保留定理(Theorem)/定义(Definition)/证明(Proof)的严谨语气 3. 公式占位符({LX0})绝对原样保留 4. 数学符号和数字不翻译。`,

      tech: `你是一名技术文档翻译专家。请将以下文本${sourceHint}翻译成${targetName}。要求：1. 技术术语统一且准确 2. 句式简洁明了，避免歧义 3. 代码、变量名、命令行保持原样 4. 遵循中文技术文档习惯。`,

      news: `你是一名新闻翻译编辑。请将以下文本${sourceHint}翻译成${targetName}。要求：1. 译文流畅自然，适合中文读者阅读 2. 符合中文新闻标题和报道习惯 3. 人名、地名、机构名翻译准确 4. 保持原文新闻价值。`,

      literary: `你是一名文学翻译家。请将以下文本${sourceHint}翻译成${targetName}。要求：1. 保持原文风格与情感色彩 2. 语言优美自然，注重可读性 3. 对话翻译口语化、符合人物性格 4. 修辞手法恰当转化。`
    };
    return presets[preset] || presets.general;
  }

  static async openaiTranslate(text, targetLang, sourceLang, config) {
    if (!config.apiKey) throw new Error('请先在设置中填入 API Key');

    const baseUrl = config.apiEndpoint || 'https://api.openai.com/v1/chat/completions';
    const model = config.modelName || 'gpt-3.5-turbo';
    const targetName = Translators._getLangName(targetLang);
    const sourceName = sourceLang ? Translators._getLangName(sourceLang) : '';
    const sourceHint = sourceName ? `从${sourceName}` : '';

    // 构建 system prompt：自定义 > 预设 > 默认
    const suffix = `必须遵守：1. 仅输出译文，不要任何解释 2. 保持原文段落结构，用 ||| 分隔多个段落 3. 保持公式占位符({LX0})、数字、代码原样不动 4. 每个输入段落对应一个译文段落。`;

    let systemPrompt;
    if (config.customPrompt) {
      systemPrompt = config.customPrompt
        .replace(/\{source\}/g, sourceName)
        .replace(/\{target\}/g, targetName) + '\n' + suffix;
    } else {
      systemPrompt = Translators._getPresetPrompt(config.stylePreset || 'general', sourceHint, targetName) + suffix;
    }

    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: 4096
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI兼容 (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    let translated = data.choices[0].message.content.trim();

    return {
      translated,
      from: sourceLang || 'auto',
      to: targetLang
    };
  }

  /* ===== Microsoft Translator ===== */
  static async microsoftTranslate(text, targetLang, sourceLang, apiKey) {
    if (!apiKey) throw new Error('请先在设置中填入 Microsoft API Key');

    const region = 'eastasia';

    const params = new URLSearchParams({ 'api-version': '3.0', to: targetLang });
    if (sourceLang) params.append('from', sourceLang);

    const resp = await fetch(
      `https://api.cognitive.microsofttranslator.com/translate?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'Ocp-Apim-Subscription-Region': region,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{ Text: text }])
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Microsoft (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    let translated = data[0].translations[0].text;

    return {
      translated,
      from: data[0].detectedLanguage?.language || sourceLang || 'auto',
      to: targetLang
    };
  }

  /** 语言代码 → 名称 */
  static _getLangName(code) {
    const map = {
      'zh': '中文', 'zh-CN': '简体中文', 'zh-TW': '繁体中文',
      'en': '英文', 'ja': '日文', 'ko': '韩文',
      'fr': '法文', 'de': '德文', 'es': '西班牙文',
      'ru': '俄文', 'pt': '葡萄牙文', 'it': '意大利文',
      'ar': '阿拉伯文', 'th': '泰文', 'vi': '越南文',
      'id': '印尼文', 'hi': '印地文'
    };
    return map[code] || code;
  }

  /** HTML 转义 */
  static escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Translators;
}
