import { useCallback, useEffect, useRef, useState } from "react";
import { startAudioStreaming, AudioStreamHandle } from "./lib/liveAudioStream";
// Neatly web components UI
import "./glass-ui/listen/ListenView.js";
  // Agent Components
  import MacOSAgent from "./agents/MacOSAgent";
  import AskAgent, { AskAgentHandle } from "./agents/AskAgent";
  import AgentStatusBar from "./components/AgentStatusBar";

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
  const askAgentRef = useRef<AskAgentHandle>(null);
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
  
  // Chat panel state for Ask/Agent modes
  const [chatPanelVisible, setChatPanelVisible] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [currentResponse, setCurrentResponse] = useState<string>('');
  const [displayedResponse, setDisplayedResponse] = useState<string>('');
  
  // Agent status bar state (for agent mode only)
  const [agentStatusVisible, setAgentStatusVisible] = useState(false);
  const [agentUserMessage, setAgentUserMessage] = useState<string>('');
  
  // Accessibility permissions check
  const [showPermissionsDialog, setShowPermissionsDialog] = useState(false);
  const [hasCheckedPermissions, setHasCheckedPermissions] = useState(false);

  // Check accessibility permissions via IPC
  const checkAccessibilityPermissions = async () => {
    if (hasCheckedPermissions) return true;
    
    try {
      // Use IPC to check if accessibility is enabled
      const result = await window.ipcRenderer.invoke('check-accessibility-permissions');
      setHasCheckedPermissions(true);
      
      if (!result.enabled) {
        setShowPermissionsDialog(true);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Failed to check accessibility permissions:', error);
      // Don't block Chrome/web automation if check fails
      // since most web actions work without permissions now
      console.log('Proceeding anyway - most web actions work without permissions');
      return true;
    }
  };
  const [isTyping, setIsTyping] = useState(false);
  const [chatPanelMode, setChatPanelMode] = useState<'ask' | 'agent' | 'select'>('ask');
  const [selectImage, setSelectImage] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<Array<{role: 'user' | 'assistant', content: string, id: string, isTyping?: boolean}>>([]);
  const [displayedAgentText, setDisplayedAgentText] = useState<{[key: string]: string}>({});
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const currentAssistantMessageRef = useRef<string | null>(null);
  
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
  // Chrome agent state removed - using macOS agent only
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
  
  // Contextual search actions
  const [, setSearchItems] = useState<any[]>([]);

  // Menu dropdown state
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Double-press detection for listen mode
  const lastListenPressRef = useRef<number>(0);

  const [isRecording, setIsRecording] = useState(false);
  const [recordedCount, setRecordedCount] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isRecordArmed, setIsRecordArmed] = useState(false);
  
  // Clean state - no more chat window complexity
  
  // Debug menu state changes
  useEffect(() => {
    console.log('[Menu State Changed] isMenuOpen:', isMenuOpen);
  }, [isMenuOpen]);

  // Handle contextual search actions
  const handleContextualSearch = useCallback((_: any, data: any) => {
    console.log('[App] 🔍 ===== CONTEXTUAL SEARCH EVENT RECEIVED =====');
    console.log('[App] 🔍 Raw contextual search data:', JSON.stringify(data, null, 2));
    
    // Handle both array and object with searchItems property
    const items = Array.isArray(data) ? data : (data?.searchItems || data);
    console.log('[App] 🔍 Processed search items:', JSON.stringify(items, null, 2));
    
    if (Array.isArray(items) && items.length > 0) {
      // Format items properly
      const formattedItems = items.map((item: any, index: number) => ({
        id: item.id || `ctx-search-${Date.now()}-${index}`,
        text: item.text || item.query || 'Unknown search',
        query: item.query || item.text,
        type: item.type || 'search',
        confidence: item.confidence || 0.7
      }));
      
      setSearchItems(formattedItems);
      console.log('[App] 🔍 ✅ SET search items from ContextualActions:', JSON.stringify(formattedItems, null, 2));
      console.log('[App] 🔍 ✅ Current searchItems state after setting:', formattedItems.length);
    } else {
      console.log('[App] 🔍 ❌ No search items to display from ContextualActions - items:', items);
      console.log('[App] 🔍 ❌ Array.isArray(items):', Array.isArray(items));
      console.log('[App] 🔍 ❌ items?.length:', items?.length);
    }
  }, []);

  // Handle message sent from Ask/Agent modes
  const handleMessageSent = (message: string, mode: 'ask' | 'agent' | 'select' = 'ask') => {
    console.log('[Chat Panel] Message sent:', message, 'mode:', mode);
    console.log('[Chat Panel] 🎭 Setting thinking animation to TRUE');
    
    // Clear conversation history if switching modes
    if (chatPanelMode !== mode) {
      setConversationHistory([]);
      setDisplayedAgentText({});
    }
    
    // Add user message to conversation history
    const userMessageId = `user-${Date.now()}`;
    setConversationHistory(prev => [...prev, {
      role: 'user',
      content: message,
      id: userMessageId
    }]);
    
    // Show thinking state for all modes - ALWAYS for every message
    setIsThinking(true);
    setCurrentResponse('');
    setDisplayedResponse('');
    setIsTyping(false);
    setChatPanelMode(mode);
    
    // Different UI for agent vs ask mode
    if (mode === 'agent') {
      // Agent mode: Show compact status bar instead of full chat panel
      setAgentStatusVisible(true);
      setAgentUserMessage(message);
      setChatPanelVisible(false);
    } else {
      // Ask mode: Show full chat panel (existing behavior)
      setChatPanelVisible(true);
      setAgentStatusVisible(false);
    }
    
    currentAssistantMessageRef.current = null;
  };

  // Handle select mode message with image
  const handleSelectMessage = (message: string, imageData: string) => {
    console.log('[Chat Panel] Select message sent:', message);
    
    // Clear conversation history if switching modes
    if (chatPanelMode !== 'select') {
      setConversationHistory([]);
    }
    
    // Add user message to conversation history
    const userMessageId = `user-${Date.now()}`;
    setConversationHistory(prev => [...prev, {
      role: 'user',
      content: message,
      id: userMessageId
    }]);
    
    setIsThinking(true);
    setCurrentResponse('');
    setChatPanelMode('select');
    setSelectImage(imageData);
    setChatPanelVisible(true);
    currentAssistantMessageRef.current = null;
    
    // Hide the old highlight chat
    setHighlightChatVisible(false);
  };

  // Listen for responses to update the chat panel
  useEffect(() => {

    const handleNanobrowserResponse = (_event: any, response: string) => {
      console.log('[Chat Panel] Agent response received:', response);
      if (chatPanelVisible && chatPanelMode === 'agent') {
        setIsThinking(false);
        setCurrentResponse(response);
      }
    };

    const handleGeminiMacosResponse = (_event: any, response: any) => {
      console.log('[Chat Panel] MacOS Agent response received:', response);
      if ((chatPanelVisible && chatPanelMode === 'agent') || agentStatusVisible) {
        // Handle different types of responses from agent mode using conversation history
        if (response.type === 'plan' && response.content) {
          // Show the action plan - add new assistant message to history
          // Keep thinking animation running - agent is still executing the plan
          // setIsThinking(false); // REMOVED - keep thinking active during planning
          const planText = response.content;
          
          // If no current assistant message, create one
          if (!currentAssistantMessageRef.current) {
            const messageId = Date.now().toString();
            const assistantMessage = {
              role: 'assistant' as const,
              content: planText,
              id: messageId
            };
            currentAssistantMessageRef.current = messageId;
            setConversationHistory(prev => [...prev, assistantMessage]);
          } else {
            // Update existing assistant message
            setConversationHistory(prev => 
              prev.map(msg => 
                msg.id === currentAssistantMessageRef.current 
                  ? { ...msg, content: planText }
                  : msg
              )
            );
          }
        } else if (response.type === 'step_start') {
          // Show step messages for Chrome agent as individual message bubbles
          const messageId = Date.now().toString();
          const assistantMessage = {
            role: 'assistant' as const,
            content: response.content,
            id: messageId,
            isTyping: true
          };
          currentAssistantMessageRef.current = messageId;
          setConversationHistory(prev => [...prev, assistantMessage]);
          return;
        } else if (response.type === 'step_success') {
          // IGNORE STEP SUCCESS - no spam!
          return;
        } else if (response.type === 'step_error') {
          // Suppress all step errors from appearing in chat, but keep thinking active
          // Agent might recover and continue, so don't stop thinking animation
          return;
        } else if (response.type === 'agent_thinking') {
          // Skip empty or very short content that might create empty bubbles
          const trimmedContent = response.content?.trim() || '';
          if (!trimmedContent || trimmedContent.length < 3 || trimmedContent === '🧠 Reasoning:') {
            return;
          }
          
          // Complete any previous typing message first
          if (currentAssistantMessageRef.current) {
            setConversationHistory(prev => 
              prev.map(msg => 
                msg.id === currentAssistantMessageRef.current 
                  ? { ...msg, isTyping: false }
                  : msg
              )
            );
          }
          
          // Show the agent's reasoning as a new message
          const messageId = Date.now().toString();
          const assistantMessage = {
            role: 'assistant' as const,
            content: response.content,
            id: messageId,
            isTyping: true
          };
          currentAssistantMessageRef.current = messageId;
          setConversationHistory(prev => [...prev, assistantMessage]);
          return;
        } else if (response.type === 'agent_action') {
          // Skip empty or very short content that might create empty bubbles
          const trimmedContent = response.content?.trim() || '';
          if (!trimmedContent || trimmedContent.length < 3) {
            return;
          }
          
          // Complete any previous typing message first
          if (currentAssistantMessageRef.current) {
            setConversationHistory(prev => 
              prev.map(msg => 
                msg.id === currentAssistantMessageRef.current 
                  ? { ...msg, isTyping: false }
                  : msg
              )
            );
          }
          
          // Show the action being performed
          const messageId = Date.now().toString();
          const assistantMessage = {
            role: 'assistant' as const,
            content: response.content,
            id: messageId,
            isTyping: false
          };
          currentAssistantMessageRef.current = null; // Clear reference since this isn't typing
          setConversationHistory(prev => [...prev, assistantMessage]);
          return;
        } else if (response.content && (response.type === 'content' || response.type === 'initial')) {
          // Handle content messages (suppress interim action updates)
          
          if (response.type === 'initial' && currentAssistantMessageRef.current) {
            // Skip duplicate initial messages
            return;
          }
          
          // Hard guard: skip tiny/empty initial/content
          const trimmed = (response.content || '').trim();
          if (!trimmed || trimmed.length < 3) {
            return;
          }
          
          // For initial messages, show the acknowledgment but KEEP thinking animation running
          if (response.type === 'initial') {
            // Show initial message but keep thinking state active
            const messageId = Date.now().toString();
            const assistantMessage = {
              role: 'assistant' as const,
              content: trimmed,
              id: messageId,
              isTyping: true
            };
            currentAssistantMessageRef.current = messageId;
            setConversationHistory(prev => [...prev, assistantMessage]);
            // DON'T set thinking to false - agent is still working!
            return;
          }
          
          // For content messages, only show final-like messages and turn off thinking
          if (response.type === 'content') {
            const txt = trimmed;
            const isFinalLike = /completed|all done|done|result/i.test(txt);
            if (!isFinalLike) {
              return;
            }
            // Only turn off thinking for final content messages
            setIsThinking(false);
          }
          
          // Always create new message bubbles for better separation
          const messageId = Date.now().toString();
          const assistantMessage = {
            role: 'assistant' as const,
            content: trimmed,
            id: messageId,
            isTyping: true
          };
          currentAssistantMessageRef.current = messageId;
          setConversationHistory(prev => [...prev, assistantMessage]);
        } else if (response.content && response.type === 'completion') {
          // Handle completion messages - ALWAYS create new bubble
          const trimmed = (response.content || '').trim();
          if (!trimmed || trimmed.length < 3) {
            return;
          }
          setIsThinking(false);
          
          // Always create a new message bubble for completion
          const messageId = Date.now().toString();
          const assistantMessage = {
            role: 'assistant' as const,
            content: trimmed,
            id: messageId,
            isTyping: true
          };
          setConversationHistory(prev => [...prev, assistantMessage]);
          // Reset current message ref since we created a new one
          currentAssistantMessageRef.current = messageId;
        }
      }
    };

    // Handle streaming responses (only for chat panel, not AskAgent input bar)
    const handleStream = (_event: any, data: { type: string; content?: string }) => {
      if (chatPanelVisible && chatPanelMode === 'ask') {
        if (data.type === 'text' && data.content) {
          setIsStreaming(true);
          setIsThinking(false); // hide thinking as soon as stream begins
          // Keep legacy currentResponse for any consumers
          setCurrentResponse(prev => prev + data.content);

          // Ensure there is a single assistant message we append to
          let streamingId = (currentAssistantMessageRef as any).streamingMessageId as string | undefined;
          const delta = data.content;
          if (!streamingId) {
            streamingId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const ensuredId = streamingId as string;
            (currentAssistantMessageRef as any).streamingMessageId = ensuredId;
            setConversationHistory(prev => [
              ...prev,
              { role: 'assistant' as const, content: delta, id: ensuredId }
            ]);
            return;
          }

          setConversationHistory(prev => prev.map(msg =>
            msg.id === streamingId ? { ...msg, content: (msg.content || '') + delta } : msg
          ));
        } else if (data.type === 'stream_end') {
          setIsStreaming(false);
          setIsThinking(false);
          (currentAssistantMessageRef as any).streamingMessageId = undefined;
        }
      }
    };

    // Also listen for regular responses (for Ask and Select modes)
    const handleReply = (_event: any, data: { type: string; message: string }) => {
      // If chat panel is visible, update it for ask or select mode
      if (chatPanelVisible && (chatPanelMode === 'select' || chatPanelMode === 'ask')) {
        console.log('[Chat Panel] Response received for', chatPanelMode, ':', data.message);
        setIsThinking(false);
        setCurrentResponse(data.message);
      }
    };

    window.ipcRenderer.on('nanobrowser-response', handleNanobrowserResponse);
    window.ipcRenderer.on('gemini-macos-response', handleGeminiMacosResponse);
    window.ipcRenderer.on('stream', handleStream);
    window.ipcRenderer.on('reply', handleReply);
    
    return () => {
      window.ipcRenderer.removeListener('nanobrowser-response', handleNanobrowserResponse);
      window.ipcRenderer.removeListener('gemini-macos-response', handleGeminiMacosResponse);
      window.ipcRenderer.removeListener('stream', handleStream);
      window.ipcRenderer.removeListener('reply', handleReply);
      window.ipcRenderer.removeListener('contextual-search', handleContextualSearch);
    };
  }, [chatPanelVisible, chatPanelMode, agentStatusVisible]);

  // Handle agent status bar close event
  useEffect(() => {
    const handleAgentStatusClose = () => {
      setAgentStatusVisible(false);
      setAgentUserMessage('');
      setIsThinking(false);
    };

    window.addEventListener('agent-status-close', handleAgentStatusClose);
    
    return () => {
      window.removeEventListener('agent-status-close', handleAgentStatusClose);
    };
  }, []);

  // Word-by-word typing animation for chat panel responses
  useEffect(() => {
    // Disable typewriter effect for agent and ask modes (we stream directly)
    if (chatPanelMode === 'agent' || chatPanelMode === 'ask') {
      return;
    }
    if (currentResponse && currentResponse !== displayedResponse) {
      // Clear any existing typing animation
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      
      setIsTyping(true);
      setDisplayedResponse('');
      
      // Only create ONE assistant message per response
      const responseHash = currentResponse.substring(0, 50); // Use first 50 chars as identifier
      let assistantMessageId: string;
      
      if (currentAssistantMessageRef.current !== responseHash) {
        // This is a new response, create ONE message for it
        currentAssistantMessageRef.current = responseHash;
        assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        setConversationHistory(prev => {
          // Check if we already have an empty assistant message
          const hasEmptyAssistant = prev.some(msg => 
            msg.role === 'assistant' && msg.content === ''
          );
          
          if (!hasEmptyAssistant && currentResponse.trim().length > 0) {
            return [...prev, {
              role: 'assistant' as const,
              content: currentResponse,
              id: assistantMessageId
            }];
          }
          return prev;
        });
        
        // Store the message ID for updates
        (currentAssistantMessageRef as any).messageId = assistantMessageId;
      } else {
        // Use existing message ID
        assistantMessageId = (currentAssistantMessageRef as any).messageId || '';
      }
      
      const words = currentResponse.split(' ');
      let currentWordIndex = 0;
      
      const typeNextWord = () => {
        if (currentWordIndex < words.length) {
          const currentText = words.slice(0, currentWordIndex + 1).join(' ');
          setDisplayedResponse(currentText);
          
          // Update the specific assistant message by ID (only if it exists)
          if (assistantMessageId) {
            setConversationHistory(prev => 
              prev.map(msg => 
                msg.id === assistantMessageId 
                  ? { ...msg, content: currentText }
                  : msg
              )
            );
          }
          
          currentWordIndex++;
          
          // Delay between words (ChatGPT-like timing)
          typingTimeoutRef.current = setTimeout(typeNextWord, 80);
        } else {
          // Animation complete
          setIsTyping(false);
          setDisplayedResponse(currentResponse);
          
          // Final update to the specific assistant message
          if (assistantMessageId) {
            setConversationHistory(prev => 
              prev.map(msg => 
                msg.id === assistantMessageId 
                  ? { ...msg, content: currentResponse }
                  : msg
              )
            );
          } else {
            // Fallback: Update the last assistant message if no ID
            setConversationHistory(prev => {
              // Find last assistant message index manually
              let lastIndex = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role === 'assistant') {
                  lastIndex = i;
                  break;
                }
              }
              if (lastIndex !== -1) {
                const updated = [...prev];
                updated[lastIndex] = { ...updated[lastIndex], content: currentResponse };
                return updated;
              }
              return prev;
            });
          }
        }
      };
      
      // Start typing animation after a short delay
      typingTimeoutRef.current = setTimeout(typeNextWord, 150);
    }
    
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [currentResponse, chatPanelMode]);

  // Auto-scroll to bottom when new messages are added (only if user is near bottom)
  useEffect(() => {
    if (chatScrollRef.current) {
      const element = chatScrollRef.current;
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      
      // Only auto-scroll if user is within 100px of the bottom (or it's a new message)
      if (distanceFromBottom < 100) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }, [conversationHistory, isTyping]);

  // Handle word-by-word typing animation for agent assistant messages (ChatGPT style)
  useEffect(() => {
    const lastMessage = conversationHistory[conversationHistory.length - 1];
    if (lastMessage?.role === 'assistant' && lastMessage.isTyping) {
      const words = lastMessage.content.split(' ');
      let currentWordIndex = 0;
      
      // Start with empty text
      setDisplayedAgentText(prev => ({
        ...prev,
        [lastMessage.id]: ''
      }));
      
      const typeInterval = setInterval(() => {
        if (currentWordIndex < words.length) {
          const currentText = words.slice(0, currentWordIndex + 1).join(' ');
          setDisplayedAgentText(prev => ({
            ...prev,
            [lastMessage.id]: currentText
          }));
          currentWordIndex++;
        } else {
          clearInterval(typeInterval);
          // Mark typing as complete
          setDisplayedAgentText(prev => ({
            ...prev,
            [lastMessage.id]: lastMessage.content
          }));
          // Remove typing indicator from the message
          setConversationHistory(prev => 
            prev.map(msg => 
              msg.id === lastMessage.id 
                ? { ...msg, isTyping: false }
                : msg
            )
          );
        }
      }, 120); // ChatGPT-like timing between words

      return () => clearInterval(typeInterval);
    }
  }, [conversationHistory]);

  // Remove all the complex hover stuff - just keep it simple

  useEffect(() => {
    window.ipcRenderer.on(
      "reply",
      (_event: any, data: { type: string; message: string }) => {
        // Never show raw errors in chat UI
        if (data.type === 'error') {
          setLoading(false);
          setIsStreaming(false);
          setCurrentStream("");
          currentStreamRef.current = "";
          return;
        }
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
            // Append new content to current stream
            chat.currentStream = (chat.currentStream || '') + (data.content || '');
            console.log(`[ActionChat] Received text for ${data.chatId}:`, data.content, 'Total so far:', chat.currentStream);
          } else if (data.type === 'stream_end') {
            chat.streaming = false;
            console.log(`[ActionChat] Stream ended for ${data.chatId}, currentStream:`, chat.currentStream);
            
            if (chat.currentStream && chat.currentStream.trim()) {
              const finalContent = chat.currentStream.trim();
              
              // For say-next, replace the last message instead of stacking
              if ((chat as any).sayNext) {
                // Replace the last assistant message or add if none exists
                let lastAssistantIndex = -1;
                for (let i = chat.messages.length - 1; i >= 0; i--) {
                  if (chat.messages[i].role === 'assistant') {
                    lastAssistantIndex = i;
                    break;
                  }
                }
                if (lastAssistantIndex >= 0) {
                  chat.messages[lastAssistantIndex] = { role: 'assistant', content: finalContent };
                } else {
                  chat.messages.push({ role: 'assistant', content: finalContent });
                }
              } else {
                // For regular chats, only add if it's different from the last message
                const lastMessage = chat.messages[chat.messages.length - 1];
                if (!lastMessage || lastMessage.content !== finalContent) {
                  chat.messages.push({ role: 'assistant', content: finalContent });
                }
              }
              console.log(`[ActionChat] Added/updated message for ${data.chatId}:`, finalContent);
            }
            
            // Clear the stream
            chat.currentStream = '';
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
    window.ipcRenderer.on('contextual-search', handleContextualSearch);

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
              const newContent = prev + `\n${data.content}\n\n`;
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
            setIsThinking(false); // Hide thinking animation when done
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
        console.log('[ScreenHighlight] Screenshot captured, setting up select mode');
        
        // Set up select mode in chat panel instead of highlight chat
        setSelectImage(data.imageBase64);
        setChatPanelMode('select');
        setChatPanelVisible(true);
        setIsHighlightMode(false);
        
        // Hide other modes
        setHighlightChatVisible(false);
        setIsChatPaneVisible(false);
        
        // Clear conversation for fresh start
        setConversationHistory([]);
        setCurrentResponse('');
        setIsThinking(false);
        
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
        setIsThinking(true); // Show thinking animation
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
          // Send highlight chat with image and show in new chat panel
          console.log('[App] 🎯 Sending highlight chat message:', prompt);
          console.log('[App] 🎯 Image length:', highlightedImage.length, 'chars');
          
          // Show in new chat panel
          handleSelectMessage(prompt, highlightedImage);
          
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
      // No browser monitoring needed - macOS agent handles everything
      const handleChromeStatus = (_event: any, _isActive: boolean) => {
        // Chrome status no longer tracked - macOS agent handles all tasks
      };
      
      const handleBrowserDetected = (_event: any, _data: { browserName: string, isChromeActive: boolean }) => {
        // Browser detection no longer needed - macOS agent handles all tasks
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
        // Generation of actions now happens after analysis completes in the meeting service
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
            // Focus the correct input based on the current mode
            if (agentMode === "chat" && askAgentRef.current) {
              console.log('[Keyboard] Focusing AskAgent input');
              askAgentRef.current.focus();
            } else if (inputRef.current) {
              console.log('[Keyboard] Focusing main input');
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

  useEffect(() => {
    const handleRecordingProgress = (_e: any, data: { count: number }) => {
      setRecordedCount(data?.count || 0);
    };
    const handleRecordingStarted = () => {
      setIsRecording(true);
      setIsRecordArmed(false);
    };
    const handleRecordingStopped = (_e: any, data: { count: number }) => {
      setIsRecording(false);
      setRecordedCount(data?.count || recordedCount);
      setIsRecordArmed(false); // Exit record mode to allow normal input
    };
    const handleRecordingError = (_e: any, msg: string) => {
      console.error('[Renderer] Recording error:', msg);
      setIsRecording(false);
      setCountdown(null);
      setIsRecordArmed(false);
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };

    window.ipcRenderer.on('recording:progress', handleRecordingProgress);
    window.ipcRenderer.on('recording:started', handleRecordingStarted);
    window.ipcRenderer.on('recording:stopped', handleRecordingStopped);
    window.ipcRenderer.on('recording:error', handleRecordingError);
    return () => {
      window.ipcRenderer.removeListener('recording:progress', handleRecordingProgress);
      window.ipcRenderer.removeListener('recording:started', handleRecordingStarted);
      window.ipcRenderer.removeListener('recording:stopped', handleRecordingStopped);
      window.ipcRenderer.removeListener('recording:error', handleRecordingError);
    };
  }, [recordedCount]);

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
                setSelectImage(null);
                window.ipcRenderer.send("cancel-screen-highlight");
              }
              // Close agent chat panel if switching from agent mode
              if (agentMode === "agent") {
                setChatPanelVisible(false);
                setSelectImage(null);
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
                // Already in chat mode
                
                // If chat panel is open, close everything and go to main bar
                if (chatPanelVisible) {
                  setChatPanelVisible(false);
                  setIsChatPaneVisible(false);
                  setAgentMode("chat");
                  setSelectImage(null);
                  setCurrentResponse('');
                  setDisplayedResponse('');
                  setIsTyping(false);
                  setIsThinking(false);
                  setConversationHistory([]);
                  setDisplayedAgentText({});
                  currentAssistantMessageRef.current = null;
                  if (typingTimeoutRef.current) {
                    clearTimeout(typingTimeoutRef.current);
                  }
                  // Release Chrome control when closing agent chat panel  
                  window.ipcRenderer.send('stop-browser-monitoring');
                  window.ipcRenderer.send('emergency-stop-monitoring');
                } else {
                  // Chat panel not open, toggle ask pane
                  const willOpen = !isChatPaneVisible;
                  setIsChatPaneVisible(willOpen);
                  setHighlightChatVisible(false);
                  
                  if (willOpen) {
                    // Focus input when opening chat and enable interaction
                    window.ipcRenderer.send('chat:focus');
                    setTimeout(() => inputRef.current?.focus(), 100);
                  }
                }
              }
            }}
            className={`liquid-button mode-transition inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium h-7 px-2 ${
               agentMode === "chat" && isChatPaneVisible && !isLiveMode ? 'bg-secondary shadow-xs mainbar-button-active' : 'hover:bg-accent mainbar-button-inactive'
             } ${
               isStreaming && agentMode === "chat" && !isLiveMode ? 'bg-green-600 shadow-xs animate-pulse' : ''
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
            onClick={async (e) => {
              e.stopPropagation();
              e.preventDefault();
              console.log('[Agent Button] Clicked! Current state - agentMode:', agentMode, 'isChatPaneVisible:', isChatPaneVisible);
              
              // Check accessibility permissions before opening agent mode
              if (agentMode !== "agent") {
                const hasPermissions = await checkAccessibilityPermissions();
                if (!hasPermissions) {
                  console.log('[Agent Button] Accessibility permissions not granted - showing dialog');
                  return; // Don't open agent mode until permissions are granted
                }
              }
              
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
                // Release Chrome control when toggling off agent mode
                window.ipcRenderer.send('stop-browser-monitoring');
                window.ipcRenderer.send('emergency-stop-monitoring');
              } else {
                console.log('[Agent Button] Switching from Ask to Agent mode');
                setAgentMode("agent");
                setIsChatPaneVisible(false); // Close ask pane
                setHighlightChatVisible(false); // Close highlight chat if open
                setChatPanelVisible(false); // Close ask chat panel if open
                setSelectImage(null); // Clear select image
              }
            }}
            className={`liquid-button mode-transition inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium h-7 px-2 ${
              agentMode === "agent" ? 'bg-secondary shadow-xs mainbar-button-active' : 'hover:bg-accent mainbar-button-inactive'
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
                setChatPanelVisible(false);
                setSelectImage(null);
                setCurrentResponse('');
                setIsThinking(false);
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
            className={`liquid-button mode-transition inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs font-medium h-7 px-2 ${
              isHighlightMode ? 'bg-blue-600 shadow-xs mainbar-button-active' : 'hover:bg-accent mainbar-button-inactive'
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
            onMouseEnter={() => {
              window.ipcRenderer.send('mouse:enter-interactive');
            }}
            onMouseLeave={() => {
              window.ipcRenderer.send('mouse:leave-interactive');
            }}
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
                // Reset double-press timer
                lastListenPressRef.current = 0;
                console.log('[Microphone Button] Stop sequence complete');
              } else {
                // Single click starts listen mode immediately
                console.log('[Listen Button] Starting listen mode');
                  
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
                // localStorage.setItem('opus-meeting-mode', 'true'); // Temporarily disabled to prevent confusion
                  
                  // Start LiveAudioService in main process
                  window.ipcRenderer.send("start-conversation-mode", "live");
                  
                  // Start audio streaming in renderer (Clonely-style)
                  startAudioStreaming((chunk) => {
                    // Send audio chunks to main process
                    // Removed cluttering audio chunk log
                    window.ipcRenderer.send("live-audio-chunk", chunk);
                  }, (update) => {
                    // Handle permission and status updates
                    if (update.type === 'permission_warning') {
                      const message = update.content + '\n\nWould you like to open System Settings now?';
                      if (confirm(message)) {
                        // @ts-ignore - ipcRenderer is available at runtime
                        window.ipcRenderer?.send('open-screen-recording-settings');
                      }
                    } else if (update.type === 'info') {
                      // Removed cluttering audio update log
                    }
                  }).then(({ handle }) => {
                    audioHandleRef.current = handle;
                    console.log('[AudioStreaming] ✅ Audio streaming started');
                  }).catch((error) => {
                    console.error('[AudioStreaming] ❌ Failed to start audio streaming:', error);
                    console.error('[AudioStreaming] Error details:', error.message);
                    console.error('[AudioStreaming] Stack trace:', error.stack);
                    
                    // Only show error for critical failures (like microphone access)
                    let errorMessage = error.message;
                    if (error.message.includes('Microphone access denied')) {
                      errorMessage = `Microphone Permission Required

To use meeting mode, please allow microphone access and try again.

Error: ${error.message}`;
                      alert('Failed to start audio capture: ' + errorMessage);
                      setIsLiveMode(false); // Revert on failure
                      localStorage.removeItem('opus-meeting-mode'); // Clear flag on failure
                    } else {
                      // For other errors, just log them but don't block the user
                      console.warn('[AudioStreaming] Non-critical error, continuing with available audio sources:', errorMessage);
                    }
                  });
                  
                  console.log('[Microphone Button] Start sequence initiated');
              }
            }}
            className={`liquid-button mode-transition inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full text-xs font-medium h-7 px-2 app-region-no-drag pointer-events-auto ${
               isLiveMode ? 'border border-red-500 text-white hover:border-red-400 mainbar-button-active' : 'hover:bg-white/10 text-white mainbar-button-inactive'
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

                {/* Settings option */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log('[Settings Button] Clicked!');
                    // TODO: Implement settings functionality
                    setIsMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-white flex items-center gap-2 transition-all hover:bg-white/10 rounded-md"
                  title="Settings"
                >
                  <span>Settings</span>
                </button>

                {/* Record option */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setIsMenuOpen(false);
                    // Open chat panel in ask mode for prompt entry
                    setAgentMode('chat');
                    setChatPanelMode('ask');
                    setChatPanelVisible(true);
                    setIsChatPaneVisible(true);
                    // Arm recording; start on first submit
                    setRecordedCount(0);
                    setIsRecording(false);
                    setCountdown(null);
                    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
                    setIsRecordArmed(true);
                  }}
                  className="w-full text-left px-3 py-2 text-xs text-white flex items-center gap-2 transition-all hover:bg-white/10 rounded-md"
                  title="Record"
                >
                  <span>Record</span>
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
      {/* Select Mode UI - overlay handles the buttons, no duplicates needed */}

      {/* AI Pane - Stays open when agent is working */}
      <div id="chat-pane" className={`overflow-hidden liquid-animate rounded-b-xl ${
        (isChatPaneVisible || isStreaming || messages.length > 0 || highlightChatVisible || meetingChats.length > 0) ? `${isLiveMode ? 'max-h-[60vh] meeting-enter' : 'max-h-[25vh] chat-pane-enter'} opacity-100 liquid-open` : 'max-h-0 opacity-0 liquid-closed'
      } px-4 ${isLiveMode ? 'w-[70vw]' : 'w-[40vw]'} pointer-events-auto`}>
        <div className={`max-h-full w-full bg-transparent p-2 gap-3 rounded-b-xl ${isLiveMode ? 'meeting-panels' : 'flex'}`}>
          {/* Left Panel - Transcript (only in live mode) - CENTERED by default */}
          {isLiveMode && (
            <div className={`flex-shrink-0 w-[420px] min-w-[380px] max-w-[440px] mx-auto rounded-xl overflow-hidden mode-enter stagger-1`}>
              <listen-view ref={listenViewRef as any} style={{ display: 'block', width: '100%', borderRadius: '12px', overflow: 'hidden' }}></listen-view>
            </div>
          )}

          {/* Right side: Meeting chats (when in live mode) or regular chat/highlight */}
          {(meetingChats.length > 0 || isLiveMode) && meetingChats.length > 0 && (
            <div className={`flex-1 flex flex-col h-full gap-2 min-w-0 text-sm sidebar-panel items-start mode-enter stagger-2`}>
              {/* Meeting Action Chat Threads */}
              <div className="flex flex-col gap-2 w-full max-w-[400px]" style={{ overflow: 'visible' }}>
                {meetingChats.map((chat, index) => (
                  <div 
                    key={chat.id} 
                    className={`liquid-panel rounded-lg p-3 relative action-chat-panel mode-enter stagger-${Math.min(index + 3, 3)}`} 
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
                      className="absolute top-1 right-2 text-white hover:text-white z-10"
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
                                            <div className="text-white">
                    <span className="thinking-text">Thinking...</span>
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
              <div className="flex-1 flex flex-col h-full gap-2 min-w-0 text-sm max-h-[25vh] pointer-events-auto mx-auto mode-enter" style={{ width: '420px', minWidth: '380px', maxWidth: '440px' }}>
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
                        className={`mb-3 p-3 rounded-xl liquid-panel text-white message-enter`}
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
                  <div className="p-3 bg-white/[0.02] glass-chat-input-area">
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

      {/* Chat Panel for Ask/Agent modes */}
      {chatPanelVisible && !isLiveMode && (
        <div className="fixed top-14 left-1/2 transform -translate-x-1/2 w-[36vw] max-w-[520px] min-w-[420px] h-[45vh] z-30 pointer-events-auto panel-enter"
             onMouseEnter={() => { window.ipcRenderer.send('mouse:enter-interactive'); }}
             onMouseLeave={() => { window.ipcRenderer.send('mouse:leave-interactive'); }}>
          <div className="liquid-panel rounded-2xl flex flex-col h-full"
               style={{
                 background: 'rgba(0, 0, 0, 0.3)',
                 backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                 border: '0.5px solid rgba(255, 255, 255, 0.3)',
               }}>
            
            {/* Chat content area */}
            <div ref={chatScrollRef} className="flex-1 p-4 pb-2 overflow-y-auto" tabIndex={0} style={{ outline: 'none' }}>
              {/* Selected image for select mode - display as user message on right */}
              {chatPanelMode === 'select' && selectImage && (
                <div className="mb-4 flex justify-end mr-5">
                  <div className="max-w-[70%]">
                    <img 
                      src={`data:image/png;base64,${selectImage}`}
                      alt="Selected area"
                      className="rounded-lg border border-white/20 max-h-[100px] max-w-[150px] object-contain ml-auto block"
                    />
                  </div>
                </div>
              )}

                            {/* Show all conversation messages in chronological order (like Ask mode) */}
              {conversationHistory.filter(m => (m.role === 'user') || (m.content && m.content.trim().length > 0) || (m.isTyping && (m.content?.length ?? 0) > 0)).map((message) => (
                <div 
                  key={message.id} 
                  className={`mb-4 ${message.role === 'user' ? 'mr-5' : 'ml-3'}`}
                >
                  {message.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="bg-black/20 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2 max-w-[70%] break-words">
                        {message.content}
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-start">
                      <div className="bg-white/10 text-white text-sm rounded-2xl rounded-tl-sm px-4 py-2 max-w-[80%] break-words">
                        <span>
                          {message.role === 'assistant' && message.isTyping 
                            ? (displayedAgentText[message.id] || '')
                            : message.content}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              
              {/* Show thinking state when waiting for response */}
              {isThinking && !isStreaming && (
                <div className="flex justify-start ml-3 mb-4">
                  <div className="text-white text-sm">
                    <span className="thinking-text">Thinking...</span>
                  </div>
                </div>
              )}
            </div>

            {/* Embedded input bar at bottom for all modes */}
            <div className="border-t border-white/10 p-3 bg-white/[0.03]" 
                 style={{
                   background: 'rgba(255, 255, 255, 0.02)',
                   backdropFilter: 'blur(10px)',
                 }}
                 onMouseEnter={() => {
                   window.ipcRenderer.send('mouse:enter-interactive');
                 }}
                 onMouseLeave={() => {
                   window.ipcRenderer.send('mouse:leave-interactive');
                 }}>
              <form onSubmit={(e) => {
                e.preventDefault();
                // Block sending while in recording flow until stopped
                if (isRecordArmed || countdown !== null || isRecording) {
                  return;
                }
                if (prompt.trim() && !isStreaming) {
                  if (chatPanelMode === 'select' && selectImage) {
                    console.log('[App] Sending select mode message with image:', prompt, 'Image length:', selectImage.length);
                    handleSelectMessage(prompt, selectImage);
                    (window.ipcRenderer.sendMessage as any)(prompt, { 
                      mode: "chat",
                      isHighlightChat: true,
                      highlightedImage: selectImage
                    });
                  } else if (chatPanelMode === 'ask') {
                    handleMessageSent(prompt, 'ask');
                    (window.ipcRenderer.sendMessage as any)(prompt, { mode: "chat" });
                  } else if (chatPanelMode === 'agent') {
                    handleMessageSent(prompt, 'agent');
                    window.ipcRenderer.send('gemini-macos-command', prompt);
                  }
                  setPrompt("");
                }
              }} className="relative">
                <input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    countdown !== null ? `Recording starts in ${countdown}s...` :
                    isRecording ? `Recording... (${recordedCount} frames)` :
                    (isRecordArmed && recordedCount === 0) ? "Click Start to begin recording" :
                    recordedCount > 0 ? "Type your prompt about the recording..." :
                    chatPanelMode === 'select' ? "Ask about the image..." :
                    chatPanelMode === 'ask' ? "Ask me about your screen..." :
                    chatPanelMode === 'agent' ? "What do you want to automate..." :
                    "Type your message..."
                  }
                  disabled={isStreaming}
                  className="w-full px-4 py-2 pr-28 rounded text-white text-sm bg-white/5 border border-white/10 focus:border-white/20 focus:outline-none"
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    backdropFilter: 'blur(10px)',
                  }}
                />
                {/* Right-side controls: Stop/Analyze/Send */}
                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex gap-2 items-center">
                  {isRecordArmed && !isRecording && recordedCount === 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        // Start countdown
                        if (countdown !== null) return;
                        setCountdown(5);
                        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
                        countdownTimerRef.current = setInterval(() => {
                          setCountdown((prev) => {
                            const next = (prev ?? 0) - 1;
                            if (next <= 0) {
                              if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
                              setCountdown(null);
                              window.ipcRenderer.send('recording:start');
                            }
                            return next;
                          });
                        }, 1000) as any;
                      }}
                      className="w-auto h-6 px-2 rounded text-white text-xs"
                      style={{ background: 'rgba(34, 197, 94, 0.6)' }}
                      title="Start recording"
                    >
                      Start
                    </button>
                  ) : isRecording ? (
                    <button
                      type="button"
                      onClick={() => {
                        window.ipcRenderer.send('recording:stop');
                      }}
                      className="w-6 h-6 rounded flex items-center justify-center"
                      style={{ background: 'rgba(255, 0, 0, 0.35)' }}
                      title="Stop recording"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                    </button>
                  ) : countdown !== null ? (
                    <div className="text-white/80 text-xs min-w-[16px] text-center">{countdown}</div>
                  ) : recordedCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        // Send prompt + all recorded images to analyze
                        if (!prompt.trim()) return;
                        handleMessageSent(prompt, 'ask');
                        setIsThinking(true);
                        setCurrentResponse('');
                        window.ipcRenderer.send('recording:analyze', prompt);
                        setPrompt('');
                        setRecordedCount(0);
                        setIsRecordArmed(false);
                      }}
                      className="w-auto h-6 px-2 rounded text-white text-xs"
                      style={{ background: 'rgba(99, 102, 241, 0.6)' }}
                      title={`Analyze ${recordedCount} frames`}
                    >
                      Send ({recordedCount})
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!prompt.trim() || isStreaming}
                      className="w-6 h-6 rounded flex items-center justify-center transition-opacity"
                      style={{ 
                        background: 'rgba(255, 255, 255, 0.1)', 
                        border: 'none',
                        opacity: (!prompt.trim() || isStreaming) ? 0.3 : 0.8
                      }}
                      title="Send"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 2-7 20-4-9-9-4z"/>
                        <path d="M22 2 11 13"/>
                      </svg>
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Close button */}
            <button
              onClick={() => {
                // Complete reset to main bar state
                setChatPanelVisible(false);
                setIsChatPaneVisible(false);
                setAgentMode("chat");
                setSelectImage(null);
                setCurrentResponse('');
                setDisplayedResponse('');
                setIsTyping(false);
                setIsThinking(false);
                setConversationHistory([]);
                setDisplayedAgentText({});
                currentAssistantMessageRef.current = null;
                if (typingTimeoutRef.current) {
                  clearTimeout(typingTimeoutRef.current);
                }
                // Stop any ongoing recording and reset counters
                try { window.ipcRenderer.send('recording:stop'); } catch {}
                setRecordedCount(0);
                setCountdown(null);
                setIsRecordArmed(false);
                if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
                // Release Chrome control when exiting agent mode
                window.ipcRenderer.send('stop-browser-monitoring');
                window.ipcRenderer.send('emergency-stop-monitoring');
              }}
              onMouseEnter={() => {
                window.ipcRenderer.send('mouse:enter-interactive');
              }}
              onMouseLeave={() => {
                window.ipcRenderer.send('mouse:leave-interactive');
              }}
              className="absolute top-2 right-3 text-white/60 hover:text-white transition-colors"
              title="Close chat"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18"/>
                <path d="m6 6 12 12"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Input bars - positioned right under main bar */}
      <div className="fixed top-11 left-1/2 transform -translate-x-1/2 z-40">
        {/* Ask Input Bar - only show when chat panel is NOT visible */}
        {agentMode === "chat" && isChatPaneVisible && !isLiveMode && !highlightChatVisible && !chatPanelVisible && (
          <div 
            className="pointer-events-auto input-bar-enter" 
            style={{ width: '450px', minWidth: '400px', maxWidth: '500px' }}
            onMouseEnter={() => {
              window.ipcRenderer.send('mouse:enter-interactive');
            }}
            onMouseLeave={() => {
              window.ipcRenderer.send('mouse:leave-interactive');
            }}
          >
            <div className="glass-chat-input-area">
              <AskAgent ref={askAgentRef} onMessageSent={(msg) => handleMessageSent(msg, 'ask')} />
            </div>
          </div>
        )}

        {/* Agent Input Bar - only show when chat panel AND status bar are NOT visible */}
        {agentMode === "agent" && !chatPanelVisible && !agentStatusVisible && (
          <div 
            className="pointer-events-auto input-bar-enter" 
            style={{ width: '450px', minWidth: '400px', maxWidth: '500px' }}
            onMouseEnter={() => {
              window.ipcRenderer.send('mouse:enter-interactive');
            }}
            onMouseLeave={() => {
              window.ipcRenderer.send('mouse:leave-interactive');
            }}
          >
            <div className="glass-chat-input-area">
              <MacOSAgent 
                onMessageSent={(msg) => handleMessageSent(msg, 'agent')} 
                conversationHistory={conversationHistory}
              />
            </div>
          </div>
        )}
      </div>

      {/* Agent Status Bar - compact status display for agent mode */}
      <AgentStatusBar 
        isVisible={agentStatusVisible}
        isThinking={isThinking}
        userMessage={agentUserMessage}
      />

      {/* Accessibility Permissions Dialog */}
      {showPermissionsDialog && (
        <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div 
            className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl pointer-events-auto"
            onMouseEnter={() => {
              window.ipcRenderer.send('mouse:enter-interactive');
            }}
            onMouseLeave={() => {
              window.ipcRenderer.send('mouse:leave-interactive');
            }}
          >
            <div className="flex items-center mb-4">
              <div className="w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center mr-3">
                <span className="text-white text-lg">⚠️</span>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">
                Accessibility Permissions Required
              </h3>
            </div>
            
            <p className="text-gray-700 mb-4">
              Agent mode needs accessibility permissions for certain actions:
            </p>
            
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-3">
              <p className="text-sm text-green-800">
                <strong>✅ Good news:</strong> Most web browsing actions now work without permissions!
              </p>
            </div>
            
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
              <p className="text-sm text-yellow-800 font-semibold mb-2">Still need permissions for:</p>
              <ul className="text-sm text-yellow-700 space-y-1">
                <li>• Typing URLs in the address bar</li>
                <li>• Controlling native Mac apps (Calculator, Messages, etc.)</li>
                <li>• Switching between applications</li>
                <li>• Using keyboard shortcuts</li>
              </ul>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-4 mb-4">
              <h4 className="font-semibold text-gray-800 mb-2">How to enable:</h4>
              <ol className="text-sm text-gray-700 space-y-1">
                <li>1. Open <strong>System Settings</strong></li>
                <li>2. Go to <strong>Privacy & Security</strong> → <strong>Accessibility</strong></li>
                <li>3. Click the 🔒 <strong>lock icon</strong> and enter your password</li>
                <li>4. Click <strong>➕ Plus button</strong> and add this app</li>
                <li>5. Make sure it's <strong>✅ checked</strong></li>
              </ol>
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={() => {
                  // Open System Settings directly to accessibility page
                  window.ipcRenderer.send('open-accessibility-settings');
                }}
                onMouseEnter={() => {
                  window.ipcRenderer.send('mouse:enter-interactive');
                }}
                onMouseLeave={() => {
                  window.ipcRenderer.send('mouse:leave-interactive');
                }}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Open Settings
              </button>
              <button
                onClick={() => {
                  setShowPermissionsDialog(false);
                  setHasCheckedPermissions(false); // Allow re-checking
                }}
                onMouseEnter={() => {
                  window.ipcRenderer.send('mouse:enter-interactive');
                }}
                onMouseLeave={() => {
                  window.ipcRenderer.send('mouse:leave-interactive');
                }}
                className="flex-1 bg-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-400 transition-colors"
              >
                Cancel
              </button>
            </div>
            
            <button
              onClick={async () => {
                // Re-check permissions
                const hasPermissions = await checkAccessibilityPermissions();
                if (hasPermissions) {
                  setShowPermissionsDialog(false);
                  // Automatically open agent mode after permissions granted
                  setAgentMode("agent");
                  setIsChatPaneVisible(true);
                  setChatPanelMode('agent');
                }
              }}
              onMouseEnter={() => {
                window.ipcRenderer.send('mouse:enter-interactive');
              }}
              onMouseLeave={() => {
                window.ipcRenderer.send('mouse:leave-interactive');
              }}
              className="w-full mt-3 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
            >
              ✅ I've Enabled Permissions - Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
