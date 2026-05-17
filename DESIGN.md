# 双语翻译助手 - 设计文档

## 概述
Chrome 浏览器扩展（Manifest V3），支持划词翻译 + 整页双语翻译，可配置多种翻译后端。

## 项目结构
```
translator-extension/
├── manifest.json              # 扩展清单
├── background/
│   └── service-worker.js      # 消息路由 + LRU 缓存 + 快捷键
├── content/
│   ├── content.js             # 主入口：选择检测 + 消息监听
│   ├── page-translator.js     # 整页翻译：渐进式加载（骨架屏→逐批翻译→实时替换）
│   ├── popup.js               # 划词面板：Shadow DOM + 拖动/复制/关闭
│   └── content.css            # 注入样式（译文、骨架屏、进度徽章、Toast）
├── popup/                     # 工具栏弹窗（快捷控制）
│   ├── popup.html / .js / .css
├── options/                   # 完整设置页面
│   ├── options.html / .js / .css
├── utils/
│   └── translators.js         # 翻译适配层（6种后端）
├── icons/                     # 图标（PNG 16/48/128）
└── _locales/zh_CN/            # 国际化
```

## 核心模块

### 翻译适配层 (`utils/translators.js`)
- **Google Translate**：免费，`translate.googleapis.com`，国内可能被墙，失败自动降级到 MyMemory
- **MyMemory**：免费，`api.mymemory.translated.net`，每月 5000 字限额，支持超长文本拆分
- **LibreTranslate**：开源，可自建实例，支持配置服务地址
- **AI 大模型（OpenAI 兼容）**：可配置 API 地址 + 模型名称，兼容 DeepSeek/通义千问/智谱等
- **DeepL**：需 API Key，翻译质量最高
- **Microsoft Translator**：需 API Key，Azure 服务

统一返回格式：`{ translated, from, to }`

### 整页翻译 - 渐进式加载 (`page-translator.js`)

**设计理念**：让用户实时看到翻译进度，避免"页面无变化"的错觉。

**流程**（参考 Immersive Translate）：
1. **提取段落**：TreeWalker 遍历 DOM，找到有意义的文本块
2. **立即注入骨架屏**：每个原文元素内部追加加载占位动画，不改变 DOM 同级结构
3. **逐批翻译**：每批 5 段，逐批请求翻译 API
4. **实时替换**：每批翻译完成后，骨架屏平滑替换为译文段落
5. **进度徽章**：右下角悬浮显示"已翻译 12/45 段"，带旋转动画

- **去重算法**：`_dedupSegments` — 移除包含子段落的祖先元素（Jaccard 相似度 > 70%）
- **频率限制**：批次间 800ms 延迟，防止 API 并发限制
- **MutationObserver**：监测 DOM 变化，滚动加载的新内容自动翻译（1.2s 防抖）

**跳过规则**：
- `<script>/<style>/<code>/<pre>/<canvas>/<iframe>`
- **LaTeX 公式**：`$...$` / `$$...$$` / `\(...\)` / `\[...\]` → 占位符 → 恢复
- **MathJax/Katex** 渲染元素
- 空内容、纯数字/符号、长度 < 6 字符的文本

**译文样式**（借鉴提示词方案，无边框无背景）：
- `font-family: inherit; opacity: 0.85; font-size: 0.92em;`
- 译文比原文略小略淡，纯文字色差区分，完全融入页面流
- 暗色模式自适应

### 划词翻译 (`popup.js`)
- 监听 `mouseup`，300ms 防抖后获取选中文本
- Shadow DOM 隔离面板样式
- 面板：原文（灰底）+ 译文（蓝底）+ 复制按钮
- 支持拖动、Esc/点击外部关闭
- 暗色模式适配

### 数据流

**划词翻译**：
```
选中文本 → content.js → sendMessage → service-worker → translators.js → 返回 → 弹窗显示
```

**整页翻译（渐进式）**：
```
触发热键 → content.js → page-translator
  ├─ ① 提取段落 → 立即插入骨架屏占位
  ├─ ② 分批(5段/批) sendMessage → service-worker → translators.js
  └─ ③ 每批返回 → 替换占位符 → 更新进度徽章
                                          ↓
                                     右下角实时显示: "已翻译 N/M 段"
```

### Background Worker
- LRU 缓存：最多 500 条，key = `provider:source:target:text[:200]`
- 配置读取：`chrome.storage.sync`
- 快捷键：`Alt+T` → 切换整页翻译

## 实施步骤（已完成）

1. ✅ 项目骨架：目录结构 + manifest.json + 图标
2. ✅ 翻译适配层：6 种后端 + Google→MyMemory 降级
3. ✅ Background Worker：消息路由 + 缓存 + 快捷键
4. ✅ 划词翻译：选择检测 + 浮动面板 + 交互
5. ✅ 整页翻译：TreeWalker + LaTeX保护 + 批量翻译 + 进度提示
6. ✅ 设置页面：翻译服务配置 + 语言 + 行为 + OpenAI 兼容
7. ✅ 图标和收尾

## 已知问题 & 待优化

- [ ] Google Translate API 在国内不稳定，已用 MyMemory 降级但速度较慢
- [ ] 整页翻译对超大页面（>100 段落）可能超时，需分批处理
- [ ] 未做翻译去重（相同段落多次翻译）
- [ ] LibreTranslate 公共实例有频率限制，建议自建
