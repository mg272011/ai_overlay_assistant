import { html, css, LitElement } from 'lit';
import './stt/SttView.js';
import './summary/SummaryView.js';

export class ListenView extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      transition: transform 0.2s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.2s ease-out;
      will-change: transform, opacity;
    }

    * {
      font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      cursor: default;
      user-select: none;
    }

    .assistant-container {
      display: flex;
      flex-direction: column;
      color: #fff;
      box-sizing: border-box;
      position: relative;
      background: rgba(0, 0, 0, 0.3); /* Dark clear background */
      overflow: hidden;
      border-radius: 12px;
      width: 100%;
      height: auto;
      min-height: 120px; /* Much smaller minimum for adaptive sizing */
      max-height: 500px; /* Increased from 420px to 500px for more content space */
      pointer-events: none; /* Allow click-through for most of the container */
      border: 0.5px solid rgba(255, 255, 255, 0.3);
      backdrop-filter: blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg);
      -webkit-backdrop-filter: blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg);
      box-shadow: 0 8px 32px rgba(31, 38, 135, 0.15), 0 4px 16px rgba(255, 255, 255, 0.1) inset, inset 0 2px 0 rgba(255, 255, 255, 0.6), inset 0 -2px 0 rgba(255, 255, 255, 0.2), inset 0 0 20px 10px rgba(255, 255, 255, 0.08);
      /* Ensure all corners are properly rounded */
      border-top-left-radius: 12px;
      border-top-right-radius: 12px;
      border-bottom-left-radius: 12px;
      border-bottom-right-radius: 12px;
    }

    .assistant-container::after {
      display: none; /* Remove gradient border effect */
    }

    .assistant-container::before {
      display: none; /* Remove shadow pseudo-element */
    }

    .response-overlay {
      position: absolute;
      top: 50px;
      left: 10px;
      right: 10px;
      background: linear-gradient(135deg, rgba(20, 20, 40, 0.95) 0%, rgba(10, 10, 30, 0.95) 100%);
      border: 1px solid rgba(100, 100, 255, 0.3);
      border-radius: 8px;
      padding: 12px 16px;
      color: rgba(255, 255, 255, 0.95);
      font-size: 13px;
      line-height: 1.5;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3), 
                  0 2px 4px rgba(100, 100, 255, 0.1) inset;
      backdrop-filter: blur(10px);
      z-index: 100;
      animation: slideDown 0.3s ease-out;
      max-height: 200px;
      overflow-y: auto;
    }

    .response-overlay::-webkit-scrollbar {
      width: 6px;
    }

    .response-overlay::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 3px;
    }

    .response-overlay::-webkit-scrollbar-thumb {
      background: rgba(100, 100, 255, 0.4);
      border-radius: 3px;
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .top-bar {
      background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04));
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 16px;
      min-height: 32px;
      position: relative;
      z-index: 1;
      width: 100%;
      box-sizing: border-box;
      flex-shrink: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      pointer-events: auto;
    }

    .bar-left-text {
      color: #fff;
      font-size: 13px;
      font-family: 'Helvetica Neue', sans-serif;
      font-weight: 500;
      position: relative;
      overflow: hidden;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
      max-width: 200px;
    }

    .bar-left-text-content {
      display: inline-block;
      transition: transform 0.3s ease;
    }

    .bar-controls {
      display: flex;
      gap: 4px;
      align-items: center;
      flex-shrink: 0;
      width: 120px;
      justify-content: flex-end;
      box-sizing: border-box;
      padding: 4px;
    }

    .toggle-button {
      background: transparent;
      border: none;
      display: flex;
      align-items: center;
      gap: 5px;
      background: transparent;
      color: rgba(255, 255, 255, 0.9);
      border: none;
      outline: none;
      box-shadow: none;
      padding: 4px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      height: 24px;
      white-space: nowrap;
      transition: background-color 0.15s ease;
      justify-content: center;
      pointer-events: auto;
    }

    .toggle-button:hover {
      background: transparent;
    }

    .toggle-button svg {
      flex-shrink: 0;
      width: 12px;
      height: 12px;
    }

    .copy-button {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.95);
      outline: none;
      box-shadow: none;
      padding: 4px;
      border-radius: 3px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
      flex-shrink: 0;
      transition: background-color 0.15s ease;
      position: relative;
      overflow: hidden;
      pointer-events: auto;
    }

    .copy-button:hover {
      background: transparent;
    }

    .copy-button svg {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
    }

    .copy-button .check-icon { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
    .copy-button.copied .copy-icon { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
    .copy-button.copied .check-icon { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  `;

  static properties = {
    viewMode: { type: String },
    isHovering: { type: Boolean },
    isAnimating: { type: Boolean },
    copyState: { type: String },
    elapsedTime: { type: String },
    captureStartTime: { type: Number },
    isSessionActive: { type: Boolean },
    hasCompletedRecording: { type: Boolean },
    meetingResponse: { type: String },
    showResponse: { type: Boolean },
    uploadedDocuments: { type: Array },
  };

  constructor() {
    super();
    this.isSessionActive = false;
    this.hasCompletedRecording = false;
    this.viewMode = 'insights';
    this.isHovering = false;
    this.isAnimating = false;
    this.elapsedTime = '00:00';
    this.captureStartTime = null;
    this.timerInterval = null;
    this.adjustHeightThrottle = null;
    this.isThrottled = false;
    this.copyState = 'idle';
    this.copyTimeout = null;
    this.meetingResponse = '';
    this.showResponse = false;
    this.responseTimeout = null;
    this.uploadedDocuments = [];

    this.adjustWindowHeight = this.adjustWindowHeight.bind(this);
    this.handleDocumentUpload = this.handleDocumentUpload.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.isSessionActive) this.startTimer();
    if (window.api?.listenView?.onSessionStateChanged) {
      window.api.listenView.onSessionStateChanged((_event, { isActive }) => {
        const wasActive = this.isSessionActive;
        this.isSessionActive = isActive;
        if (!wasActive && isActive) {
          this.hasCompletedRecording = false;
          this.startTimer();
          this.updateComplete.then(() => {
            const sttView = this.shadowRoot?.querySelector('stt-view');
            const summaryView = this.shadowRoot?.querySelector('summary-view');
            if (sttView) sttView.resetTranscript();
            if (summaryView) summaryView.resetAnalysis();
          });
          this.requestUpdate();
        }
        if (wasActive && !isActive) {
          this.hasCompletedRecording = true;
          this.stopTimer();
          this.requestUpdate();
        }
      });
    }
    
    // ✅ ADD MISSING EVENT LISTENER FOR MEETING ACTIONS
    console.log('[ListenView] 🔗 Adding meeting-action-clicked event listener');
    this.addEventListener('meeting-action-clicked', this.handleMeetingActionClicked.bind(this));
    console.log('[ListenView] 🔗 Event listener added successfully');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTimer();
    if (this.adjustHeightThrottle) { clearTimeout(this.adjustHeightThrottle); this.adjustHeightThrottle = null; }
    if (this.copyTimeout) { clearTimeout(this.copyTimeout); }
    
    // ✅ REMOVE EVENT LISTENER
    console.log('[ListenView] 🔗 Removing meeting-action-clicked event listener');
    this.removeEventListener('meeting-action-clicked', this.handleMeetingActionClicked.bind(this));
    console.log('[ListenView] 🔗 Event listener removed');
  }

  startTimer() {
    this.captureStartTime = Date.now();
    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.captureStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const seconds = (elapsed % 60).toString().padStart(2, '0');
      this.elapsedTime = `${minutes}:${seconds}`;
      this.requestUpdate();
    }, 1000);
  }

  stopTimer() { if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; } }

  adjustWindowHeight() {
    // No-op in Opus main window to prevent resizing the entire window during meeting mode
    return;
  }

  toggleViewMode() { this.viewMode = this.viewMode === 'insights' ? 'transcript' : 'insights'; this.requestUpdate(); }
  handleCopyHover(isHovering) { this.isHovering = isHovering; this.isAnimating = !!isHovering; this.requestUpdate(); }

  async handleCopy() {
    if (this.copyState === 'copied') return;
    let textToCopy = '';
    if (this.viewMode === 'transcript') {
      const sttView = this.shadowRoot?.querySelector('stt-view');
      textToCopy = sttView ? sttView.getTranscriptText() : '';
    } else {
      const summaryView = this.shadowRoot?.querySelector('summary-view');
      textToCopy = summaryView ? summaryView.getSummaryText() : '';
    }
    try {
      await navigator.clipboard.writeText(textToCopy);
      this.copyState = 'copied'; this.requestUpdate();
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copyTimeout = setTimeout(() => { this.copyState = 'idle'; this.requestUpdate(); }, 1500);
    } catch {}
  }

  adjustWindowHeightThrottled() {
    if (this.isThrottled) return;
    this.adjustWindowHeight();
    this.isThrottled = true;
    this.adjustHeightThrottle = setTimeout(() => { this.isThrottled = false; }, 16);
  }

  // ✅ HANDLE MEETING ACTION CLICKS - THE MISSING PIECE!
  handleMeetingActionClicked(event) {
    console.log('[ListenView] 🔍 ===== MEETING ACTION CLICKED =====');
    console.log('[ListenView] 🔍 Event detail:', JSON.stringify(event.detail, null, 2));
    
    const { type, text, query, actionType } = event.detail;
    
    // Generate unique chat ID for this action
    const chatId = `meeting-chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log('[ListenView] 🔍 Generated chat ID:', chatId);
    
    // Determine action type and prepare action object
    let action;
    if (type === 'search' || actionType === 'search') {
      action = {
        type: 'search',
        query: query || text,
        text: text
      };
    } else if (type === 'say-next' || actionType === 'say-next') {
      action = {
        type: 'say-next',
        text: text || 'What should I say next?'
      };
    } else {
      // Default to search for any other action
      action = {
        type: 'search',
        query: text,
        text: text
      };
    }
    
    console.log('[ListenView] 🚀 Final action object:', JSON.stringify(action, null, 2));
    console.log('[ListenView] 🚀 About to send IPC...');
    console.log('[ListenView] 🚀 ipcRenderer available?', !!window.ipcRenderer);
    console.log('[ListenView] 🚀 ipcRenderer.send available?', !!window.ipcRenderer?.send);
    
    // FIXED: Use window.ipcRenderer.send instead of window.electronAPI.send
    if (window.ipcRenderer?.send) {
      try {
        window.ipcRenderer.send('start-meeting-chat', { chatId, action });
        console.log('[ListenView] ✅ ✅ ✅ Successfully sent start-meeting-chat IPC message');
        console.log('[ListenView] ✅ Payload sent:', JSON.stringify({ chatId, action }, null, 2));
        
        // Set up listener for the response
        this.setupMeetingChatListener(chatId);
        
      } catch (error) {
        console.error('[ListenView] ❌ Error sending IPC:', error);
      }
    } else {
      console.error('[ListenView] ❌ ipcRenderer.send not available');
      console.error('[ListenView] ❌ window.ipcRenderer object:', window.ipcRenderer);
      console.error('[ListenView] ❌ window.electronAPI object:', window.electronAPI);
    }
  }

  // Set up listener for meeting chat responses
  setupMeetingChatListener(chatId) {
    console.log('[ListenView] 🎧 Setting up meeting chat listener for chatId:', chatId);
    
    // FIXED: Use window.ipcRenderer.on instead of window.electronAPI.on
    if (!window.ipcRenderer?.on) {
      console.error('[ListenView] ❌ ipcRenderer.on not available for listening');
      return;
    }
    
    // Reset for new response
    this.meetingResponse = '';
    this.showResponse = true;
    this.requestUpdate();
    
    // Listen for meeting chat stream events
    const handleMeetingChatStream = (event, data) => { // Added event parameter
      console.log('[ListenView] 🎧 ===== RECEIVED MEETING CHAT STREAM =====');
      console.log('[ListenView] 🎧 Data received:', JSON.stringify(data, null, 2));
      console.log('[ListenView] 🎧 Expected chatId:', chatId);
      console.log('[ListenView] 🎧 Received chatId:', data.chatId);
      console.log('[ListenView] 🎧 ChatId match:', data.chatId === chatId);
      console.log('[ListenView] 🎧 Event type:', data.type);
      console.log('[ListenView] 🎧 Content:', data.content);
      
      if (data.chatId === chatId) {
        console.log('[ListenView] 🎧 ✅ Chat ID matches, processing...');
        
        if (data.type === 'text') {
          // Accumulating response text chunk
          // Accumulate chunks
          this.showMeetingResponse(data.content);
        } else if (data.type === 'stream_end') {
          console.log('[ListenView] 🎧 🏁 Stream ended');
          // Clean up the listener - FIXED: Use removeListener instead of removeAllListeners
          window.ipcRenderer.removeListener('meeting-chat-stream', handleMeetingChatStream);
          
          // Hide response after 10 seconds
          if (this.responseTimeout) clearTimeout(this.responseTimeout);
          this.responseTimeout = setTimeout(() => {
            this.showResponse = false;
            this.meetingResponse = '';
            this.requestUpdate();
          }, 10000);
        }
      } else {
        console.log('[ListenView] 🎧 ⚠️ Chat ID mismatch, ignoring');
      }
    };
    
    // Add the listener - FIXED: Use window.ipcRenderer.on
    window.ipcRenderer.on('meeting-chat-stream', handleMeetingChatStream);
    console.log('[ListenView] 🎧 ✅ Meeting chat listener set up successfully');
  }
  
  // Show meeting response in UI
  showMeetingResponse(content) {
    console.log('[ListenView] 📱 Showing meeting response chunk:', content);
    // Accumulate the chunks
    this.meetingResponse += content;
    this.showResponse = true;
    this.requestUpdate();
    console.log('[ListenView] 📱 Total response so far:', this.meetingResponse);
  }

  handleDocumentUpload(event) {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const document = {
            name: file.name,
            content: e.target.result,
            type: file.type,
            uploadedAt: new Date().toISOString()
          };
          
          this.uploadedDocuments = [...this.uploadedDocuments, document];
          console.log('[ListenView] 📄 Document uploaded:', file.name);
          
          // Store document context globally for meeting use
          window.meetingDocuments = this.uploadedDocuments;
          
          // Notify main process of new document context
          if (window.ipcRenderer?.send) {
            window.ipcRenderer.send('meeting-document-uploaded', document);
          }
          
          this.requestUpdate();
        };
        
        if (file.type.includes('text') || file.name.endsWith('.md') || file.name.endsWith('.txt')) {
          reader.readAsText(file);
        } else {
          reader.readAsDataURL(file);
        }
      });
    }
    
    // Clear file input
    event.target.value = '';
  }

  removeDocument(index) {
    this.uploadedDocuments = this.uploadedDocuments.filter((_, i) => i !== index);
    window.meetingDocuments = this.uploadedDocuments;
    this.requestUpdate();
  }

  updated(changedProps) { super.updated(changedProps); if (changedProps.has('viewMode')) this.adjustWindowHeight(); }
  handleSttMessagesUpdated() { this.adjustWindowHeightThrottled(); }
  firstUpdated() { super.firstUpdated(); setTimeout(() => this.adjustWindowHeight(), 200); }

  render() {
    const displayText = this.isHovering ? (this.viewMode === 'transcript' ? 'Copy Transcript' : 'Copy Neatly Insights') : (this.viewMode === 'insights' ? 'Live insights' : `Listening... ${this.elapsedTime}`);
    return html`
      <div class="assistant-container" style="max-width: 440px;">
        <div class="top-bar">
          <div class="bar-left-text"><span style="display:inline-block;width:14px;height:14px;margin-right:6px;opacity:0.9;vertical-align:-2px;">
            <!-- TODO: replace with Neatly logo asset -->
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-10 6 10"/><path d="M12 14v7"/></svg>
          </span><span class="bar-left-text-content ${this.isAnimating ? 'slide-in' : ''}">${displayText}</span></div>
          <div class="bar-controls">
            <!-- Document upload button -->
            <input type="file" id="document-upload" accept=".pdf,.doc,.docx,.txt,.md,.ppt,.pptx" multiple @change=${this.handleDocumentUpload} style="display: none;" />
            <button 
              class="toggle-button" 
              @click=${() => this.shadowRoot.getElementById('document-upload').click()}
              @mouseenter=${() => {
                if (window.ipcRenderer?.send) {
                  window.ipcRenderer.send('mouse:enter-interactive');
                }
              }}
              @mouseleave=${() => {
                if (window.ipcRenderer?.send) {
                  window.ipcRenderer.send('mouse:leave-interactive');
                }
              }}
              title="Upload docs to help with meeting context (resume, agenda, notes, etc.)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7,10 12,15 17,10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
            
            <button 
              class="toggle-button" 
              @click=${this.toggleViewMode}
              @mouseenter=${() => {
                if (window.ipcRenderer?.send) {
                  window.ipcRenderer.send('mouse:enter-interactive');
                }
              }}
              @mouseleave=${() => {
                if (window.ipcRenderer?.send) {
                  window.ipcRenderer.send('mouse:leave-interactive');
                }
              }}
            >
              ${this.viewMode === 'insights' ? html`
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>Show Transcript</span>` : html`
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M22 12v7a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                <span>Show Insights</span>`}
            </button>
            <button class="copy-button ${this.copyState === 'copied' ? 'copied' : ''}" @click=${this.handleCopy} @mouseenter=${() => this.handleCopyHover(true)} @mouseleave=${() => this.handleCopyHover(false)}>
              <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
            </button>
          </div>
        </div>
        
        <!-- Document previews -->
        ${this.uploadedDocuments.length > 0 ? html`
          <div style="padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);">
            <div style="font-size: 10px; color: rgba(255,255,255,0.7); margin-bottom: 4px;">Meeting Context:</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
              ${this.uploadedDocuments.map((doc, index) => html`
                <div style="display: flex; align-items: center; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 10px;">
                  <span style="margin-right: 4px;">📄</span>
                  <span style="max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${doc.name}</span>
                  <button 
                    @click=${() => this.removeDocument(index)}
                    style="margin-left: 4px; background: none; border: none; color: rgba(255,255,255,0.7); cursor: pointer; padding: 0; font-size: 10px;"
                    title="Remove document"
                  >×</button>
                </div>
              `)}
            </div>
          </div>
        ` : ''}
        
        ${this.showResponse && this.meetingResponse ? html`
          <div class="response-overlay">
            ${this.meetingResponse}
          </div>
        ` : ''}
        <stt-view .isVisible=${this.viewMode === 'transcript'} @stt-messages-updated=${this.handleSttMessagesUpdated}></stt-view>
        <summary-view .isVisible=${this.viewMode === 'insights'} .hasCompletedRecording=${this.hasCompletedRecording}></summary-view>
      </div>`;
  }
}

customElements.define('listen-view', ListenView); 