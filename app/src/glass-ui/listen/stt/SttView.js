import { html, css, LitElement } from 'lit';

export class SttView extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .transcription-container {
      overflow-y: auto;
      padding: 12px 12px 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 150px;
      max-height: 560px;
      position: relative;
      z-index: 1;
      flex: 1;
      font-size: 12px;
      line-height: 1.5;
      color: rgba(255,255,255,0.95);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .transcription-container::-webkit-scrollbar { width: 8px; }
    .transcription-container::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); border-radius: 4px; }
    .transcription-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.3); border-radius: 4px; }
    .transcription-container::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.5); }

    .line { display: block; }
    .speaker { opacity: 0.7; margin-right: 6px; }
    .empty-state { display:flex; align-items:center; justify-content:center; height:100px; color:rgba(255,255,255,0.6); font-size:12px; font-style:italic; }
  `;

  static properties = {
    sttMessages: { type: Array },
    isVisible: { type: Boolean },
  };

  constructor() {
    super();
    this.sttMessages = [];
    this.isVisible = true;
    this.messageIdCounter = 0;
    this._shouldScrollAfterUpdate = false;
    this._isUserScrolling = false;
    this._scrollIdleTimer = null;
    this.handleSttUpdate = this.handleSttUpdate.bind(this);
    this.handleScroll = this.handleScroll.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    if (window.api?.sttView?.onSttUpdate) {
      window.api.sttView.onSttUpdate(this.handleSttUpdate);
    }
    // Ensure we start at the bottom when the element mounts
    setTimeout(() => this.scrollToBottom(), 0);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (window.api?.sttView?.removeOnSttUpdate) {
      window.api.sttView.removeOnSttUpdate(this.handleSttUpdate);
    }
    const container = this.shadowRoot?.querySelector('.transcription-container');
    if (container) container.removeEventListener('scroll', this.handleScroll);
    if (this._scrollIdleTimer) clearTimeout(this._scrollIdleTimer);
  }

  firstUpdated() {
    const container = this.shadowRoot?.querySelector('.transcription-container');
    if (container) container.addEventListener('scroll', this.handleScroll, { passive: true });
    // Scroll to bottom on first render
    this.scrollToBottom();
  }

  handleScroll() {
    // User is interacting; pause auto-scroll and resume after idle
    this._isUserScrolling = true;
    if (this._scrollIdleTimer) clearTimeout(this._scrollIdleTimer);
    this._scrollIdleTimer = setTimeout(() => {
      this._isUserScrolling = false;
      this.scrollToBottom();
    }, 1000);
  }

  resetTranscript() {
    this.sttMessages = [];
    this.requestUpdate();
  }

  handleSttUpdate(_event, { speaker, text, isFinal, isPartial }) {
    if (text === undefined) return;
    const container = this.shadowRoot?.querySelector('.transcription-container');
    this._shouldScrollAfterUpdate = container ? (container.scrollTop + container.clientHeight >= container.scrollHeight - 10) : false;

    const findLastPartialIdx = (spk) => {
      for (let i = this.sttMessages.length - 1; i >= 0; i--) {
        const m = this.sttMessages[i];
        if (m.speaker === spk && m.isPartial) return i;
      }
      return -1;
    };

    const newMessages = [...this.sttMessages];
    const targetIdx = findLastPartialIdx(speaker);

    if (isPartial) {
      if (targetIdx !== -1) {
        newMessages[targetIdx] = { ...newMessages[targetIdx], text, isPartial: true, isFinal: false };
      } else {
        newMessages.push({ id: this.messageIdCounter++, speaker, text, isPartial: true, isFinal: false });
      }
    } else if (isFinal) {
      if (targetIdx !== -1) {
        newMessages[targetIdx] = { ...newMessages[targetIdx], text, isPartial: false, isFinal: true };
      } else {
        newMessages.push({ id: this.messageIdCounter++, speaker, text, isPartial: false, isFinal: true });
      }
    }

    this.sttMessages = newMessages;
    this.dispatchEvent(new CustomEvent('stt-messages-updated', { detail: { messages: this.sttMessages }, bubbles: true }));
  }

  scrollToBottom() {
    setTimeout(() => {
      const container = this.shadowRoot?.querySelector('.transcription-container');
      if (container && !this._isUserScrolling) container.scrollTop = container.scrollHeight;
    }, 0);
  }

  getTranscriptText() { return this.sttMessages.map((m) => `${m.speaker}: ${m.text}`).join('\n'); }

  updated(changedProps) {
    super.updated(changedProps);
    // If view just became visible, jump to bottom
    if (changedProps.has('isVisible') && this.isVisible) {
      this.scrollToBottom();
    }
    if (changedProps.has('sttMessages')) {
      if (!this._isUserScrolling && this._shouldScrollAfterUpdate) {
        this.scrollToBottom();
      }
      this._shouldScrollAfterUpdate = false;
    }
  }

  render() {
    if (!this.isVisible) return html`<div style="display:none"></div>`;
    return html`
      <div class="transcription-container">
        ${this.sttMessages.length === 0
          ? html`<div class="empty-state">Waiting for speech...</div>`
          : this.sttMessages.map((msg) => html`
              <div class="line"><span class="speaker">${msg.speaker}:</span><span>${msg.text}</span></div>
            `)}
      </div>
    `;
  }
}

customElements.define('stt-view', SttView); 