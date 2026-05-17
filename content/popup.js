/**
 * 划词翻译浮动面板
 * 在选中的文本附近弹出，显示原文+译文双语对照
 * 使用 Shadow DOM 隔离样式
 */

class TranslatePopup {
  constructor() {
    this.visible = false;
    this.container = null;
    this.shadow = null;
    this.dragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.popupX = 0;
    this.popupY = 0;
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._createContainer();
  }

  /** 创建 Shadow DOM 容器 */
  _createContainer() {
    this.container = document.createElement('div');
    this.container.id = 'tr-popup-host';
    this.container.style.cssText = `
      position: fixed; z-index: 2147483647; top: 0; left: 0;
      pointer-events: none;
    `;
    this.shadow = this.container.attachShadow({ mode: 'open' });
    // 注意：container 暂不挂载到 DOM（需要时再挂载）
  }

  /** 在指定位置显示翻译面板 */
  async show(text, rect, targetLang) {
    // 确保容器在 DOM 中
    if (!this.container.parentNode) {
      document.body.appendChild(this.container);
    }

    // 请求翻译
    let translated = '';
    let error = '';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TRANSLATE',
        text,
        targetLang
      });
      if (result.error) {
        error = result.error;
      } else {
        translated = result.translated;
      }
    } catch (e) {
      error = e.message;
    }

    // 计算面板位置（尽量贴近选中文字，不超出视口）
    const margin = 12;
    let x = rect.left + rect.width / 2;
    let y = rect.bottom + margin;
    const maxW = Math.min(520, window.innerWidth - 40);
    const maxH = 320;

    // 如果下方空间不够，放到上方
    if (y + 200 > window.innerHeight) {
      y = rect.top - margin;
    }

    // 构建面板 HTML
    const html = `
      <style>
        :host {
          pointer-events: none;
        }
        .tr-panel {
          position: fixed;
          pointer-events: auto;
          width: ${maxW}px;
          max-height: ${maxH}px;
          background: #fff;
          border: 1px solid #e0e0e0;
          border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.15);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          overflow: hidden;
          z-index: 2147483647;
          animation: trSlideIn 0.2s ease;
        }
        .tr-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          background: #f5f7fa;
          border-bottom: 1px solid #eee;
          cursor: move;
          user-select: none;
          font-size: 12px;
          color: #888;
        }
        .tr-header-title {
          font-weight: 600;
          color: #555;
        }
        .tr-header-actions {
          display: flex;
          gap: 6px;
        }
        .tr-header-actions button {
          border: none;
          background: transparent;
          cursor: pointer;
          color: #888;
          font-size: 14px;
          padding: 2px 6px;
          border-radius: 4px;
          transition: background 0.15s;
        }
        .tr-header-actions button:hover {
          background: #e8e8e8;
          color: #333;
        }
        .tr-body {
          padding: 12px 14px;
          max-height: 240px;
          overflow-y: auto;
        }
        .tr-section {
          margin-bottom: 10px;
        }
        .tr-section:last-child {
          margin-bottom: 0;
        }
        .tr-label {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
          color: #999;
        }
        .tr-original {
          background: #f8f9fa;
          padding: 10px 12px;
          border-radius: 6px;
          color: #444;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .tr-translated {
          background: #e3f2fd;
          padding: 10px 12px;
          border-radius: 6px;
          color: #1565C0;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .tr-error {
          background: #fff3f0;
          padding: 10px 12px;
          border-radius: 6px;
          color: #d32f2f;
        }
        .tr-footer {
          padding: 6px 14px;
          border-top: 1px solid #eee;
          font-size: 11px;
          color: #aaa;
          text-align: right;
        }
        @keyframes trSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-color-scheme: dark) {
          .tr-panel {
            background: #1e1e1e;
            border-color: #333;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          }
          .tr-header { background: #2a2a2a; border-color: #333; }
          .tr-header-title { color: #ccc; }
          .tr-original { background: #2a2a2a; color: #ccc; }
          .tr-translated { background: #1a3a5c; color: #90CAF9; }
          .tr-error { background: #3e1a1a; color: #ef9a9a; }
          .tr-footer { border-color: #333; color: #666; }
        }
      </style>
      <div class="tr-panel" id="tr-panel">
        <div class="tr-header" id="tr-header">
          <span class="tr-header-title">📖 双语翻译</span>
          <span class="tr-header-actions">
            <button id="tr-btn-copy" title="复制译文">📋</button>
            <button id="tr-btn-close" title="关闭">✕</button>
          </span>
        </div>
        <div class="tr-body">
          <div class="tr-section">
            <div class="tr-label">原文</div>
            <div class="tr-original">${Translators.escapeHtml(text)}</div>
          </div>
          <div class="tr-section">
            <div class="tr-label">译文</div>
            ${error
              ? `<div class="tr-error">⚠ ${Translators.escapeHtml(error)}</div>`
              : `<div class="tr-translated">${Translators.escapeHtml(translated)}</div>`
            }
          </div>
        </div>
        <div class="tr-footer" id="tr-footer"></div>
      </div>
    `;

    this.shadow.innerHTML = html;
    this.visible = true;

    // 设置面板位置
    requestAnimationFrame(() => {
      const panel = this.shadow.getElementById('tr-panel');
      if (!panel) return;

      const panelW = panel.offsetWidth;
      const panelH = panel.offsetHeight;

      // 水平方向修正
      if (x + panelW / 2 > window.innerWidth - 10) {
        x = window.innerWidth - panelW - 10;
      } else {
        x = Math.max(10, x - panelW / 2);
      }

      // 垂直方向修正
      if (y + panelH > window.innerHeight - 10) {
        y = window.innerHeight - panelH - 10;
      }
      y = Math.max(10, y);

      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      this.popupX = x;
      this.popupY = y;

      // 绑定事件
      this._bindEvents();
    });
  }

  /** 绑定面板事件 */
  _bindEvents() {
    const header = this.shadow.getElementById('tr-header');
    const btnClose = this.shadow.getElementById('tr-btn-close');
    const btnCopy = this.shadow.getElementById('tr-btn-copy');
    const footer = this.shadow.getElementById('tr-footer');

    // 拖动
    if (header) {
      header.addEventListener('mousedown', this._onMouseDown);
    }

    // 关闭
    if (btnClose) {
      btnClose.addEventListener('click', () => this.hide());
    }

    // 复制
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const translatedEl = this.shadow.querySelector('.tr-translated');
        if (translatedEl) {
          navigator.clipboard.writeText(translatedEl.textContent).then(() => {
            btnCopy.textContent = '✅';
            setTimeout(() => { btnCopy.textContent = '📋'; }, 1500);
          });
        }
      });
    }

    // 翻译服务信息（content script 无 chrome.storage.sync 权限，通过 background 获取）
    if (footer) {
      chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (config) => {
        footer.textContent = `翻译服务: ${(config && config.provider) || 'google'}`;
      });
    }
  }

  _onMouseDown(e) {
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    e.preventDefault();
  }

  _onMouseMove(e) {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    const panel = this.shadow.getElementById('tr-panel');
    if (!panel) return;

    const newX = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, this.popupX + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, this.popupY + dy));
    panel.style.left = newX + 'px';
    panel.style.top = newY + 'px';
  }

  _onMouseUp() {
    this.dragging = false;
    const panel = this.shadow.getElementById('tr-panel');
    if (panel) {
      this.popupX = parseInt(panel.style.left) || 0;
      this.popupY = parseInt(panel.style.top) || 0;
    }
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  /** 隐藏面板 */
  hide() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.shadow.innerHTML = '';
    this.visible = false;
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
  }

  /** 面板是否可见 */
  isVisible() {
    return this.visible;
  }
}

// 挂载到 Translators 命名空间
Translators.TranslatePopup = TranslatePopup;
