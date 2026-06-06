# 双语翻译助手（Chrome 扩展）— 项目状态

> **全局规则**：每次对代码做出改动后，必须同步更新本文档（修复记录 / 架构变更 / 防重复机制等），保持项目状态与代码一致。

## 当前目标

开发一个 Chrome 浏览器扩展（Manifest V3），实现网页双语对照翻译：
- **划词翻译**：选中文本后弹出翻译面板（Shadow DOM 面板，可拖动）
- **整页翻译**：逐段翻译，译文注入原文元素内部，不破坏页面布局
- **动态内容翻译**：MutationObserver 自动翻译页面后续加载的内容

## 架构

```
popup (popup.js)
  ↓ chrome.runtime.sendMessage
background (service-worker.js)
  ↓ 消息路由 + LRU 缓存 (500条)
  ├── content script (page-translator.js) — 整页翻译
  ├── content script (popup.js) — 划词翻译
  └── utils/translators.js — 6种翻译后端
         ├── Google Translate（免费，国内不稳定）
         ├── MyMemory（免费，月5000字）
         ├── LibreTranslate（可自建实例）
         ├── DeepL（需 API Key）
         ├── OpenAI 兼容（含 AI 风格预设）
         └── Microsoft（需 API Key）
```

**数据流关键点**：
- popup 不直接访问 content script，全部通过 background 转发
- `sendToCurrentTab` 必须 `return await chrome.tabs.sendMessage(...)` 透传响应
- 翻译缓存有两层：background LRU（500条跨页面）+ page-translator `_translateCache` Map（页面级）

## 整页翻译流程

1. TreeWalker 遍历 DOM，提取块级元素（P/H1-H6/LI/TD/TH/DT/DD/DIV/SECTION/ARTICLE/ASIDE/MAIN/HEADER/FOOTER）+ nav/header 内的 `<a>` 链接，跳过 SPAN/LABEL/LEGEND 等内联标签及 code/pre/svg/公式容器；跳过 `<nav>` 容器（子链接单独提取）
2. 每个原文元素内部追加骨架屏占位（`<span class="tr-loading">`）
3. 内容过滤（`_isContentText`）：跳过 UI 标签、技术指标、代码标识符、纯数字/符号等非内容文本
4. 并发翻译（`_processBatchesConcurrently`）：3 路并发请求，每批 20-30 段，无固定批次延迟
5. 译文注入原文元素内部，智能选择注入模式：
   - **内联模式**（短文本 <25字符 / inline-flex 容器）：`display:inline` + `margin-left:0.5em`，同行显示原文+译文
   - **块级模式**（长文本 / block flex-grid 容器）：`display:block` 或 `flex:0 0 100%`，译文独占一行
   - **默认模式**（非 flex 容器）：CSS `.tr-bilingual { display:block }` 自然换行
6. 翻译完成后启动 MutationObserver，监测后续动态加载内容
7. `_runId` 防交叉批次 + `_aborted` 防取消后注入

## 公式保护（核心机制）

**占位符格式**：`{LX0}`（花括号 + LX + 序号）。花括号是 i18n 标准占位符，LX 不是可识别单词，翻译引擎不拆散。

| 类型 | 来源 | 存储内容 | 注入方式 |
|------|------|----------|----------|
| 文本公式 `$...$` `$$...$$` `\(...\)` `\[...\]` | `_protectLatex` 正则 | LaTeX 源码 | `_restoreLatex` 文字替换 |
| DOM 公式 PreTeXt/MathJax/KaTeX/SVG | `_getLatexPlaceholder` | `el.outerHTML`（完整 SVG/HTML） | `innerHTML` 渲染原样保留 |
| 纯标点 PreTeXt span | `_getLatexPlaceholder` | 直接返回标点文本 | 走普通翻译管道 |

**跳过规则**：
- 纯公式元素（去掉占位符后 <2 字符）→ 不进入翻译管道
- `<code>` / `<pre>` / 纯标点 PreTeXt span → 不翻译
- 祖先元素内嵌 `[data-translated]` 子元素 → Observer 不重复翻译

## 防重复机制

| 层级 | 机制 | 位置 |
|------|------|------|
| 元素级 | `data-translated="true"` 标记 | `_replacePlaceholder`, `_translateNewContent` |
| 提取级 | `skipSelector` 含 `[data-translated]` | `_extractSegments` |
| 去重级 | `_dedupSegments` 移除祖先（父包含子且文本重叠60%+） | 提取后过滤 |
| 聚合容器级 | `_isAggregateContainer` 移除多子元素容器（≥3 子文本被父文本子串包含） | `_dedupSegments` 末尾 |
| Observer级 | 过滤子孙有 `[data-translated]` 的元素 | `_translateNewContent` |
| 子串判断 | 子文本需占父文本 60%+ 才视为重叠 | `_textsOverlap` |
| 内容过滤级 | `_isContentText` 预筛标签/指标/代码标识符 | `_extractSegments` 后、占位符注入前 |

