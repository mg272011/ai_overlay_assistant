import { useCallback, useEffect, useRef, useState } from "react";
import { startAudioStreaming, AudioStreamHandle } from "./lib/liveAudioStream";
// Glass web components UI
import "./glass-ui/listen/ListenView.js";

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
  const lastMicClickRef = useRef<number>(0);
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
  
  // Agent mode state (Regular vs Collab)
  const [agentMode, setAgentMode] = useState<"chat" | "agent">("chat");
  
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
          } else if (data.type === 'stream_end') {
            chat.streaming = false;
            if (chat.currentStream.trim()) {
              // For say-next, replace instead of stacking
              if ((chat as any).sayNext) {
                chat.messages = [{ role: 'assistant', content: chat.currentStream.trim() }];
              } else {
                chat.messages.push({ role: 'assistant', content: chat.currentStream.trim() });
              }
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
              } else if (agentMode === 'chat') {
                // Use typewriter for chat mode instead of pasting immediately
                setTypewriterFullText(messageContent);
              } else {
                setMessages((prev) => {
                  const newMessage = { type: "assistant", message: messageContent };
                  console.log('[App] Adding message to array:', newMessage);
                  return [...prev, newMessage];
                });
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
    // Send toggle event to main process - this handles all virtual cursor management
    window.ipcRenderer.send("toggle-collab-mode", agentMode === "agent");
    
    // Legacy show/hide cursor calls removed to prevent conflicts with toggle-collab-mode
    // The virtual cursor is now managed entirely through toggle-collab-mode
  }, [agentMode]);

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
              ? { ...c, messages: [], streaming: true, currentStream: '' }
              : c
            );
          }
          console.log('[App] Creating new say-next chat:', id);
          return [...prev, { id, title, messages: [], streaming: true, currentStream: '', ...( { sayNext: true } as any) } as any];
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
  }, [isChatPaneVisible, highlightChatVisible, prompt, isStreaming, handleSubmit]);

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
    let blurTimeout: any = null;

    const applyState = () => {
      const inputFocused = document.activeElement === inputRef.current;
      const shouldFocus = isLiveMode || overMainbar || overInputArea || overChatPane || inputFocused;
      if (shouldFocus) {
        window.ipcRenderer.send('chat:focus');
      } else {
        if (blurTimeout) clearTimeout(blurTimeout);
        blurTimeout = setTimeout(() => {
          const stillFocused = document.activeElement === inputRef.current;
          if (!isLiveMode && !overMainbar && !overInputArea && !overChatPane && !stillFocused) {
            window.ipcRenderer.send('chat:blur');
          }
        }, 200);
      }
    };

    const mainbar = document.getElementById('mainbar');
    const inputArea = document.querySelector('.glass-chat-input-area') as HTMLElement | null;
    const chatPane = document.getElementById('chat-pane');

    const onMainbarEnter = () => { overMainbar = true; applyState(); };
    const onMainbarLeave = () => { overMainbar = false; applyState(); };
    const onInputEnter = () => { overInputArea = true; applyState(); };
    const onInputLeave = () => { overInputArea = false; applyState(); };
    const onChatPaneEnter = () => { overChatPane = true; applyState(); };
    const onChatPaneLeave = () => { overChatPane = false; applyState(); };

    const onInputFocus = () => { applyState(); };
    const onInputBlur = () => { applyState(); };

    mainbar?.addEventListener('pointerenter', onMainbarEnter);
    mainbar?.addEventListener('pointerleave', onMainbarLeave);
    inputArea?.addEventListener('pointerenter', onInputEnter);
    inputArea?.addEventListener('pointerleave', onInputLeave);
    chatPane?.addEventListener('pointerenter', onChatPaneEnter);
    chatPane?.addEventListener('pointerleave', onChatPaneLeave);

    const inputEl = inputRef.current;
    inputEl?.addEventListener('focus', onInputFocus);
    inputEl?.addEventListener('blur', onInputBlur);

    return () => {
      mainbar?.removeEventListener('pointerenter', onMainbarEnter);
      mainbar?.removeEventListener('pointerleave', onMainbarLeave);
      inputArea?.removeEventListener('pointerenter', onInputEnter);
      inputArea?.removeEventListener('pointerleave', onInputLeave);
      chatPane?.removeEventListener('pointerenter', onChatPaneEnter);
      chatPane?.removeEventListener('pointerleave', onChatPaneLeave);
      inputEl?.removeEventListener('focus', onInputFocus);
      inputEl?.removeEventListener('blur', onInputBlur);
      if (blurTimeout) clearTimeout(blurTimeout);
    };
  }, []);

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

  return (
    <div className="w-full h-full flex flex-col items-center justify-start gap-1 pt-2 bg-transparent pointer-events-none relative">
      {/* Clonely-style Mainbar */}
      <div id="mainbar" className="glass mainbar-glass liquid-frost rounded-full font-sans flex-none w-[28vw] h-[5.5vh] max-w-[28vw] max-h-[5.5vh] px-2 pointer-events-auto">
                  <div className="flex items-center justify-center gap-1.5 w-full h-full">
          {/* Left - Chat button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Chat Button] Clicked! isChatPaneVisible:', isChatPaneVisible);
              
              // Close highlight mode if active
              if (isHighlightMode) {
                setIsHighlightMode(false);
                setHighlightedImage(null);
                window.ipcRenderer.send("cancel-screen-highlight");
              }
              
              setAgentMode("chat"); // Set to chat mode
              const willOpen = !isChatPaneVisible;
              setIsChatPaneVisible(willOpen);
              setHighlightChatVisible(false); // Close highlight chat if open
              if (willOpen) {
                // Focus input when opening chat and enable interaction
                window.ipcRenderer.send('chat:focus');
                setTimeout(() => inputRef.current?.focus(), 100);
              } else {
                // When closing chat, keep overlay interactive; CSS handles pass-through
                // No chat:blur here to avoid losing interactivity for reopening
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all h-8 px-3 ${
               agentMode === "chat" && isChatPaneVisible && !isLiveMode ? 'bg-secondary text-secondary-foreground shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
             } ${
               isStreaming && agentMode === "chat" && !isLiveMode ? 'bg-green-600 text-white shadow-xs animate-pulse' : ''
             }`} data-active={agentMode === 'chat' && isChatPaneVisible && !isLiveMode}
            title={agentMode === "chat" && isStreaming ? "AI is thinking..." : isChatPaneVisible && !isLiveMode ? "Close Chat (⌘+↵)" : "Open Chat Mode (Screen Analysis)"}
          >
            <span>Ask</span>
            {isChatPaneVisible && !isLiveMode ? (
              <>
                {/* Close icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18"/>
                  <path d="m6 6 12 12"/>
                </svg>
              </>
            ) : (
              <>
                {/* Command key icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
                </svg>
                {/* Enter key icon */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 10 4 15 9 20"/>
                  <path d="M20 4v7a4 4 0 0 1-4 4H4"/>
                </svg>
              </>
            )}
          </button>

          {/* Agent button - matches Chat button style */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Agent Button] Clicked! isChatPaneVisible:', isChatPaneVisible, 'agentMode:', agentMode);
              
              // Close highlight mode if active
              if (isHighlightMode) {
                setIsHighlightMode(false);
                setHighlightedImage(null);
                window.ipcRenderer.send("cancel-screen-highlight");
              }
              
              const willOpen = !(agentMode === "agent" && isChatPaneVisible);
              setIsChatPaneVisible(willOpen);
              setHighlightChatVisible(false); // Close highlight chat if open
              if (willOpen) {
                // Enter Agent mode and focus input
                setAgentMode("agent");
                window.ipcRenderer.send('chat:focus');
                setTimeout(() => inputRef.current?.focus(), 100);
              } else {
                // Exiting Agent mode: switch back to chat and keep overlay interactive for quick reopen
                setAgentMode("chat");
                // No blur here; keep focus state sticky for immediate reopen
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all h-8 px-3 ${
               agentMode === "agent" && isChatPaneVisible ? 'bg-secondary text-secondary-foreground shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
             } ${
               isStreaming && agentMode === "agent" ? 'bg-green-600 text-white shadow-xs animate-pulse' : ''
             }`} data-active={agentMode === 'agent' && isChatPaneVisible}
            title={agentMode === "agent" && isStreaming ? "Agent Working..." : "Open Agent Mode (Collaborative)"}
          >
            <span>Agent</span>
          </button>

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
                // Prevent opening highlight if another mode is active
                if (isLiveMode) {
                  console.log('[Highlight Button] Cannot open - live mode is active');
                  return;
                }
                // Start screen highlighting
                setIsHighlightMode(true);
                window.ipcRenderer.send("start-screen-highlight");
              }
            }}
            className={`liquid-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all h-8 px-3 ${
              isHighlightMode ? 'bg-blue-600 text-white shadow-xs' : 'hover:bg-accent hover:text-accent-foreground'
            }`}
            title={isHighlightMode ? "Cancel Highlight (ESC)" : "Highlight & Ask (Screen Selection)"}
          >
            <span>Select</span>
            {null}
          </button>



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
            className={`liquid-button liquid-button--mic inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all h-8 px-3 ${
               isLiveMode ? 'bg-destructive text-white shadow-xs hover:bg-destructive/90' : 'hover:bg-accent hover:text-accent-foreground'
             }`} data-live={isLiveMode}
            title={isLiveMode ? "Stop Live Feedback" : "Start Live Feedback"}
          >
            <span>Listen</span>
             <span className="eq" aria-hidden="true" style={{alignSelf:'center'}}><span></span><span></span><span></span></span>
          </button>



          {/* 3-dots menu */}
          <div
            className="relative"
            onMouseEnter={() => {
              if (menuCloseTimerRef.current) {
                clearTimeout(menuCloseTimerRef.current as any);
                menuCloseTimerRef.current = null;
              }
            }}
            onMouseLeave={() => {
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
                setIsMenuOpen(!isMenuOpen);
              }}
              onMouseEnter={() => setIsMenuOpen(true)}
              className="liquid-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium h-8 px-3"
              title="Menu"
            >
              <svg width="14" height="18" viewBox="0 0 4 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                 <circle cx="2" cy="2" r="1" fill="currentColor"/>
                 <circle cx="2" cy="8" r="1" fill="currentColor"/>
                 <circle cx="2" cy="14" r="1" fill="currentColor"/>
               </svg>
            </button>

            {/* Dropdown menu */}
            {isMenuOpen && (
              <div 
                className="absolute right-0 top-[calc(100%+12px)] w-28 rounded-md z-[9999] glass liquid-panel shadow-xl"
                style={{ position: 'absolute' }}
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
                  className="w-full text-left px-2 py-1.5 text-xs text-white/90 flex items-center gap-1 transition-colors"
                  title="Hide (⌘+⌫)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
                  </svg>
                                     <span>Hide <span className="ml-1 text-[10px] text-white/50">⌘⌫</span></span>
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
                  className="w-full text-left px-2 py-1.5 text-xs text-white/90 flex items-center gap-1 transition-colors"
                  title="Quit App"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18"/>
                    <path d="m6 6 12 12"/>
                  </svg>
                  <span>Quit</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AI Pane - Stays open when agent is working */}
      <div id="chat-pane" className={`overflow-hidden liquid-animate ${
        (isChatPaneVisible || isStreaming || messages.length > 0 || highlightChatVisible || meetingChats.length > 0) ? 'max-h-[70vh] opacity-100 liquid-open' : 'max-h-0 opacity-0 liquid-closed'
      } px-4 ${isLiveMode ? 'w-[60vw]' : 'w-[40vw]'} pointer-events-auto mx-auto mt-4`}>
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
              <div className="flex flex-col gap-2 w-[380px] min-w-[340px] max-w-[400px]">
                {meetingChats.map((chat) => (
                  <div key={chat.id} className="glass liquid-panel rounded-lg p-3 relative" style={{ 
                    background: 'rgba(52, 199, 89, 0.1)',
                    backdropFilter: 'blur(8px) saturate(250%) contrast(150%) brightness(115%)',
                    WebkitBackdropFilter: 'blur(8px) saturate(250%) contrast(150%) brightness(115%)'
                  }}>
                    <button
                      className="absolute top-2 right-2 text-white/70 hover:text-white z-10"
                      onClick={() => setMeetingChats((prev) => prev.filter((c) => c.id !== chat.id))}
                      title="Close"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18"/>
                        <path d="m6 6 12 12"/>
                      </svg>
                    </button>
                    <div className="font-semibold mb-2 text-white pr-6">{chat.title}</div>
                    {chat.messages.map((m, i) => (
                      <div key={i} className="mb-2 text-white whitespace-pre-wrap">{m.content.replace(/^["']|["']$/g, '')}</div>
                    ))}
                    {chat.currentStream && (
                      <div className="text-white whitespace-pre-wrap">
                        {chat.currentStream.replace(/^["']|["']$/g, '')}
                        {chat.streaming && <span className="inline-block w-0.5 h-4 bg-white ml-1 animate-pulse"></span>}
                      </div>
                    )}
                    {!chat.streaming && chat.messages.length === 0 && !chat.currentStream && (
                      <div className="text-white/60 text-sm">...</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Highlight Chat Content (when active) */}
            {highlightChatVisible && highlightedImage && (
              <div className="flex-1 glass liquid-panel rounded-2xl flex flex-col mt-4 relative min-h-0 pointer-events-auto">
                {/* Small X button in top right corner */}
                <button
                  onClick={() => {
                    setHighlightChatVisible(false);
                    setHighlightedImage(null);
                    setIsHighlightMode(false);
                    setMessages([]);
                    setCurrentStream("");
                    // cleared
                  }}
                  className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-gray-200 hover:bg-gray-300 transition-colors"
                  title="Close"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-gray-600">
                    <path d="M18 6 6 18"/>
                    <path d="m6 6 12 12"/>
                  </svg>
                </button>
                
                {/* Highlight Chat Header - text positioned lower */}
                <div className="liquid-subheader flex items-center justify-between px-4 pt-4 pb-4 rounded-t-2xl">
                  <div className="flex items-center gap-2 mt-4">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                      <circle cx="9" cy="9" r="2"/>
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                    </svg>
                    <span className="text-sm font-medium text-white/90">
                      Ask about highlighted content
                    </span>
                  </div>
                </div>
                
                <div id="highlight-scroll" ref={highlightScrollRef as any} className="flex-1 p-4 overflow-y-auto max-h-[65vh] scroll-smooth text-sm leading-relaxed pb-6">
                  {/* Show highlighted image */}
                  <div className="mb-4 p-3 liquid-panel rounded-xl">
                    <div className="font-semibold text-white/90 mb-3">Highlighted Content:</div>
                    <div className="flex justify-center">
                      <img 
                        src={`data:image/png;base64,${highlightedImage}`}
                        alt="Highlighted screen content"
                        className="rounded-xl border border-white/20 shadow-sm"
                        style={{ 
                          maxWidth: '300px', 
                          maxHeight: '150px',
                          objectFit: 'contain'
                        }}
                      />
                    </div>
                  </div>
                  
                  {/* Chat messages for highlight */}
                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`mb-3 p-3 rounded-xl liquid-panel text-white/90`}
                    >
                      <div className="text-sm whitespace-pre-wrap">{msg.message}</div>
                    </div>
                  ))}

                  {(isStreaming || currentStream) && (
                    <div className="p-3 rounded-xl liquid-panel">
                      <div className="font-semibold text-sm text-white/90 mb-1">
                        {isStreaming ? "Analyzing..." : "Response"}
                      </div>
                      <div className="text-sm text-white/90 whitespace-pre-wrap">
                        {currentStream}
                        {isStreaming && (
                          <span className="inline-block w-0.5 h-4 bg-white ml-1 animate-pulse"></span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Typewriter reveal in highlight mode (like regular chat) */}
                  {!isStreaming && highlightChatVisible && typewriterText && (
                    <div className="p-3 rounded-xl liquid-panel">
                      <div className="font-semibold text-sm text-white/90 mb-1">Response</div>
                      <div className="text-sm text-white/90 whitespace-pre-wrap">{typewriterText}</div>
                    </div>
                  )}

                  {!currentStream && messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center text-white/70 py-4">
                      <div className="text-center">
                        <p className="mb-3 text-white/90 font-medium">✨ Screenshot captured!</p>
                        <p className="mb-3 text-white/80">Type your question about this content:</p>
                        <div className="space-y-1 text-sm text-white/70">
                          <p>• "What does this mean?"</p>
                          <p>• "Explain this code"</p>
                          <p>• "Summarize this text"</p>
                          <p>• "How do I fix this error?"</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* Regular Chat/Command Content */}
          {!highlightChatVisible && !isLiveMode && (
            <div className="flex-1 flex flex-col h-full gap-2 min-w-0 text-sm max-h-[65vh] pointer-events-auto w-full">
              <div className="flex-1 glass-chat-container w-full">
               {/* Agent Status Bar with Mode Toggle */}
               <div className="glass-chat-header">
                 <div className="flex items-center justify-between">
                   <div className="flex items-center gap-3"></div>
                   {/* Close button */}
                   {!isStreaming && (
                     <button
                       onClick={() => {
                         setIsChatPaneVisible(false);
                         setMessages([]);
                         setCurrentStream("");
                         currentStreamRef.current = "";
                       }}
                       className="text-white/80 hover:text-white transition-colors p-1 rounded hover:bg-white/10"
                       title="Close chat"
                     >
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                         <path d="M18 6 6 18"/>
                         <path d="m6 6 12 12"/>
                       </svg>
                     </button>
                   )}
                 </div>
               </div>
               
               <div className="glass-chat-content">
                 {messages.map((msg, i) => (
                   <div key={i} className={`glass-message ${msg.type === "error" ? "error" : "assistant"}`}>
                     <div className="font-semibold mb-1">{msg.type.charAt(0).toUpperCase() + msg.type.slice(1)}</div>
                     <div className="whitespace-pre-wrap">{msg.message}</div>
                   </div>
                 ))}

                 {(agentMode === 'chat' && !isStreaming && typewriterText) ? (
                   <div className="glass-message streaming">
                     <div className="font-semibold mb-1">Response</div>
                     <div className="whitespace-pre-wrap">{typewriterText}</div>
                   </div>
                 ) : (isStreaming || currentStream) && (
                   <div className="glass-message streaming">
                     <div className="font-semibold mb-1">{isStreaming ? "Thinking..." : "Response"}</div>
                     <div className="whitespace-pre-wrap">
                       {agentMode === 'chat' && isStreaming ? null : currentStream}
                       {isStreaming && (<span className="inline-block w-0.5 h-4 bg-white ml-1 animate-pulse"></span>)}
                     </div>
                   </div>
                 )}

                 <div ref={messagesEndRef} />
               </div>
              </div>
            </div>
          )}
            
          {/* Input Area: hide during meeting live mode */}
            {!isLiveMode && (
              <div className="glass-chat-input-area">
                <form onSubmit={handleSubmit} className="relative">
                  <input
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      isStreaming
                        ? (agentMode === "chat" ? "Thinking..." : "Processing...")
                        : highlightChatVisible
                        ? "Ask about the screenshot..."
                        : isLiveMode
                        ? "Ask a follow-up..."
                        : agentMode === "agent"
                        ? "Ask me to help you with complex tasks..."
                        : "Chat with me or ask about your screen..."
                    }
                    disabled={isStreaming && agentMode !== "chat"}
                    onFocus={() => {
                      window.ipcRenderer.send('chat:focus');
                      if (inputRef.current) {
                        inputRef.current.style.pointerEvents = 'auto';
                      }
                    }}
                    className="glass-input pr-14 app-region-no-drag"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2">
                    <div className="flex gap-2 items-center">
                      {isChatPaneVisible ? (
                        <div className="flex gap-1 items-center opacity-70">
                          <span className="text-xs">↵</span>
                          <span className="text-xs">send</span>
                          <span className="mx-1">•</span>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>
                          <span className="text-xs">↵</span>
                          <span className="text-xs">close</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}

export default App;
