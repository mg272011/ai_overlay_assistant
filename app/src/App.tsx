import { useCallback, useEffect, useRef, useState } from "react";
import { startAudioStreaming, AudioStreamHandle } from "./lib/liveAudioStream";
// Glass web components UI
import "./glass-ui/listen/ListenView.js";
  // Agent Components
  import MacOSAgent from "./agents/MacOSAgent";
  import ChromeAgent from "./agents/ChromeAgent";
  import AskAgent from "./agents/AskAgent";

function App() {
  const [prompt, setPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [, setLoading] = useState(false);
  // removed showPrompt state
  const [messages, setMessages] = useState<
    Array<{ type: string; message: string }>
  >([]);
  const [currentStream, setCurrentStream] = useState("");
  const currentStreamRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMicClickRef = useRef<number>(0); void lastMicClickRef;
  const listenViewRef = useRef<any>(null);
  const sayNextActiveRef = useRef<boolean>(false);
  const highlightScrollRef = useRef<HTMLDivElement | null>(null);
  const highlightAtBottomRef = useRef<boolean>(true);
  const [typewriterText, setTypewriterText] = useState<string>("");
  const [typewriterFullText, setTypewriterFullText] = useState<string>("");
  const typewriterTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Chat pane state
  const [isChatPaneVisible, setIsChatPaneVisible] = useState(false);
  const [isLiveMode, setIsLiveMode] = useState(false);
  // removed stopwatch display (moved inside meeting view)
  const [recordingTime, setRecordingTime] = useState(0); void recordingTime;
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Action-driven Meeting Chats (separate from regular chat)
  type MeetingChat = {
    id: string;
    title: string;
    messages: Array<{ role: 'assistant' | 'system'; content: string }>;
    streaming: boolean;
    currentStream: string;
  };
  const [meetingChats, setMeetingChats] = useState<MeetingChat[]>([]);
  
  // Agent mode state - now controls browser agent
  const [agentMode, setAgentMode] = useState<"chat" | "agent">("chat");
  const [isChromeActive, setIsChromeActive] = useState(false);
  const [_agentSteps, setAgentSteps] = useState<string[]>([]);
  const [_agentThinking, setAgentThinking] = useState<string>("");
  const [_isAgentWorking, setIsAgentWorking] = useState(false);
  
  // Audio streaming state (Clonely-style)
  const audioHandleRef = useRef<AudioStreamHandle | null>(null);
  
  // NEW: Screen highlighting chat state
  const [isHighlightMode, setIsHighlightMode] = useState(false);
  const [highlightedImage, setHighlightedImage] = useState<string | null>(null);
  const [highlightChatVisible, setHighlightChatVisible] = useState(false);
  const highlightChatVisibleRef = useRef<boolean>(false);
  
  // NEW: Resume context state
  const [resumeContent] = useState<string | null>(null);
  const [resumeFileName] = useState<string | null>(null);
  
  // Agent suggestions (always active)
  // removed quick suggestions for minimal UI
  const [agentSuggestions] = useState<string[]>([]); void agentSuggestions;

  // Menu dropdown state
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Clean state - no more chat window complexity
  
  // Debug menu state changes
  useEffect(() => {
    console.log('[Menu State Changed] isMenuOpen:', isMenuOpen);
  }, [isMenuOpen]);

  // Remove all the complex hover stuff - just keep it simple

  useEffect(() => {
    window.ipcRenderer.on(
      "reply",
      (_event: any, data: { type: string; message: string }) => {
        setMessages((prev) => {
          const exists = prev.some(
            (msg) => msg.type === data.type && msg.message === data.message
          );
          return exists ? prev : [...prev, data];
        });
        setLoading(false);
        setIsStreaming(false);
        setCurrentStream("");
        currentStreamRef.current = "";
        
        // Refocus input when done processing
        setTimeout(() => {
          if (inputRef.current && isChatPaneVisible) {
            inputRef.current.focus();
          }
        }, 100);
      }
    );

    // Meeting Action Chat streaming events
    window.ipcRenderer.on(
      "meeting-chat-stream",
      (_e: any, data: { chatId: string; type: string; content?: string }) => {
        setMeetingChats((prev) => {
          const next = prev.map((c) => ({ ...c }));
          const chat = next.find((c) => c.id === data.chatId);
          if (!chat) return prev;
          if (data.type === 'text') {
            chat.streaming = true;
            chat.currentStream = (chat.currentStream || '') + (data.content || '');
            console.log(`[ActionChat] Received text for ${data.chatId}:`, data.content, 'Total so far:', chat.currentStream);
          } else if (data.type === 'stream_end') {
            chat.streaming = false;
            console.log(`[ActionChat] Stream ended for ${data.chatId}, currentStream:`, chat.currentStream);
            if (chat.currentStream && chat.currentStream.trim()) {
              // For say-next, replace instead of stacking
              if ((chat as any).sayNext) {
                chat.messages = [{ role: 'assistant', content: chat.currentStream.trim() }];
              } else {
                chat.messages.push({ role: 'assistant', content: chat.currentStream.trim() });
              }
              console.log(`[ActionChat] Added message for ${data.chatId}:`, chat.currentStream.trim());
              chat.currentStream = '';
            }
          }
          return next;
        });
      }
    );

    // Live updates for "What should I say next?" from contextual suggestions
    const handleContextualSuggestions = (_: any, suggestions: any[]) => {
      if (!suggestions || suggestions.length === 0) return;
      const top = suggestions[0]?.text || suggestions[0];
      if (!top) return;
      setMeetingChats((prev) => {
        const next = prev.map((c) => ({ ...c }));
        const sayNextChat = next.find((c) => (c as any).sayNext === true);
        if (!sayNextChat) return prev;
        // Replace any existing message to avoid stacking
        sayNextChat.messages = [{ role: 'assistant', content: String(top) }];
        sayNextChat.currentStream = '';
        sayNextChat.streaming = false;
        return next;
      });
    };
    window.ipcRenderer.on('contextual-suggestions', handleContextualSuggestions);

    window.ipcRenderer.on(
      "meeting-chat-reply",
      (_e: any, data: { chatId: string; message: string }) => {
        setMeetingChats((prev) => prev.map((c) => c.id === data.chatId ? { ...c, streaming: false, currentStream: '', messages: [...c.messages, { role: 'system', content: data.message }] } : c));
      }
    );

    window.ipcRenderer.on(
      "stream",
      (_event: any, data: { type: string; content?: string; toolName?: string }) => {
        setIsStreaming(true);
        setLoading(false);
        switch (data.type) {
          case "text":
            setCurrentStream((prev) => {
              const newContent = prev + (data.content || "");
              currentStreamRef.current = newContent;
              return newContent;
            });
            break;
          case "tool_start":
            setCurrentStream((prev) => {
              const newContent = prev + `\n\n🔧 \`${data.toolName}\`\n`;
              currentStreamRef.current = newContent;
              return newContent;
            });
            break;
          case "tool_args":
            setCurrentStream((prev) => {
              const newContent = prev + (data.content || "");
              currentStreamRef.current = newContent;
              return newContent;
            });
            break;
          case "tool_execute":
            setCurrentStream((prev) => {
              const newContent = prev + "\n⚡ *Executing...*";
              currentStreamRef.current = newContent;
              return newContent;
            });
            break;
          case "tool_result":
            setCurrentStream((prev) => {
              const newContent = prev + `\n✅ ${data.content}\n\n`;
              currentStreamRef.current = newContent;
              return newContent;
            });
            break;
          case "chunk_complete":
            // This chunk is complete, but keep streaming active for now
            break;
          case "stream_end":
            // Explicitly end streaming and save the content
            setIsStreaming(false);
            // Save the streamed content to messages if there is any
            if (currentStreamRef.current.trim()) {
              const messageContent = currentStreamRef.current.trim();
              console.log('[App] Saving streamed content to messages:', messageContent.substring(0, 100) + '...');
              if (highlightChatVisibleRef.current) {
                // In highlight mode, use the same typewriter reveal as regular chat
                setTypewriterFullText(messageContent);
              } else {
                // Use typewriter for chat mode instead of pasting immediately
                setTypewriterFullText(messageContent);
              }
              setCurrentStream("");
              currentStreamRef.current = "";
            }
            break;
        }
      }
    );

    // SummaryView question click -> set prompt and auto-submit
    window.ipcRenderer.on('summary-view-send-question', (_e: any, text: string) => {
      setPrompt(text);
      setTimeout(() => {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true }));
        setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 150);
      }, 100);
    });

    // Listen for browser detection (keep logic but remove popup)
    window.ipcRenderer.on("browser-detected", (_event: any, browserInfo: any) => {
      console.log('[Browser Detection] Browser detected:', browserInfo);
      // No popup - just log the detection
    });

    // Listen for browser command results  
    window.ipcRenderer.on("browser-command-result", (_event: any, result: any) => {
      console.log('[Browser Command] Result:', result);
      
      // Update agent steps display (BrowserOS style)
      if (result.success) {
        setAgentSteps(prev => [...prev, `✓ ${result.message}`]);
      } else {
        setAgentSteps(prev => [...prev, `✗ ${result.message}`]);
      }
      
      setIsAgentWorking(false);
      setAgentThinking("");
    });



    // NEW: Listen for screen capture ready for prompt
    window.ipcRenderer.on(
      "screen-captured-for-prompt",
      (_event: any, data: { imageBase64: string }) => {
        console.log('[ScreenHighlight] Screenshot captured, ready for prompt');
        setHighlightedImage(data.imageBase64);
        setIsHighlightMode(false);
        setHighlightChatVisible(true);
        setIsChatPaneVisible(false); // Ensure only highlight chat is visible
        setMessages([]); // Clear previous messages
        setCurrentStream(""); // Clear any streaming content
        
        // Focus the input for immediate typing
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
          }
        }, 100);
      }
    );

    return () => {
      window.ipcRenderer.removeAllListeners("reply");
      window.ipcRenderer.removeAllListeners("stream");
      window.ipcRenderer.removeAllListeners("screen-captured-for-prompt");
      window.ipcRenderer.removeAllListeners("summary-view-send-question");
      window.ipcRenderer.removeAllListeners("meeting-chat-stream");
      window.ipcRenderer.removeAllListeners("meeting-chat-reply");
      window.ipcRenderer.removeAllListeners('contextual-suggestions');
    };
  }, []);

  useEffect(() => {
    sayNextActiveRef.current = meetingChats.some((c: any) => (c as any).sayNext);
  }, [meetingChats]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentStream]);



  // Auto-scroll highlight panel to bottom when streaming or typewriter updates
  useEffect(() => {
    const el = highlightScrollRef.current;
    if (!el) return;
    // Only auto-scroll if user is already at the bottom
    if (highlightAtBottomRef.current) {
      try { el.scrollTop = el.scrollHeight; } catch {}
    }
  }, [currentStream, isStreaming, typewriterText, typewriterFullText, messages.length, highlightChatVisible]);

  // Track whether user has scrolled away from bottom in highlight view
  useEffect(() => {
    const el = highlightScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      highlightAtBottomRef.current = distanceFromBottom <= 48; // within 48px counts as at bottom
    };
    el.addEventListener('scroll', onScroll, { passive: true } as any);
    // Initialize as at bottom when view opens
    highlightAtBottomRef.current = true;
    return () => el.removeEventListener('scroll', onScroll as any);
  }, [highlightChatVisible]);

  // Auto-open chat when agent starts working
  useEffect(() => {
    if (!highlightChatVisible && (isStreaming || messages.length > 0 || currentStream)) {
      setIsChatPaneVisible(true);
    }
  }, [isStreaming, messages.length, currentStream, highlightChatVisible]);

  // Show/hide virtual cursor based on mode
  useEffect(() => {
    // Agent mode removed - no collab mode toggle
    // The virtual cursor is now managed entirely through toggle-collab-mode
  }, []);

  useEffect(() => {
    if (inputRef.current && isChatPaneVisible) {
      inputRef.current.focus();
    }
  }, [isChatPaneVisible]);

  // Recording timer for mic
  useEffect(() => {
    if (isLiveMode) {
      setRecordingTime(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime((prevTime) => prevTime + 1);
      }, 1000);
    } else {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      setRecordingTime(0);
    }
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
    };
  }, [isLiveMode]);

  useEffect(() => {
    highlightChatVisibleRef.current = highlightChatVisible;
  }, [highlightChatVisible]);

  // stopwatch UI moved to meeting view

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      console.log('[App] 🔄 Form submitted - prompt:', prompt, 'isStreaming:', isStreaming, 'highlightChatVisible:', highlightChatVisible, 'highlightedImage available:', !!highlightedImage);
      
      if (prompt.trim() && !isStreaming) {
        setIsStreaming(true);
        setLoading(true);
        // user prompt reflection removed for clear UI
        setCurrentStream("");
        // Ephemeral chat: clear previous messages each turn
        setMessages([]);
        // Reset typewriter state for new turn
        if (typewriterTimerRef.current) { clearInterval(typewriterTimerRef.current); typewriterTimerRef.current = null; }
        setTypewriterText("");
        setTypewriterFullText("");
        
        // If this is highlight chat, reflect the user's question in the highlight thread
        if (highlightChatVisible) {
          setMessages([{ type: 'user', message: prompt } as any]);
        }
        
        // Send message with agent mode and highlight context if available
        if (highlightChatVisible && highlightedImage) {
          // Send highlight chat with image
          console.log('[App] 🎯 Sending highlight chat message:', prompt);
          console.log('[App] 🎯 Image length:', highlightedImage.length, 'chars');
          (window.ipcRenderer.sendMessage as any)(prompt, { 
            mode: agentMode,
            isHighlightChat: true,
            highlightedImage: highlightedImage
          });
        } else {
          // Regular message
          console.log('[App] 💬 Sending regular message:', prompt);
          (window.ipcRenderer.sendMessage as any)(prompt, { 
            mode: agentMode,
            resumeContext: resumeContent ? { fileName: resumeFileName, content: resumeContent } : null
          });
        }
        
        setPrompt("");
        
        // Refocus input after submission
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
          }
        }, 100);
      } else {
        console.log('[App] ❌ Form submission blocked - empty prompt or streaming');
      }
    },
    [prompt, isStreaming, agentMode, highlightChatVisible, highlightedImage, resumeContent, resumeFileName]
  );

  // Check Chrome status and start browser monitoring when agent mode is activated
  useEffect(() => {
    if (agentMode === 'agent') {
      window.ipcRenderer.send('check-chrome-active');
      window.ipcRenderer.send('start-browser-monitoring');
      
      const handleChromeStatus = (_event: any, isActive: boolean) => {
        setIsChromeActive(isActive);
      };
      
      const handleBrowserDetected = (_event: any, data: { browserName: string, isChromeActive: boolean }) => {
        if (data.isChromeActive) {
          setIsChromeActive(true);
          // Notify that we've switched to Chrome for any ongoing tasks
          window.ipcRenderer.send('chrome-agent-activated');
        }
      };
      
      window.ipcRenderer.on('chrome-status', handleChromeStatus);
      window.ipcRenderer.on('browser-detected', handleBrowserDetected);
      
      return () => {
        window.ipcRenderer.removeListener('chrome-status', handleChromeStatus);
        window.ipcRenderer.removeListener('browser-detected', handleBrowserDetected);
        window.ipcRenderer.send('stop-browser-monitoring');
      };
    } else {
      // Also stop monitoring if not in agent mode
      window.ipcRenderer.send('stop-browser-monitoring');
    }
  }, [agentMode]);

  // Notify main process when agent mode changes
  useEffect(() => {
    // Agent mode state change handled by browser monitoring above
  }, [agentMode]);

  // Listen for live transcripts when in live mode
  useEffect(() => {
    console.log('[LiveMode] State changed to:', isLiveMode);
    if (isLiveMode) {
      const handleLiveTranscript = (_event: any, data: { transcript: string; channel: number; isFinal: boolean }) => {
        console.log('[LiveTranscript] Received:', data);
        
        // ONLY show system audio (channel 1) - ignore user audio (channel 0)
        if (data.channel !== 1) {
          console.log('[LiveTranscript] Ignoring channel 0 (user audio) - only showing system audio');
          return;
        }
        
        if (data.isFinal) {
          // Final transcript - add as new line
          console.log('[LiveTranscript] Adding final system audio transcript:', data.transcript);
          // setTranscriptLines(prev => { // This line was removed
          //   const newLines = [...prev, data.transcript];
          //   console.log('[LiveTranscript] Updated transcript lines:', newLines);
          //   return newLines;
          // });
        } else {
          // Interim transcript - update the last line or add new one
          console.log('[LiveTranscript] Updating interim system audio transcript:', data.transcript);
          // setTranscriptLines(prev => { // This line was removed
          //   const newLines = [...prev];
          //   const lastLine = newLines[newLines.length - 1];
            
          //   // Check if we're updating an interim transcript (no punctuation at end)
          //   if (lastLine && !lastLine.endsWith('.') && !lastLine.endsWith('?') && !lastLine.endsWith('!')) {
          //     // Update the last line with new interim transcript
          //     newLines[newLines.length - 1] = data.transcript;
          //   } else {
          //     // Add new interim transcript line
          //     newLines.push(data.transcript);
          //   }
          //   console.log('[LiveTranscript] Updated transcript lines (interim):', newLines);
          //   return newLines;
          // });
        }
      };

      const handleGeminiTranscript = (_: any, data: { text?: string; reset?: boolean }) => {
        console.log('[GeminiTranscript] Received:', data);
        
        // Handle special Clonely tags
        if (data.text?.trim() === '<NONE/>') {
          console.log('[GeminiTranscript] Received <NONE/> - showing waiting message');
          // Show a friendly waiting message instead of nothing
          // setLiveActions(['💭 Waiting for audio!']); // This line was removed
        }
        
        if (data.text?.startsWith('<APPEND/>')) {
          // Append mode - continue the last response
          const appendText = data.text.replace('<APPEND/>', '').trim();
          console.log('[GeminiTranscript] Appending:', appendText);
          // setLiveActions(prev => { // This line was removed
          //   const newActions = [...prev];
          //   if (newActions.length > 0) {
          //     newActions[newActions.length - 1] += ' ' + appendText;
          //   } else {
          //     newActions.push(appendText);
          //   }
          //   return newActions.slice(-3); // Keep only last 3
          // });
          return;
        }
        
        if (data.reset) {
          // Start a new Gemini response - but skip if it's NONE
          if (data.text?.trim() === '<NONE/>') {
            console.log('[GeminiTranscript] Reset with <NONE/> - showing waiting message');
            // setLiveActions(['💭 Waiting for audio!']); // This line was removed
            return;
          }
          console.log('[GeminiTranscript] Starting new response:', data.text);
          // setLiveActions(prev => [...prev, data.text || ""]); // This line was removed
        } else if (data.text) {
          // Check for NONE in continuing text too
          if (data.text.trim() === '<NONE/>') {
            console.log('[GeminiTranscript] Continuing text is <NONE/> - showing waiting message');
            // setLiveActions(['💭 Waiting for audio!']); // This line was removed
            return;
          }
          // Append to the last Gemini response
          console.log('[GeminiTranscript] Continuing response:', data.text);
          // setLiveActions(prev => { // This line was removed
          //   const newActions = [...prev];
          //   if (newActions.length > 0) {
          //     newActions[newActions.length - 1] += data.text || "";
          //   } else {
          //     newActions.push(data.text || "");
          //   }
          //   return newActions.slice(-3); // Keep only last 3
          // });
        }
      };
      
      const handleSuggestion = (_: any, _data: { text: string; context: any }) => {
        // setLiveActions(prev => { // This line was removed
        //   const newActions = [...prev, data.text];
        //   return newActions.slice(-3); // Keep only last 3
        // });
      };

      // Glass JavaScript meeting event handlers
      const handleGlassTranscriptionComplete = (_: any, data: { id: string; speaker: string; text: string; timestamp: Date }) => {
        console.log('[Glass Meeting] Transcription complete:', data);
        // If user just finished speaking and say-next is active, generate a fresh suggestion
        const spk = (data.speaker || '').toLowerCase();
        if ((spk === 'me' || spk === 'user') && sayNextActiveRef.current && data.text && data.text.trim()) {
          try {
            window.ipcRenderer.send('generate-contextual-actions', { text: data.text, speaker: data.speaker });
          } catch {}
        }
      };

      // STT updates are handled directly by GlassMeetingView component

      const handleGlassAnalysisUpdate = (_: any, data: any) => {
        console.log('[Glass Meeting] Analysis update:', data);
        // Update summary/analysis display
      };

      const handleGlassSessionInitialized = (_: any, data: { sessionId: string; timestamp: Date }) => {
        console.log('[Glass Meeting] Session initialized:', data);
      };

      const handleGlassUpdateStatus = (_: any, status: string) => {
        console.log('[Glass Meeting] Status update:', status);
      };

      const handleLiveAudioReady = () => {
        console.log('[LiveMode] ✅ Main process LiveAudioService ready');
      };

      const handleLiveAudioError = (_: any, error: string) => {
        console.error('[LiveMode] ❌ Main process LiveAudioService error:', error);
        alert('LiveAudioService failed: ' + error);
        setIsLiveMode(false);
      };

      // Register Glass JavaScript meeting event listeners
      window.ipcRenderer.on("transcription-complete", handleGlassTranscriptionComplete);
      // stt-update events are handled directly by GlassMeetingView component
      window.ipcRenderer.on("analysis-update", handleGlassAnalysisUpdate);
      window.ipcRenderer.on("session-initialized", handleGlassSessionInitialized);
      window.ipcRenderer.on("update-status", handleGlassUpdateStatus);
      
      // Keep existing listeners for compatibility
      window.ipcRenderer.on("live-audio-ready", handleLiveAudioReady);
      window.ipcRenderer.on("live-audio-error", handleLiveAudioError);
      window.ipcRenderer.on("live-transcript", handleLiveTranscript);
      window.ipcRenderer.on("gemini-transcript", handleGeminiTranscript);
      window.ipcRenderer.on("conversation-transcript", handleLiveTranscript); // Legacy support
      window.ipcRenderer.on("conversation-suggestion", handleSuggestion);

      return () => {
        // FORCE stop any browser monitoring on component unmount
        console.log('[App] Component unmounting, force stopping browser services');
        try {
          window.ipcRenderer.send("emergency-stop-monitoring");
        } catch (error) {
          console.error('[App] Error sending emergency stop:', error);
        }
        
        // Remove Glass JavaScript meeting event listeners
        window.ipcRenderer.removeListener("transcription-complete", handleGlassTranscriptionComplete);
        // stt-update cleanup handled by GlassMeetingView component
        window.ipcRenderer.removeListener("analysis-update", handleGlassAnalysisUpdate);
        window.ipcRenderer.removeListener("session-initialized", handleGlassSessionInitialized);
        window.ipcRenderer.removeListener("update-status", handleGlassUpdateStatus);
        
        // Remove existing listeners
        window.ipcRenderer.removeListener("live-audio-ready", handleLiveAudioReady);
        window.ipcRenderer.removeListener("live-audio-error", handleLiveAudioError);
        window.ipcRenderer.removeListener("live-transcript", handleLiveTranscript);
        window.ipcRenderer.removeListener("gemini-transcript", handleGeminiTranscript);
        window.ipcRenderer.removeListener("conversation-transcript", handleLiveTranscript);
        window.ipcRenderer.removeListener("conversation-suggestion", handleSuggestion);
        
        // Keyboard listener cleanup handled within useEffect
      };
    }
  }, [isLiveMode]);

  // Bridge listen-view custom event to React
  useEffect(() => {
    const el = listenViewRef.current as HTMLElement | null;
    if (!el) {
      console.log('[App] listenViewRef.current is null, cannot attach event listener');
      return;
    }
    
    console.log('[App] Attaching meeting-action-clicked listener to listen-view element');
    
    const handler = (e: any) => {
      console.log('[App] meeting-action-clicked event received:', e.detail);
      const detail = e.detail || {};
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const title = detail.type === 'say-next' ? 'What should I say next?' : (detail.text || 'Action');
      
      if (detail.type === 'say-next') {
        console.log('[App] Creating say-next chat window');
        // Create or refresh the say-next chat with new suggestion
        let sayNextId = id;
        setMeetingChats((prev) => {
          const existing = prev.find((c) => (c as any).sayNext);
          if (existing) {
            sayNextId = existing.id;
            console.log('[App] Refreshing existing say-next chat:', sayNextId);
            // Clear old messages and show new loading state
            return prev.map(c => c.id === existing.id 
              ? { ...c, messages: [], streaming: true, currentStream: 'Thinking of what you could say next...' }
              : c
            );
          }
          console.log('[App] Creating new say-next chat:', id);
          return [...prev, { id, title, messages: [], streaming: true, currentStream: 'Thinking of what you could say next...', ...( { sayNext: true } as any) } as any];
        });
        setIsChatPaneVisible(true);
        // Kick off the say-next stream in main process using recent context
        try { 
          console.log('[App] Sending start-meeting-chat for say-next');
          window.ipcRenderer.send('start-meeting-chat', { chatId: sayNextId, action: { type: 'say-next' } }); 
        } catch (err) {
          console.error('[App] Error sending start-meeting-chat:', err);
        }
      } else {
        console.log('[App] Creating action chat for:', detail);
        // Start an action chat via main process
        setMeetingChats((prev) => [...prev, { id, title, messages: [], streaming: true, currentStream: '' }]);
        setIsChatPaneVisible(true);
        window.ipcRenderer.send('start-meeting-chat', { chatId: id, action: detail });
      }
    };
    
    el.addEventListener('meeting-action-clicked', handler as any);
    console.log('[App] Event listener attached successfully');
    
    return () => {
      console.log('[App] Removing meeting-action-clicked listener');
      el.removeEventListener('meeting-action-clicked', handler as any);
    };
  }, [isLiveMode]); // Changed dependency to isLiveMode so it re-attaches when entering live mode

  // Listen for dynamic agent suggestions based on screen content
  useEffect(() => {
    const handleSuggestion = (_: any, suggestions: string[]) => {
      if (suggestions && suggestions.length > 0) {
        /* suggestions disabled for minimal UI */
      }
    };

    window.ipcRenderer.on("agent-suggestions", handleSuggestion);

    return () => {
      window.ipcRenderer.removeListener("agent-suggestions", handleSuggestion);
    };
  }, []);

  // Keyboard shortcuts: Cmd+Enter to toggle chat, Enter to submit when chat is open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      console.log('[Keyboard] Key pressed:', e.key, 'metaKey:', e.metaKey, 'ctrlKey:', e.ctrlKey, 'chat visible:', isChatPaneVisible, 'highlight visible:', highlightChatVisible);
      
      // Command+Option: Toggle Agent mode
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.key.match(/^[a-zA-Z0-9]$/)) {
        e.preventDefault();
        if (agentMode === "agent") {
          setAgentMode("chat");
          setIsChatPaneVisible(false);
        } else {
          setAgentMode("agent");
          setIsChatPaneVisible(false);
          setHighlightChatVisible(false);
        }
        return;
      }
      
      // Command+Delete: Toggle Select (highlight) mode
      if ((e.metaKey || e.ctrlKey) && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        if (isHighlightMode || highlightChatVisible) {
          setIsHighlightMode(false);
          setHighlightedImage(null);
          setHighlightChatVisible(false);
          window.ipcRenderer.send("cancel-screen-highlight");
        } else {
          if (!isLiveMode) {
            setIsHighlightMode(true);
            window.ipcRenderer.send("start-screen-highlight");
          }
        }
        return;
      }
      
      // Command+Shift: Toggle Listen mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.key.match(/^[a-zA-Z0-9]$/)) {
        e.preventDefault();
        if (isLiveMode) {
          // Stop listen mode
          if (audioHandleRef.current) {
            audioHandleRef.current.stop();
            audioHandleRef.current = null;
          }
          setIsLiveMode(false);
          localStorage.removeItem('opus-meeting-mode');
          setMeetingChats([]);
          setIsChatPaneVisible(false);
          setMessages([]);
          setCurrentStream("");
          window.ipcRenderer.send("stop-conversation-mode");
        } else {
          // Start listen mode
          setIsLiveMode(true);
          setIsChatPaneVisible(true);
          localStorage.setItem('opus-meeting-mode', 'true');
          window.ipcRenderer.send("start-conversation-mode", "live");
          startAudioStreaming((chunk) => {
            console.log('[AudioStreaming] Sending chunk to main process, size:', chunk.length);
            window.ipcRenderer.send("live-audio-chunk", chunk);
          }).then(({ handle }) => {
            audioHandleRef.current = handle;
            console.log('[AudioStreaming] ✅ Audio streaming started successfully');
          }).catch((error) => {
            console.error('[AudioStreaming] ❌ Failed to start audio streaming:', error);
            alert('Failed to start audio capture: ' + error.message);
            setIsLiveMode(false);
            localStorage.removeItem('opus-meeting-mode');
          });
        }
        return;
      }
      
      // Command+Enter: Toggle chat open/closed
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        console.log('[Keyboard] Cmd+Enter detected, toggling chat');
        e.preventDefault();
        
        if (isChatPaneVisible || highlightChatVisible) {
          // Close chat and clear state
          console.log('[Keyboard] Closing chat');
          setIsChatPaneVisible(false);
          setHighlightChatVisible(false);
          setHighlightedImage(null);
          setMessages([]);
          setCurrentStream("");
          // cleared
        } else {
          // Open chat and focus input
          console.log('[Keyboard] Opening chat');
          setIsChatPaneVisible(true);
          setTimeout(() => {
            if (inputRef.current) {
              inputRef.current.focus();
            }
          }, 100);
        }
        return;
      }
      
      // Enter: Submit form only if chat is open and input is focused
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && (isChatPaneVisible || highlightChatVisible)) {
        const activeElement = document.activeElement;
        if (activeElement === inputRef.current && prompt.trim() && !isStreaming) {
          console.log('[Keyboard] Enter detected for', highlightChatVisible ? 'highlight chat' : 'regular chat', ', submitting form');
          e.preventDefault();
          handleSubmit(e as any);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isChatPaneVisible, highlightChatVisible, prompt, isStreaming, handleSubmit, agentMode, isHighlightMode, isLiveMode, audioHandleRef]);

  // Cleanup audio streaming on unmount
  useEffect(() => {
    return () => {
      if (audioHandleRef.current) {
        audioHandleRef.current.stop();
      }
    };
  }, []);

  // Toggle overlay interactivity based on hover over specific regions only
  useEffect(() => {
    let overMainbar = false;
    let overInputArea = false;
    let overChatPane = false;
    let overHighlightScroll = false;
    let blurTimeout: any = null;

    const applyState = () => {
      const inputFocused = document.activeElement === inputRef.current;
      // Check if any agent input is focused
      const agentInputFocused = document.activeElement?.tagName === 'TEXTAREA' && 
                               (document.activeElement.className.includes('dark-input') || 
                                document.activeElement.closest('.agent-input-area'));
      // Don't force focus just because we're in agent mode - only when actually interacting
      const shouldFocus = isLiveMode || overMainbar || overInputArea || overChatPane || overHighlightScroll || inputFocused || agentInputFocused;
      if (shouldFocus) {
        window.ipcRenderer.send('chat:focus');
      } else {
        if (blurTimeout) clearTimeout(blurTimeout);
        blurTimeout = setTimeout(() => {
          const stillFocused = document.activeElement === inputRef.current;
          const stillAgentFocused = document.activeElement?.tagName === 'TEXTAREA' && 
                                   (document.activeElement.className.includes('dark-input') || 
                                    document.activeElement.closest('.agent-input-area'));
          // Allow blur even in agent mode when not actively using UI
          if (!isLiveMode && !overMainbar && !overInputArea && !overChatPane && !overHighlightScroll && !stillFocused && !stillAgentFocused) {
            window.ipcRenderer.send('chat:blur');
          }
        }, 200);
      }
    };

    const mainbar = document.getElementById('mainbar');
    const inputAreas = document.querySelectorAll('.glass-chat-input-area');
    const chatPane = document.getElementById('chat-pane');
    const highlightScrollArea = highlightScrollRef.current;

    const onMainbarEnter = () => { overMainbar = true; applyState(); };
    const onMainbarLeave = () => { overMainbar = false; applyState(); };
    const onInputEnter = () => { overInputArea = true; applyState(); };
    const onInputLeave = () => { overInputArea = false; applyState(); };
    const onChatPaneEnter = () => { overChatPane = true; applyState(); };
    const onChatPaneLeave = () => { overChatPane = false; applyState(); };
    const onHighlightScrollEnter = () => { overHighlightScroll = true; applyState(); };
    const onHighlightScrollLeave = () => { overHighlightScroll = false; applyState(); };

    const onInputFocus = () => { applyState(); };
    const onInputBlur = () => { applyState(); };

    mainbar?.addEventListener('pointerenter', onMainbarEnter);
    mainbar?.addEventListener('pointerleave', onMainbarLeave);
    
    // Add listeners to all input areas (both ask and agent mode)
    inputAreas.forEach(area => {
      area.addEventListener('pointerenter', onInputEnter);
      area.addEventListener('pointerleave', onInputLeave);
    });
    
    chatPane?.addEventListener('pointerenter', onChatPaneEnter);
    chatPane?.addEventListener('pointerleave', onChatPaneLeave);
    highlightScrollArea?.addEventListener('pointerenter', onHighlightScrollEnter);
    highlightScrollArea?.addEventListener('pointerleave', onHighlightScrollLeave);

    const inputEl = inputRef.current;
    inputEl?.addEventListener('focus', onInputFocus);
    inputEl?.addEventListener('blur', onInputBlur);

    return () => {
      mainbar?.removeEventListener('pointerenter', onMainbarEnter);
      mainbar?.removeEventListener('pointerleave', onMainbarLeave);
      
      // Remove listeners from all input areas
      inputAreas.forEach(area => {
        area.removeEventListener('pointerenter', onInputEnter);
        area.removeEventListener('pointerleave', onInputLeave);
      });
      
      chatPane?.removeEventListener('pointerenter', onChatPaneEnter);
      chatPane?.removeEventListener('pointerleave', onChatPaneLeave);
      highlightScrollArea?.removeEventListener('pointerenter', onHighlightScrollEnter);
      highlightScrollArea?.removeEventListener('pointerleave', onHighlightScrollLeave);
      inputEl?.removeEventListener('focus', onInputFocus);
      inputEl?.removeEventListener('blur', onInputBlur);
      if (blurTimeout) clearTimeout(blurTimeout);
    };
  }, [agentMode, isChatPaneVisible]);

  // Emergency stop keyboard shortcut (Cmd+Shift+X)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === 'X') {
        console.log('[App] Emergency stop shortcut triggered (Cmd+Shift+X)');
        e.preventDefault();
        window.ipcRenderer.send("emergency-stop-monitoring");
        setAgentMode("chat");
        alert('Emergency stop: All browser monitoring stopped');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [setAgentMode]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const menuContainer = target.closest('.relative');
      const isMenuButton = target.closest('[title="Menu"]');
      const isMenuDropdown = target.closest('.absolute.right-0.top-full');
      
      // Close menu if clicking outside the entire menu component
      if (!menuContainer && !isMenuButton && !isMenuDropdown) {
        setIsMenuOpen(false);
      }
    };

    if (isMenuOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [isMenuOpen]);

  // When streaming ends, animate typewriter for chat mode
  useEffect(() => {
    if (!isStreaming && agentMode === 'chat' && typewriterFullText) {
      const full = typewriterFullText.trim();
      setTypewriterText("");
      const tokens = full.split(/(\s+)/); // keep spaces as tokens
      let idx = 0;

      const clearTimer = () => {
        if (typewriterTimerRef.current) {
          clearTimeout(typewriterTimerRef.current as any);
          typewriterTimerRef.current = null;
        }
      };

      const step = () => {
        idx += 2; // reveal a word + its following space (if any)
        setTypewriterText(tokens.slice(0, idx).join(""));
        if (idx >= tokens.length) {
          clearTimer();
          return;
        }
        const justAdded = tokens[idx - 2] || ""; // the last word we appended
        // Base delay and natural pauses
        let delay = 50; // tiny bit faster default pace per word
        if (/[.!?]$/.test(justAdded)) delay = 200; // longer pause at sentence ends
        else if (/[,:;]$/.test(justAdded)) delay = 120; // medium pause at clause breaks
        typewriterTimerRef.current = setTimeout(step, delay) as any;
      };

      clearTimer();
      step();

      return clearTimer;
    }
    return () => {
      if (typewriterTimerRef.current) {
        clearTimeout(typewriterTimerRef.current as any);
        typewriterTimerRef.current = null;
      }
    };
  }, [isStreaming, agentMode, typewriterFullText]);

  // Clean and simple - no complex message handling

  return (
    <div className="w-full h-full flex flex-col bg-transparent">
      {/* Main bar - fixed at top */}
      <div className="flex-none flex items-center justify-center pt-1 pb-2">
        <div id="mainbar" className="mainbar-glass rounded-full font-sans w-[26vw] h-[5vh] max-w-[26vw] max-h-[5vh] px-3 pointer-events-auto app-region-drag" style={{ overflow: 'visible' }}>
        {/* Draggable areas on the sides */}
        <div className="absolute left-0 top-0 w-6 h-full app-region-drag pointer-events-auto"></div>
        <div className="absolute right-0 top-0 w-6 h-full app-region-drag pointer-events-auto"></div>
        <div className="flex items-center justify-center gap-1 w-full h-full relative z-10">
          {/* Left - Chat button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              
              // Close other modes when opening Ask mode
              if (isLiveMode) {
                console.log('[Ask Button] Closing Live mode to open Ask mode');
                // Stop audio streaming
                if (audioHandleRef.current) {
                  audioHandleRef.current.stop();
                  audioHandleRef.current = null;
                }
                setIsLiveMode(false);
                localStorage.removeItem('opus-meeting-mode');
                setMeetingChats([]);
                setMessages([]);
                setCurrentStream("");
                window.ipcRenderer.send("stop-conversation-mode");
              }
              if (isHighlightMode) {
                console.log('[Ask Button] Closing Select mode to open Ask mode');
                setIsHighlightMode(false);
                setHighlightedImage(null);
                window.ipcRenderer.send("cancel-screen-highlight");
              }
              
              // If agent mode is active, close it and switch to ask mode
              if (agentMode === "agent") {
                setAgentMode("chat");
                setIsChatPaneVisible(true);
                setHighlightChatVisible(false);
                // Focus input when opening ask mode
                window.ipcRenderer.send('chat:focus');
                setTimeout(() => inputRef.current?.focus(), 100);
              } else {
                // Already in chat mode, toggle ask pane
                const willOpen = !isChatPaneVisible;
                setIsChatPaneVisible(willOpen);
                setHighlightChatVisible(false);
                if (willOpen) {
                  // Focus input when opening chat and enable interaction
                  window.ipcRenderer.send('chat:focus');
                  setTimeout(() => inputRef.current?.focus(), 100);
                }
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium transition-all duration-300 ease-in-out h-7 px-2 ${
               agentMode === "chat" && isChatPaneVisible && !isLiveMode ? 'bg-secondary text-secondary-foreground shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
             } ${
               isStreaming && agentMode === "chat" && !isLiveMode ? 'bg-green-600 text-white shadow-xs animate-pulse' : ''
             }`} data-active={agentMode === 'chat' && isChatPaneVisible && !isLiveMode}
            title={
              agentMode === "chat" && isStreaming ? "AI is thinking..." : 
              agentMode === "agent" ? "Switch to Ask Mode (⌘+↵)" :
              isChatPaneVisible && !isLiveMode ? "Close Ask Mode (⌘+↵)" : "Open Ask Mode (⌘+↵)"
            }
          >
            <span>Ask</span>
            {isChatPaneVisible && !isLiveMode ? (
              <>
                {/* Close icon */}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18"/>
                  <path d="m6 6 12 12"/>
                </svg>
              </>
            ) : (
              <>
                            {/* Command key icon */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
            </svg>
            {/* Enter key icon */}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 10 4 15 9 20"/>
              <path d="M20 4v7a4 4 0 0 1-4 4H4"/>
            </svg>
              </>
            )}
          </button>

          {/* Draggable spacer */}
          <div className="w-1 h-full app-region-drag pointer-events-auto"></div>

                    {/* Agent button - NanoBrowser integration */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Agent Button] Clicked! Current state - agentMode:', agentMode, 'isChatPaneVisible:', isChatPaneVisible);
              
              // Close other modes when opening Agent mode
              if (isLiveMode && agentMode !== "agent") {
                console.log('[Agent Button] Closing Live mode to open Agent mode');
                // Stop audio streaming
                if (audioHandleRef.current) {
                  audioHandleRef.current.stop();
                  audioHandleRef.current = null;
                }
                setIsLiveMode(false);
                localStorage.removeItem('opus-meeting-mode');
                setMeetingChats([]);
                setMessages([]);
                setCurrentStream("");
                window.ipcRenderer.send("stop-conversation-mode");
              }
              if (isHighlightMode && agentMode !== "agent") {
                console.log('[Agent Button] Closing Select mode to open Agent mode');
                setIsHighlightMode(false);
                setHighlightedImage(null);
                window.ipcRenderer.send("cancel-screen-highlight");
              }
              
              if (agentMode === "agent") {
                console.log('[Agent Button] Closing Agent mode');
                setAgentMode("chat");
                setIsChatPaneVisible(false);
              } else {
                console.log('[Agent Button] Switching from Ask to Agent mode');
                setAgentMode("agent");
                setIsChatPaneVisible(false); // Close ask pane
                setHighlightChatVisible(false); // Close highlight chat if open
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium transition-all duration-300 ease-in-out h-7 px-2 ${
              agentMode === "agent" ? 'bg-secondary text-secondary-foreground shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
            }`} data-active={agentMode === 'agent'}
            title={agentMode === "agent" ? "Chrome Agent Active (⌘+Option)" : "Activate Chrome Agent (⌘+Option)"}
          >
            <span>Agent</span>
          </button>

          {/* Draggable spacer */}
          <div className="w-1 h-full app-region-drag pointer-events-auto"></div>

          {/* NEW: Screen Highlight button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Highlight Button] Clicked! isHighlightMode:', isHighlightMode);
              if (isHighlightMode || highlightChatVisible) {
                // Cancel highlight mode and close highlight chat
                setIsHighlightMode(false);
                setHighlightedImage(null);
                setHighlightChatVisible(false);
                // Send cancel signal to close the highlight overlay
                window.ipcRenderer.send("cancel-screen-highlight");
              } else {
                // Close other modes when opening Select mode
                if (isLiveMode) {
                  console.log('[Select Button] Closing Live mode to open Select mode');
                  // Stop audio streaming
                  if (audioHandleRef.current) {
                    audioHandleRef.current.stop();
                    audioHandleRef.current = null;
                  }
                  setIsLiveMode(false);
                  localStorage.removeItem('opus-meeting-mode');
                  setMeetingChats([]);
                  setMessages([]);
                  setCurrentStream("");
                  window.ipcRenderer.send("stop-conversation-mode");
                }
                if (agentMode === "agent") {
                  console.log('[Select Button] Closing Agent mode to open Select mode');
                  setAgentMode("chat");
                  setIsChatPaneVisible(false);
                }
                if (agentMode === "chat" && isChatPaneVisible) {
                  console.log('[Select Button] Closing Ask mode to open Select mode');
                  setIsChatPaneVisible(false);
                }
                // Start screen highlighting
                setIsHighlightMode(true);
                window.ipcRenderer.send("start-screen-highlight");
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium transition-all h-7 px-2 ${
              isHighlightMode ? 'bg-blue-600 text-white shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
            }`}
            title={isHighlightMode ? "Cancel Highlight (ESC or ⌘+Delete)" : "Highlight & Ask (⌘+Delete)"}
          >
            <span>Select</span>
          </button>

          {/* Draggable spacer */}
          <div className="w-1 h-full app-region-drag pointer-events-auto"></div>

          {/* Listen button */}
           <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Microphone Button] Clicked! isLiveMode:', isLiveMode);
              console.log('[Microphone Button] Event target:', e.target);
              console.log('[Microphone Button] Current target:', e.currentTarget);
              console.log('[Microphone Button] Button element classes:', e.currentTarget.className);
              console.log('[Microphone Button] Is same element?', e.target === e.currentTarget);
              
              // Remove the rapid click prevention that's causing double-click issue
              
                                      if (isLiveMode) {
                console.log('[Microphone Button] Stopping live mode');
                // Stop audio streaming
                if (audioHandleRef.current) {
                  audioHandleRef.current.stop();
                  audioHandleRef.current = null;
                }
                setIsLiveMode(false);
                // Clear meeting mode flag
                localStorage.removeItem('opus-meeting-mode');
                // Clear meeting chats immediately to prevent flash
                setMeetingChats([]);
                // Always hide chat pane when stopping listen mode
                setIsChatPaneVisible(false);
                setMessages([]);
                setCurrentStream("");
                window.ipcRenderer.send("stop-conversation-mode");
                console.log('[Microphone Button] Stop sequence complete');
              } else {
                // Close other modes when opening Listen mode
                if (isHighlightMode) {
                  console.log('[Listen Button] Closing Select mode to open Listen mode');
                  setIsHighlightMode(false);
                  setHighlightedImage(null);
                  window.ipcRenderer.send("cancel-screen-highlight");
                }
                if (agentMode === "agent") {
                  console.log('[Listen Button] Closing Agent mode to open Listen mode');
                  setAgentMode("chat");
                  setIsChatPaneVisible(false);
                }
                if (agentMode === "chat" && isChatPaneVisible) {
                  console.log('[Listen Button] Closing Ask mode to open Listen mode');
                  setIsChatPaneVisible(false);
                }
                
                console.log('[Microphone Button] Starting live mode');
                setIsLiveMode(true);
                setIsChatPaneVisible(true);
                // DON'T change agent mode when starting live mode
                
                // Set meeting mode flag for audio capture
                localStorage.setItem('opus-meeting-mode', 'true');
                
                // Start LiveAudioService in main process
                window.ipcRenderer.send("start-conversation-mode", "live");
                
                                 // Start audio streaming in renderer (Clonely-style)
                 startAudioStreaming((chunk) => {
                   // Send audio chunks to main process
                   console.log('[AudioStreaming] Sending chunk to main process, size:', chunk.length);
                   window.ipcRenderer.send("live-audio-chunk", chunk);
                                  }).then(({ handle }) => {
                   audioHandleRef.current = handle;
                   console.log('[AudioStreaming] ✅ Audio streaming started successfully');
                 }).catch((error) => {
                   console.error('[AudioStreaming] ❌ Failed to start audio streaming:', error);
                   console.error('[AudioStreaming] Error details:', error.message);
                   console.error('[AudioStreaming] Stack trace:', error.stack);
                   alert('Failed to start audio capture: ' + error.message);
                   setIsLiveMode(false); // Revert on failure
                   localStorage.removeItem('opus-meeting-mode'); // Clear flag on failure
                 });
                
                console.log('[Microphone Button] Start sequence initiated');
              }
            }}
            className={`liquid-button liquid-button--mic inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium transition-all h-7 px-2 ${
               isLiveMode ? 'bg-destructive text-white shadow-xs hover:bg-destructive/90' : 'hover:bg-accent hover:text-accent-foreground'
             }`} data-live={isLiveMode}
            title={isLiveMode ? "Stop Live Feedback (⌘+Shift)" : "Start Live Feedback (⌘+Shift)"}
          >
            <span>Listen</span>
             <span className="eq" aria-hidden="true" style={{alignSelf:'center'}}><span></span><span></span><span></span></span>
          </button>

          {/* Draggable spacer */}
          <div className="w-1 h-full app-region-drag pointer-events-auto"></div>

          {/* 3-dots menu */}
          <div
            className="relative app-region-no-drag pointer-events-auto"
            style={{ 
              pointerEvents: 'auto', 
              zIndex: 100,
              overflow: 'visible'
            }}
            onMouseEnter={() => {
              console.log('[Menu Container] Mouse entered');
              if (menuCloseTimerRef.current) {
                clearTimeout(menuCloseTimerRef.current as any);
                menuCloseTimerRef.current = null;
              }
            }}
            onMouseLeave={() => {
              console.log('[Menu Container] Mouse left');
              if (menuCloseTimerRef.current) {
                clearTimeout(menuCloseTimerRef.current as any);
              }
              menuCloseTimerRef.current = setTimeout(() => setIsMenuOpen(false), 500) as any;
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('[Menu Button] Clicked! Current state:', isMenuOpen);
                setIsMenuOpen(!isMenuOpen);
              }}
              onMouseEnter={() => {
                console.log('[Menu Button] Mouse entered');
                setIsMenuOpen(true);
              }}
              className="liquid-button inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium h-7 px-2 app-region-no-drag pointer-events-auto relative z-50"
              title="Menu"
              style={{ pointerEvents: 'auto' }}
            >
              <svg width="14" height="18" viewBox="0 0 4 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                 <circle cx="2" cy="2" r="1" fill="currentColor"/>
                 <circle cx="2" cy="8" r="1" fill="currentColor"/>
                 <circle cx="2" cy="14" r="1" fill="currentColor"/>
               </svg>
            </button>

            {/* Dropdown menu */}
            {/* Debug: Menu state = {isMenuOpen ? 'OPEN' : 'CLOSED'} */}
            {isMenuOpen && (
              <div 
                className="absolute right-0 top-[calc(100%+8px)] w-28 rounded-md liquid-panel shadow-xl pointer-events-auto"
                style={{ 
                  position: 'absolute',
                  pointerEvents: 'auto',
                  zIndex: 999999,
                  background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 50%, rgba(255, 255, 255, 0.15) 100%)',
                  border: '0.5px solid rgba(255, 255, 255, 0.3)',
                  backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                  boxShadow: '0 8px 32px rgba(31, 38, 135, 0.15), 0 4px 16px rgba(255, 255, 255, 0.1) inset'
                }}
              >
                {/* Hide option */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log('[Hide Button] Clicked!');
                    window.ipcRenderer.send("minimize-window");
                    setIsMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-white flex items-center gap-2 transition-all hover:bg-white/10 rounded-md"
                  title="Hide (⌘+⌫)"
                >
                  <span>Hide <span className="ml-1 text-[10px] text-white">⌘⌫</span></span>
                </button>

                {/* Quit option */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    window.close();
                    setIsMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-white flex items-center gap-2 transition-all hover:bg-white/10 rounded-md"
                  title="Quit App"
                >
                  <span>Quit</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18"/>
                    <path d="m6 6 12 12"/>
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>

      {/* Content area - flex grow to fill space */}
      <div className="flex-1 flex flex-col items-center justify-start">
        {/* Select Mode UI - positioned under main bar */}
      {isHighlightMode && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 flex items-center gap-4 z-40 pointer-events-auto">
          {/* Drag to select button */}
          <button 
            className="flex items-center gap-2 px-4 py-3 text-white text-sm rounded-xl transition-all hover:bg-white/10 pointer-events-auto"
            style={{
              background: 'rgba(0, 0, 0, 0.3)',
              backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
              border: '0.5px solid rgba(255, 255, 255, 0.3)',
            }}
          >
            <span>Drag to select</span>
          </button>

          {/* Cancel button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Select Cancel Button] Clicked!');
              setIsHighlightMode(false);
              setHighlightedImage(null);
              window.ipcRenderer.send("cancel-screen-highlight");
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onMouseUp={(e) => {
              e.stopPropagation();
            }}
            className="flex items-center gap-2 px-5 py-3 text-white text-sm rounded-xl transition-all hover:bg-red-600/20 pointer-events-auto cursor-pointer"
            style={{
              background: 'rgba(220, 38, 38, 0.15)',
              backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
              border: '0.5px solid rgba(220, 38, 38, 0.4)',
            }}
          >
            <span>Cancel</span>
          </button>
        </div>
      )}

      {/* AI Pane - Stays open when agent is working */}
      <div id="chat-pane" className={`overflow-hidden liquid-animate ${
        (isChatPaneVisible || isStreaming || messages.length > 0 || highlightChatVisible || meetingChats.length > 0) ? 'max-h-[25vh] opacity-100 liquid-open' : 'max-h-0 opacity-0 liquid-closed'
      } px-4 ${isLiveMode ? 'w-[70vw]' : 'w-[40vw]'} pointer-events-auto`}>
        <div className={`max-h-full w-full bg-transparent p-2 gap-3 ${isLiveMode ? 'meeting-panels' : 'flex'}`}>
          {/* Left Panel - Transcript (only in live mode) - CENTERED by default */}
          {isLiveMode && (
            <div className={`flex-shrink-0 w-[420px] min-w-[380px] max-w-[440px] mx-auto`}>
              <listen-view ref={listenViewRef as any} style={{ display: 'block', width: '100%' }}></listen-view>
            </div>
          )}

          {/* Right side: Meeting chats (when in live mode) or regular chat/highlight */}
          {(meetingChats.length > 0 || isLiveMode) && meetingChats.length > 0 && (
            <div className={`flex-1 flex flex-col h-full gap-2 min-w-0 text-sm sidebar-panel items-start`}>
              {/* Meeting Action Chat Threads */}
              <div className="flex flex-col gap-2 w-full max-w-[400px]" style={{ overflow: 'visible' }}>
                {meetingChats.map((chat) => (
                  <div 
                    key={chat.id} 
                    className="liquid-panel rounded-lg p-3 relative action-chat-panel" 
                    style={{ 
                      background: 'rgba(52, 199, 89, 0.1)',
                      backdropFilter: 'blur(8px) saturate(250%) contrast(150%) brightness(115%)',
                      WebkitBackdropFilter: 'blur(8px) saturate(250%) contrast(150%) brightness(115%)',
                      height: 'auto',
                      minHeight: '80px',
                      overflow: 'visible',
                      overflowWrap: 'break-word',
                      wordBreak: 'break-word'
                    }}>
                    <button
                      className="absolute top-2 right-2 text-white hover:text-white z-10"
                      onClick={() => setMeetingChats((prev) => prev.filter((c) => c.id !== chat.id))}
                      title="Close"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18"/>
                        <path d="m6 6 12 12"/>
                      </svg>
                    </button>
                    <div className="font-semibold mb-2 text-white pr-6 text-sm">{chat.title}</div>
                    

                    
                    {/* Show saved messages */}
                    {chat.messages.map((m, i) => (
                      <div key={i} className="mb-3 text-white text-sm leading-relaxed break-words">
                        {m.content.replace(/^["']|["']$/g, '')}
                      </div>
                    ))}
                    
                    {/* Show streaming content or thinking state */}
                    {chat.streaming && (
                      <div className="text-white text-sm leading-relaxed break-words">
                        {chat.currentStream ? (
                          <>
                            {chat.currentStream}
                            <span className="inline-block w-0.5 h-4 bg-white ml-1 animate-pulse"></span>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 text-white">
                            <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span>Thinking...</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Highlight Chat Content (when active) - Same size as regular chat */}
            {highlightChatVisible && highlightedImage && (
              <div className="flex-1 flex flex-col h-full gap-2 min-w-0 text-sm max-h-[25vh] pointer-events-auto mx-auto" style={{ width: '420px', minWidth: '380px', maxWidth: '440px' }}>
                <div className="flex-1 liquid-panel rounded-2xl flex flex-col overflow-hidden">
                  {/* Header with close button */}
                  <div className="glass-chat-header px-4 pt-3 pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Small screenshot thumbnail */}
                        <img 
                          src={`data:image/png;base64,${highlightedImage}`}
                          alt="Screenshot"
                          className="rounded-md border border-white/20"
                          style={{ 
                            width: '24px', 
                            height: '24px',
                            objectFit: 'cover'
                          }}
                        />
                      </div>
                      {/* Close button */}
                      <button
                        onClick={() => {
                          setHighlightChatVisible(false);
                          setHighlightedImage(null);
                          setIsHighlightMode(false);
                          setMessages([]);
                          setCurrentStream("");
                        }}
                        className="text-white hover:text-white transition-colors p-1 rounded hover:bg-white/10"
                        title="Close"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18"/>
                          <path d="m6 6 12 12"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                  
                  <div 
                    ref={highlightScrollRef}
                    className="flex-1 glass-chat-content text-sm leading-relaxed" 
                    style={{ 
                      maxHeight: 'calc(75vh - 140px)',
                      minHeight: '300px',
                      overflowY: 'auto',
                      overflowX: 'hidden',
                      pointerEvents: 'auto',
                      scrollBehavior: 'smooth'
                    }}
                    onMouseEnter={() => {
                      window.ipcRenderer.send('chat:focus');
                    }}
                    onWheel={(e) => {
                      e.stopPropagation();
                      window.ipcRenderer.send('chat:focus');
                    }}
                    onScroll={(e) => {
                      e.stopPropagation();
                      window.ipcRenderer.send('chat:focus');
                    }}
                  >
                    {/* Chat messages for highlight */}
                    {messages.map((msg, i) => (
                      <div
                        key={i}
                        className={`mb-3 p-3 rounded-xl liquid-panel text-white`}
                      >
                        <div className="whitespace-pre-wrap">{msg.message}</div>
                      </div>
                    ))}

                    {(isStreaming || currentStream) && (
                      <div className="p-3 rounded-xl liquid-panel text-white">
                        <div className="font-semibold mb-1">
                          {isStreaming ? "Analyzing..." : "Response"}
                        </div>
                        <div className="whitespace-pre-wrap">
                          {currentStream}
                          {isStreaming && (
                            <span className="inline-block w-0.5 h-4 bg-white ml-1 animate-pulse"></span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Typewriter reveal in highlight mode */}
                    {!isStreaming && highlightChatVisible && typewriterText && (
                      <div className="p-3 rounded-xl liquid-panel text-white">
                        <div className="font-semibold mb-1">Response</div>
                        <div className="whitespace-pre-wrap">{typewriterText}</div>
                      </div>
                    )}
                    
                    <div ref={messagesEndRef} />
                  </div>
                  
                  {/* Input Area - Fixed at the bottom of the panel */}
                  <div className="border-t border-white/10 p-3 bg-white/[0.02] glass-chat-input-area">
                    <form onSubmit={handleSubmit} className="relative">
                      <input
                        ref={inputRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Ask about the screenshot..."
                        disabled={isStreaming}
                        onFocus={() => {
                          window.ipcRenderer.send('chat:focus');
                          if (inputRef.current) {
                            inputRef.current.style.pointerEvents = 'auto';
                          }
                        }}
                        className="dark-input pr-14 app-region-no-drag w-full"
                      />
                      <div className="absolute right-4 top-1/2 -translate-y-1/2">
                        <div className="flex gap-2 items-center">
                          <div className="flex gap-1 items-center opacity-70">
                            <span className="text-xs">↵</span>
                            <span className="text-xs">send</span>
                          </div>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            )}
            
            {/* Regular Chat/Command Content - Hidden, we'll show just the input bar below */}

          </div>
        </div>

      </div>

      {/* Input bars - positioned right under main bar */}
      <div className="fixed top-11 left-1/2 transform -translate-x-1/2 z-40">
        {/* Ask Input Bar - exactly like agent mode */}
        {agentMode === "chat" && isChatPaneVisible && !isLiveMode && !highlightChatVisible && (
          <div className="pointer-events-auto" style={{ width: '420px', minWidth: '380px', maxWidth: '440px' }}>
            <div className="glass-chat-input-area">
              <AskAgent />
            </div>
          </div>
        )}

        {/* Agent Input Bar - just the input bar */}
        {agentMode === "agent" && (
          <div className="pointer-events-auto" style={{ width: '420px', minWidth: '380px', maxWidth: '440px' }}>
            <div className="glass-chat-input-area">
              {isChromeActive ? <ChromeAgent /> : <MacOSAgent />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