| 批次级 | `_runId` + `_aborted` 双重保险 | `translatePage` 主循环 |

## AI 翻译风格预设（仅 OpenAI 引擎）

| 预设 | 特点 |
|------|------|
| 通用 | 标准翻译 |
| 学术 | 专业术语准确，被动语态，学术严谨 |
| 数学 | 数学术语翻译准确，定理/定义/证明语气，公式占位符原样 |
| 技术 | 术语统一，代码/命令/变量名保持原样 |
| 新闻 | 流畅自然，人名地名机构名准确 |
| 文学 | 保持风格与情感色彩，语言优美 |
| 自定义 | 用户自由编写提示词，支持 `{source}` `{target}` 占位符 |

## 已完成功能

- [x] Manifest V3 项目骨架 + 图标 + 多语言设置
- [x] 6 种翻译后端适配器（Google 失败自动降级 MyMemory）
- [x] OpenAI 兼容接口（可配 endpoint + model）
- [x] AI 翻译风格预设（6 种预设 + 自定义提示词）
- [x] Background 消息路由 + LRU 缓存（500条）
- [x] 划词翻译（Shadow DOM 面板 + 拖动 + 复制 + Esc 关闭）
- [x] 整页翻译（TreeWalker + 骨架屏 + 逐批 + 进度徽章）
- [x] 翻译结果缓存（页面内切换免调 API）
- [x] LaTeX 公式保护（文本公式 + DOM 公式 + 纯标点过滤）
- [x] 纯公式元素跳过、Observer 防重复、code/pre 跳过
- [x] 译文样式（透明度+字号微调，无边框无背景，不破坏布局）
- [x] 设置页面（引擎选择 + API Key + OpenAI 配置 + AI 风格）
- [x] 中文翻译 → 英文原文 支持（双向）
- [x] 快捷键 Alt+T 切换整页翻译
- [x] 内容自动过滤（`_isContentText` 跳过 UI 标签/技术指标/代码标识符/纯数字）
- [x] 并发翻译池（3路并发，消除批次间等待）
- [x] 自适应 BATCH_SIZE（20-30段，根据总段数动态调整）
- [x] `|||` 分片对齐保护（分片数不匹配时自动容错）

- [x] 中途取消不产生混合状态 / 交叉批次译文不污染
- [x] removeTranslations 清除 `data-translated` 标记
- [x] `_runId` 防交叉批次干扰

## 关键决策

| 决策 | 原因 |
|------|------|
| 译文注入元素**内部**而非后面 | 避免新增 DOM 兄弟节点破坏 CSS 布局（Flexbox/Grid/nth-child） |
| 分批翻译 + 骨架屏 | 用户立即看到加载状态，不等待全部完成 |
| `|||` 作为分隔符 | `\n` 来回转换会导致译文自然换行被误判为分隔符 |
| Observer 在翻译完成后才启动 | 防止注入骨架屏时触发 Observer 导致重复翻译 |
| `data-translated` 属性标记 | 从源头阻止 `_extractSegments` 重复提取已翻译内容 |
| Google → MyMemory 自动降级 | 国内 Google 翻译 API 不可靠 |
| 译文仅颜色/透明度区分 | 原页面排版不受影响，无额外边框/背景 |
| 占位符 `{LX0}` 格式 | `__LATEX_N__` 被翻译引擎拆分（LATEX 是单词），`{LX0}` 不拆散 |
| DOM 公式 `innerHTML` 注入 | 保留 PreTeXt/SVG 原样渲染，textContent 会丢失结构 |
| 内容过滤 `_isContentText` 预筛 | 跳过 UI 标签/指标/代码标识符，减少翻译总量 40-60%，提升速度和译文整体质量 |
| 3路并发池取代顺序批处理 | 大页面下充分利用 API 带宽，消除串行等待，缩短总耗时 |
| BATCH_SIZE 自适应（20-30段） | 小页面不浪费资源，大页面减少批次总数；无固定批间延迟 |
| `chrome.storage.sync` 存配置 | 跨设备同步设置 |
| `chrome.storage.sync` 存配置 | 跨设备同步设置 |

## 重要约束（易踩坑）

