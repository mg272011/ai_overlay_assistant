import { html, css, LitElement } from 'lit';
import { marked } from 'marked';
import hljs from 'highlight.js';
import createDOMPurify from 'dompurify';

export class SummaryView extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .insights-container {
      overflow-y: auto;
      padding: 8px 16px 12px 16px; /* tightened top/bottom spacing */
      position: relative;
      z-index: 1;
      min-height: 50px; /* Much smaller minimum to fit content */
      max-height: 420px; /* Reduced max height */
      flex: 1;
      height: auto; /* Let it adapt to content */
      pointer-events: auto; /* Make actions area interactive */
    }

    .insights-container::-webkit-scrollbar {
      width: 8px;
    }

    .insights-container::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.1);
      border-radius: 4px;
    }

    .insights-container::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }

    .insights-container::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.5);
    }

    insights-title {
      color: rgba(255, 255, 255, 0.9);
      font-size: 13px;
      font-weight: 600;
      font-family: 'Helvetica Neue', sans-serif;
      margin: 10px 0 6px 0;
      display: block;
    }

    .insights-container h4 {
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      margin: 12px 0 8px 0;
      padding: 4px 8px;
      border-radius: 4px;
      background: transparent;
      cursor: default;
    }

    .insights-container h4:hover {
      background: transparent;
    }

    .insights-container h4:first-child {
      margin-top: 0;
    }

    .summary-list {
      margin: 4px 0 10px 0;
      padding-left: 20px;
      list-style: disc;
      color: rgba(255, 255, 255, 0.85);
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .summary-list li {
      margin: 3px 0;
      font-size: 11px;
      line-height: 1.4;
      padding: 0;
      color: rgba(255, 255, 255, 0.85);
    }

    .outline-item {
      color: #fff;
      font-size: 11px;
      line-height: 1.4;
      margin: 4px 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: transparent;
      transition: background-color 0.15s ease;
      cursor: pointer;
      word-wrap: break-word;
    }

    .outline-item:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .outline-item.clickable {
      cursor: pointer;
    }

    .request-item {
      color: #fff;
      font-size: 12px;
      line-height: 1.2;
      margin: 4px 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: transparent;
      cursor: default;
      word-wrap: break-word;
      transition: background-color 0.15s ease;
    }

    .request-item.clickable {
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .request-item.clickable:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateX(2px);
    }

    .markdown-content {
      color: #fff;
      font-size: 11px;
      line-height: 1.4;
      margin: 4px 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      word-wrap: break-word;
      transition: all 0.15s ease;
    }

    .markdown-content:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: translateX(2px);
    }

    .markdown-content p { margin: 4px 0; }
    .markdown-content ul, .markdown-content ol { margin: 4px 0; padding-left: 16px; }
    .markdown-content li { margin: 2px 0; }
    .markdown-content a { color: #8be9fd; text-decoration: none; }
    .markdown-content a:hover { text-decoration: underline; }
    .markdown-content strong { font-weight: 600; color: #f8f8f2; }
    .markdown-content em { font-style: italic; color: #f1fa8c; }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100px;
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
      font-style: italic;
    }
  `;

  static properties = {
    structuredData: { type: Object },
    isVisible: { type: Boolean },
    hasCompletedRecording: { type: Boolean },
    contextualActions: { type: Array },
    contextualSuggestions: { type: Array },
  };

  constructor() {
    super();
    this.structuredData = { summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
    this.isVisible = true;
    this.hasCompletedRecording = false;
    this.contextualActions = [];
    this.contextualSuggestions = [];

    this.marked = marked;
    this.hljs = hljs;
    this.DOMPurify = createDOMPurify(window);
    this.isLibrariesLoaded = true;
    
    console.log('[SummaryView] 🏗️ Constructor - SummaryView initialized');
    console.log('[SummaryView] 🏗️ Initial contextualActions:', this.contextualActions);
  }

  connectedCallback() {
    super.connectedCallback();
    if (window.api?.summaryView?.onSummaryUpdate) {
      window.api.summaryView.onSummaryUpdate((_evt, data) => {
        this.structuredData = data;
        this.requestUpdate();
      });
    }
    // Listen for contextual actions/suggestions from main process
    if (window.api?.summaryView?.onContextualSearch) {
      window.api.summaryView.onContextualSearch((_evt, items) => {
        console.log('[SummaryView] 🔍 ===== RECEIVED CONTEXTUAL SEARCH =====');
        console.log('[SummaryView] 🔍 Raw items received:', JSON.stringify(items, null, 2));
        console.log('[SummaryView] 🔍 Items is array:', Array.isArray(items));
        console.log('[SummaryView] 🔍 Items length:', items?.length);
        this.contextualActions = Array.isArray(items) ? items : [];
        console.log('[SummaryView] 🔍 Set contextualActions to:', this.contextualActions);
        this.requestUpdate();
        console.log('[SummaryView] 🔍 Requested update - contextual actions should render');
      });
    } else {
      console.error('[SummaryView] ❌ window.api.summaryView.onContextualSearch not available');
    }
    if (window.api?.summaryView?.onContextualSuggestions) {
      window.api.summaryView.onContextualSuggestions((_evt, items) => {
        console.log('[SummaryView] 💬 ===== RECEIVED CONTEXTUAL SUGGESTIONS =====');
        console.log('[SummaryView] 💬 Raw items received:', JSON.stringify(items, null, 2));
        this.contextualSuggestions = Array.isArray(items) ? items : [];
        console.log('[SummaryView] 💬 Set contextualSuggestions to:', this.contextualSuggestions);
        this.requestUpdate();
      });
    } else {
      console.error('[SummaryView] ❌ window.api.summaryView.onContextualSuggestions not available');
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (window.api?.summaryView?.removeAllSummaryUpdateListeners) {
      window.api.summaryView.removeAllSummaryUpdateListeners();
    }
  }

  resetAnalysis() {
    this.structuredData = { summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
    this.contextualActions = [];
    this.contextualSuggestions = [];
    this.requestUpdate();
  }

  parseMarkdown(text) {
    if (!text) return '';
    if (!this.isLibrariesLoaded || !this.marked) return text;
    try { return this.marked.parse(text); } catch { return text; }
  }

  handleMarkdownClick(originalText) {
    if (window.api?.summaryView?.sendQuestionFromSummary) {
      window.api.summaryView.sendQuestionFromSummary(originalText);
    }
  }

  handleActionClick(action) {
    const detail = typeof action === 'string' ? { type: 'action', text: action } : {
      type: 'action',
      id: action?.id,
      text: action?.text,
      query: action?.query,
      actionType: action?.type
    };
    this.dispatchEvent(new CustomEvent('meeting-action-clicked', { detail, bubbles: true, composed: true }));
  }

  handleSayNextClick() {
    console.log('[SummaryView] 🔥 SAY NEXT CLICKED - handleSayNextClick called');
    console.log('[SummaryView] 🔥 About to dispatch meeting-action-clicked event');
    const event = new CustomEvent('meeting-action-clicked', { 
      detail: { type: 'say-next', text: 'What should I say next?' }, 
      bubbles: true, 
      composed: true 
    });
    console.log('[SummaryView] 🔥 Event created:', event);
    console.log('[SummaryView] 🔥 Event detail:', event.detail);
    this.dispatchEvent(event);
    console.log('[SummaryView] 🔥 Event dispatched successfully');
  }

  renderMarkdownContent() {
    if (!this.isLibrariesLoaded || !this.marked) return;
    const markdownElements = this.shadowRoot?.querySelectorAll('[data-markdown-id]') ?? [];
    markdownElements.forEach((element) => {
      const originalText = element.getAttribute('data-original-text');
      if (!originalText) return;
      try {
        let parsedHTML = this.parseMarkdown(originalText);
        if (this.DOMPurify) {
          parsedHTML = this.DOMPurify.sanitize(parsedHTML);
        }
        element.innerHTML = parsedHTML;
      } catch {
        element.textContent = originalText;
      }
    });
  }

  getSummaryText() {
    const d = this.structuredData || { summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
    const sections = [];
    if (d.summary?.length) sections.push(`Current Summary:\n${d.summary.map((s) => `• ${s}`).join('\n')}`);
    if (d.topic?.header && d.topic?.bullets?.length) sections.push(`\n${d.topic.header}:\n${d.topic.bullets.map((b) => `• ${b}`).join('\n')}`);
    if (d.actions?.length) sections.push(`\nActions:\n${d.actions.map((a) => `▸ ${a}`).join('\n')}`);
    if (d.followUps?.length) sections.push(`\nFollow-Ups:\n${d.followUps.map((f) => `▸ ${f}`).join('\n')}`);
    return sections.join('\n\n').trim();
  }

  updated(changedProperties) {
    super.updated(changedProperties);
    this.renderMarkdownContent();
  }

  render() {
    if (!this.isVisible) return html`<div style="display:none"></div>`;
    
    // Debug contextual actions rendering
    console.log('[SummaryView] 🎨 RENDER - contextualActions length:', this.contextualActions.length);
    console.log('[SummaryView] 🎨 RENDER - contextualActions content:', this.contextualActions);
    
    const data = this.structuredData || { summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
    const hasSummary = Array.isArray(data.summary) && data.summary.length;
    const hasTopic = !!data.topic?.header || (Array.isArray(data.topic?.bullets) && data.topic.bullets.length);

    const iconForAction = (a) => {
      const t = (a?.actionType || a?.type || '').toLowerCase();
      if (t === 'search' || t === 'define' || t === 'research') return '📘';
      if (t === 'question' || t === 'follow-up' || t === 'response' || a?.id === 'say-next') return '💬';
      return '✨';
    };

    const emitAction = (payload) => () => this.handleActionClick(payload);

    return html`
      <div class="insights-container"
        @mouseenter=${() => { try { window.ipcRenderer?.send('mouse:enter-interactive'); } catch {} }}
        @mouseleave=${() => { try { window.ipcRenderer?.send('mouse:leave-interactive'); } catch {} }}
      >
        ${hasSummary ? html`
          <insights-title style="margin-top:6px;">Summary</insights-title>
          <ul class="summary-list">
            ${data.summary.slice(0, 4).map((bullet) => html`<li class="request-item">${bullet}</li>`)}
          </ul>
        ` : ''}

        ${hasTopic ? html`
          ${data.topic?.header ? html`<insights-title style="margin-top:6px;">${data.topic.header}</insights-title>` : ''}
          ${Array.isArray(data.topic?.bullets) && data.topic.bullets.length ? html`
            <ul class="summary-list">
              ${data.topic.bullets.slice(0, 3).map((bullet) => html`<li class="request-item">${bullet}</li>`)}
            </ul>
          ` : ''}
        ` : ''}

        <insights-title style="margin-top:6px;">Actions</insights-title>
        ${/* Only show "What should I say next?" after first analysis is complete */ (hasSummary || hasTopic || (Array.isArray(this.contextualActions) && this.contextualActions.length)) ? html`
          <div class="outline-item clickable" @click=${() => this.handleSayNextClick()}>
            <span>💬</span>
            <span style="margin-left:6px;">What should I say next?</span>
          </div>
        ` : ''}
        ${Array.isArray(this.contextualActions) && this.contextualActions.length ? this.contextualActions.slice(0, 5).map((action) => html`
          <div class="outline-item clickable" title="Click to run action" @click=${emitAction(action)}>
            <span>${iconForAction(action)}</span>
            <span style="margin-left:6px;">${action.text}</span>
          </div>
        `) : ''}

      </div>
    `;
  }
}

customElements.define('summary-view', SummaryView); 