declare global {
  interface Window {
    ipcRenderer: {
      on(channel: string, listener: (event: any, ...args: any[]) => void): void;
      off(channel: string, listener: (event: any, ...args: any[]) => void): void;
      removeListener(channel: string, listener: (event: any, ...args: any[]) => void): void;
      send(channel: string, ...args: any[]): void;
      invoke(channel: string, ...args: any[]): Promise<any>;
      sendMessage(msg: string, options?: { mode: "chat" | "agent"; isHighlightChat?: boolean; highlightedImage?: string; resumeContext?: { fileName: string, content: string } }): void;
      onReply(callback: (data: string) => void): void;
      removeAllListeners(channel: string): void;
      
      // Conversation monitoring APIs
      startConversationMode(meetingType: string): void;
      stopConversationMode(): void;
      sendAudioTranscript(transcript: string, speaker: string): void;
      
      // Audio capture APIs
      sendAudioData(audioData: ArrayBuffer): void;
      sendAudioCaptureError(error: string): void;
      
      // Live audio/Gemini APIs
      sendLiveAudioChunk(chunk: Uint8Array): void;
      finishAudioTurn(): void;
      sendImageChunk(jpegBase64: string): void;
      toggleGeminiAudio(mute: boolean): void;
      sendTextToGemini(text: string): void;
      
      // Window control
      setIgnoreMouseEvents: (ignore: boolean) => void;
      
      // Advanced mouse detection
      mouseEnterInteractive: () => void;
      mouseLeaveInteractive: () => void;
      
      // Audio loopback
      enableLoopback: () => Promise<void>;
      disableLoopback: () => Promise<void>;
    };
  }

  namespace JSX {
    interface IntrinsicElements {
      'listen-view': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'stt-view': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      'summary-view': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {}; 