1. **不能修改页面同级 DOM 结构**：译文必须在原文元素内部
2. **不能依赖 `\n` 做分隔符**：翻译 API 会修改换行
3. **占位符不能含可识别单词或格式化标记**：`{LX0}` 取代 `__LATEX_N__`
4. **DOM 公式必须用 `innerHTML`**：不能 textContent（会转义）也不能跳过（会留空）
5. **纯标点 PreTeXt span 必须走文本管道**：避免半角标点混入中文译文
6. **Observer 不能过早启动**：必须在翻译完成之后
7. **`sendToCurrentTab` 必须透传响应**：否则 popup 状态查询永远拿不到 `isPageTranslated`
8. **MyMemory 不支持 `auto` 作为源语言**：`langpair` 需 `en|zh-CN` 格式
9. **`URLSearchParams` 会编码 `|` 为 `%7C`**：含 pipe 的参数须手动拼 URL
10. **MV3 content script 无 `chrome.storage.sync` 权限**
11. **`page-translator.js` 语法错误会导致全部 content script 不加载**
12. **移除译文时必须同时清除 `data-translated` 属性**
13. **内容过滤在占位符注入前执行**：`_isContentText` 过滤后 `_totalCount` 必须同步更新，否则进度徽章分母不准
14. **并发池无线程竞争**：JS 单线程，`_translatedCount` 递增安全；批次独立互不干扰
15. **`|||` 分片对齐保护**：翻译引擎可能增删分隔符，`chunks[j] || ''` 兜底保证不丢段
16. **blockTags 不含 SPAN/LABEL/LEGEND**：SPAN 是内联样式标签不应作为独立段落提取，否则段落内 `<span>` 导致碎片化翻译；LABEL 是表单标签，LEGEND 是 fieldset 标签，同样不适合独立提取
17. **nav 内 `<a>` 链接需单独提取**：TreeWalker 默认跳过内联 `<a>` 标签，需特殊处理 nav/header 内的链接作为独立翻译段
18. **flex/grid 容器需区分 inline/block 上下文**：inline-flex（导航栏等）用 `display:inline` 保持同行，block-flex 用 `flex:0 0 100%` 独占行
19. **短文本译文自动 inline**：原文 <40字符 + 译文 <25字符 → `display:inline` + `margin-left:0.5em`，避免短小译文独占一行造成排版松散
20. **Observer 必须在批量翻译完成后才启动**：`_batchInProgress` 标记防止 Observer 在批量翻译期间触发，避免重复翻译和 `|||` 分隔符残留
21. **Observer 必须使用 `_splitNumberedResult` 兜底**：翻译引擎可能增删 `|||` 分隔符，Observer 的 chunk 拆分需与 `_processBatchesConcurrently` 对齐
22. **inline 模式必须清除 flex 属性**：`display:inline` 与 `flex:0 0 100%` 同时存在会导致样式冲突，inline 模式需移除 `flex/min-width/max-width/grid-column`



## 修复记录

