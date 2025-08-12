import { ipcRenderer, contextBridge } from "electron";

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args));
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  removeListener(...args: Parameters<typeof ipcRenderer.removeListener>) {
    const [channel, listener] = args;
    return ipcRenderer.removeListener(channel, listener);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },

  sendMessage: (msg: string, options?: { 
    mode: "chat" | "agent";
    isHighlightChat?: boolean;
    highlightedImage?: string;
    resumeContext?: { fileName: string, content: string };
  }) => ipcRenderer.send("message", msg, options),
  onReply: (callback: (data: string) => void) =>
    ipcRenderer.on("reply", (_, data) => callback(data)),
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  // Conversation monitoring APIs
  startConversationMode: (meetingType: string) => ipcRenderer.send("start-conversation-mode", meetingType),
  stopConversationMode: () => ipcRenderer.send("stop-conversation-mode"),
  sendAudioTranscript: (transcript: string, speaker: string) => 
    ipcRenderer.send("audio-transcript", { transcript, speaker }),

  // Audio capture APIs
  sendAudioData: (audioData: ArrayBuffer) => ipcRenderer.send("audio-data", audioData),
  sendAudioCaptureError: (error: string) => ipcRenderer.send("audio-capture-error", error),

  // Live audio/Gemini APIs
  sendLiveAudioChunk: (chunk: Uint8Array) => ipcRenderer.send("live-audio-chunk", chunk),
  finishAudioTurn: () => ipcRenderer.send("live-audio-done"),
  sendImageChunk: (jpegBase64: string) => ipcRenderer.send("live-image-chunk", jpegBase64),
  toggleGeminiAudio: (mute: boolean) => ipcRenderer.send("live-audio-toggle-gemini", mute),
  sendTextToGemini: (text: string) => ipcRenderer.send("live-audio-send-text-input", text),

  // Window control APIs
  setIgnoreMouseEvents: (ignore: boolean) => ipcRenderer.send("set-ignore-mouse-events", ignore),

  // Custom APIs for renderer
  enableLoopback: () => ipcRenderer.invoke("enable-loopback-audio"),
  disableLoopback: () => ipcRenderer.invoke("disable-loopback-audio"),
});

// Bridge for Glass-like web components (no glass dependency)
contextBridge.exposeInMainWorld('api', {
  listenView: {
    onSessionStateChanged: (callback: (event: any, data: { isActive: boolean }) => void) => {
      const handleInit = (_: any, _data: any) => callback(_, { isActive: true });
      const handleClose = (_: any) => callback(_, { isActive: false });
      ipcRenderer.on('session-initialized', handleInit);
      ipcRenderer.on('session-closed', handleClose);
    },
    adjustWindowHeight: (_view: string, targetHeight: number) => {
      return ipcRenderer.invoke('listen-view-adjust-window-height', targetHeight);
    },
  },
  sttView: {
    onSttUpdate: (callback: (event: any, data: { speaker: string; text: string; isFinal: boolean; isPartial: boolean }) => void) => {
      ipcRenderer.on('stt-update', callback);
    },
    removeOnSttUpdate: (callback: any) => {
      ipcRenderer.off('stt-update', callback);
    },
  },
  summaryView: {
    onSummaryUpdate: (callback: (event: any, data: any) => void) => {
      const handler = (_: any, analysis: any) => {
        // Transform analysis to SummaryView expected structure
        const structured = {
          summary: Array.isArray(analysis.summary) ? analysis.summary : [],
          topic: { header: analysis.topic?.header || '', bullets: Array.isArray(analysis.keyPoints) ? analysis.keyPoints : [] },
          actions: Array.isArray(analysis.actions) ? analysis.actions : [],
          followUps: Array.isArray(analysis.questions) ? analysis.questions : [],
        };
        callback(_, structured);
      };
      ipcRenderer.on('analysis-complete', handler);
    },
    onContextualSearch: (callback: (event: any, items: any[]) => void) => {
      ipcRenderer.on('contextual-search', callback);
    },
    onContextualSuggestions: (callback: (event: any, items: any[]) => void) => {
      ipcRenderer.on('contextual-suggestions', callback);
    },
    removeAllSummaryUpdateListeners: () => {
      ipcRenderer.removeAllListeners('analysis-complete');
      ipcRenderer.removeAllListeners('contextual-search');
      ipcRenderer.removeAllListeners('contextual-suggestions');
    },
    performSearch: (query: string) => {
      ipcRenderer.send('perform-search', query);
      return Promise.resolve({ success: true });
    },
  },
});