| 日期 | 文件 | 问题 | 修复 |
|------|------|------|------|
| 2026-05-17 | `utils/translators.js` | MyMemory `INVALID LANGUAGE PAIR SPECIFIED` | 空源 `|zh-CN` 改为默认 `en|zh-CN`；手动拼 URL 避免 `|` 被编码 |
| 2026-05-17 | `content/popup.js` | `chrome.storage.sync` 崩溃 | 改为 `chrome.runtime.sendMessage({ type: 'GET_CONFIG' })` |
| 2026-05-19 | `content/page-translator.js` | 展示公式消失/残留 | 占位符去空格，`_restoreLatex` 正则加 `\s*` 容忍意外空格 |
| 2026-05-19 | `content/page-translator.js` | 公式变 HTML 转义文本 | `_getLatexPlaceholder` 存 `outerHTML`，注入改用 `innerHTML` |
| 2026-05-19 | `content/page-translator.js` | 占位符被翻译引擎拆散 | `__LATEX_N__` → `{LX0}`，`_nextLatexId()` 统一生成 |
| 2026-05-19 | `content/page-translator.js` | 纯公式元素（矩阵）重复出现 | 剥除占位符后无文字则跳过不翻译 |
| 2026-05-19 | `background/service-worker.js` | Popup 按钮状态错误 | `sendToCurrentTab` 加 `return await` 透传响应 |
| 2026-05-19 | `content/page-translator.js` | 中途取消仍注入译文 | `await` 返回后检查 `_aborted` |
| 2026-05-19 | `content/page-translator.js` | 翻译结果不能复用 | 新增 `_translateCache` Map，切换翻译/原文免调 API |
| 2026-05-19 | `content/page-translator.js` | 大标题被翻译两次 | `_translateNewContent` 过滤子孙已有 `[data-translated]` 的元素 |
| 2026-05-19 | `options/*` + `translators.js` | AI 翻译效果差 | 新增 6 种预设风格 + `_getPresetPrompt` |
| 2026-05-20 | `content/page-translator.js` | 纯标点被当做公式克隆 | `_getLatexPlaceholder` 对纯标点直接返回文本 |
| 2026-05-20 | `content/page-translator.js` | 命令文本（npm/curl）被翻译 | 从 inline tags 列表移除 `code` |
| 2026-05-20 | `content/page-translator.js` | "but this one is yours" 只翻译了"你" | `_textsOverlap` 子串包含加 60% 阈值 |
| 2026-06-05 | `content/page-translator.js` | 整页翻译极慢（734段页面需~7分钟） | BATCH_SIZE=5→20~30（自适应）；取消800ms固定批间延迟；`_processBatchesConcurrently` 3路并发池 |
| 2026-06-05 | `utils/translators.js` | Google API 在境内被封，MyMemory 质量差 | Google dict-chrome-ex 3s超时；新增 Reverso 降级翻译 |
| 2026-06-05 | `content/page-translator.js` | 译文注入破坏 flex/grid 布局 | 新增 `_applyLayoutProtection`（同时检测元素及父容器 flex/grid，`min-width:100%`） |
| 2026-06-05 | `content/page-translator.js` | `<br>` 注入在 flex 中成为多余子项 | 移除 `<br>` 注入，靠 CSS `display:block` 换行 |
| 2026-06-05 | `content/page-translator.js` | 段落内 `<span>` 被提取导致碎片化翻译 | 从 blockTags 移除 SPAN、LABEL、LEGEND |
| 2026-06-05 | `content/page-translator.js` | 大写缩写过滤误杀导航标签 | `{2,6}`→`{2,3}`，4字以上导航标签通过 |
| 2026-06-05 | `content/page-translator.js` | 导航链接（nav 内 `<a>`）未被翻译 | TreeWalker 新增 `<a>` 标签提取（限 nav/header 内）；`_getMeaningfulText` 允许 `<a>/<font>` 子元素；`_dedupSegments` 跳过 nav/header 容器 |
| 2026-06-05 | `content/page-translator.js` | flex 容器中译文全部独占一行（"32\n内置工具"），破坏导航栏等紧凑布局 | `_applyLayoutProtection` 改为上下文感知：inline-flex → `display:inline`（同行显示），block flex → `flex:0 0 100%`（独占行） |
| 2026-06-05 | `content/page-translator.js` | 短文本译文独占一行导致排版松散 | `_replacePlaceholder` 短文本（<25字符）自动 `display:inline` + `margin-left:0.5em`，同行显示原文+译文 |
| 2026-06-05 | `content/page-translator.js` | Observer 注入 `<br>` 在 flex 中成为多余子项 | `_translateNewContent` 移除 `<br>` 注入，改用智能 inline/block 模式 |
| 2026-06-05 | `content/page-translator.js` | Observer 重复翻译已翻译内容（每个元素多个翻译 span） | 新增 `_batchInProgress` 标记防止 Observer 在批量翻译期间触发；Observer 过滤已有 `.tr-bilingual` 子元素或 `data-translated` 属性的元素 |
| 2026-06-05 | `content/page-translator.js` | `\|\|\|` 分隔符直接显示在页面上 | Observer `_translateNewContent` 添加 `_splitNumberedResult` 兜底（与 `_processBatchesConcurrently` 对齐） |
| 2026-06-05 | `content/page-translator.js` | inline 和 flex 样式冲突（同时设 `flex:0 0 100%` 和 `display:inline`） | inline 模式时清除 `flex/min-width/max-width/grid-column` 属性，避免 CSS 冲突 |










## 已知待处理问题

- 排版可进一步优化（用户反馈"翻译还行，但是排版还可以再优化"）
- 需对比 Immersive Translate 等商业插件的排版效果，持续改进

## 下一步计划

- [ ] **排版优化**（优先）：对比 Immersive Translate，改进译文注入样式，处理更多布局场景（表格、列表、卡片等）
- [ ] 全文翻译缓存持久化（跨页面加载复用，localStorage 或 chrome.storage.local）
- [ ] 页面切换时自动清理/恢复翻译状态
- [x] 大页面智能分片翻译（已实现：自适应 BATCH_SIZE + 3路并发池 + 内容预过滤）
- [x] 导航链接翻译 + inline/block 自适应布局（已实现）

- [ ] 支持更多 OpenAI 兼容模型预设（DeepSeek、通义千问、智谱等一键配置）
- [ ] 自定义 CSS 选择器规则（用户指定哪些元素翻译/不翻译）
- [ ] 图片翻译（OCR + 翻译）
- [ ] YouTube 字幕双语翻译
