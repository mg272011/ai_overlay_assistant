/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react';
import { FiSettings } from 'react-icons/fi';
import { PiPlusBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import { type Message, Actors, chatHistoryStore } from '../nanobrowser/storage';
import favoritesStorage, { type FavoritePrompt } from '../nanobrowser/storage';
import MessageList from '../nanobrowser/components/MessageList';
import ChatInput from '../nanobrowser/components/ChatInput';
import ChatHistoryList from '../nanobrowser/components/ChatHistoryList';
import BookmarkList from '../nanobrowser/components/BookmarkList';
import '../nanobrowser/SidePanel.css';

// IPC is already declared in types/electron.d.ts

const ChromeAgent = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [_isFollowUpMode, _setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const [_hasConfiguredModels, _setHasConfiguredModels] = useState<boolean>(true); // Always true for Electron
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, _setIsReplaying] = useState(false);
  const [replayEnabled, _setReplayEnabled] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    // Don't save progress messages
    const isProgressMessage = newMessage.content === 'Showing progress...';

    setMessages(prev => {
      const filteredMessages = prev.filter(
        (msg, idx) => !(msg.content === 'Showing progress...' && idx === prev.length - 1),
      );
      return [...filteredMessages, newMessage];
    });

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    // Save message to storage if we have a session and it's not a progress message
    if (effectiveSessionId && !isProgressMessage) {
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const handleSendMessage = async (text: string) => {
    console.log('handleSendMessage', text);

    // Trim the input text first
    const trimmedText = text.trim();

    if (!trimmedText) return;

    // Block sending messages in historical sessions
    if (isHistoricalSession) {
      console.log('Cannot send messages in historical sessions');
      return;
    }

    try {
      setInputEnabled(false);
      setShowStopButton(true);

      // Create a new chat session for this task
      const newSession = await chatHistoryStore.createSession(
        text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      );
      console.log('newSession', newSession);

      // Store the session ID in both state and ref
      const sessionId = newSession.id;
      setCurrentSessionId(sessionId);
      sessionIdRef.current = sessionId;

      const userMessage = {
        actor: Actors.USER,
        content: text,
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Send message to Chrome via IPC
      window.ipcRenderer.send('nanobrowser-command', text);
      
      // Listen for response
      const handleResponse = (_event: any, response: string) => {
        const assistantMessage: Message = {
          actor: Actors.NAVIGATOR,
          content: response,
          timestamp: Date.now()
        };
        appendMessage(assistantMessage);
        setInputEnabled(true);
        setShowStopButton(false);
      };
      
      window.ipcRenderer.once('nanobrowser-response', handleResponse);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
      setShowStopButton(false);
    }
  };

  const handleStopTask = async () => {
    try {
      window.ipcRenderer.send('nanobrowser-stop');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    _setIsFollowUpMode(false);
    setIsHistoricalSession(false);
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a: any, b: any) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      _setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setMessages(fullSession.messages);
        _setIsFollowUpMode(false);
        setIsHistoricalSession(true); // Mark this as a historical session
        console.log('history session selected', sessionId);
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);

      if (fullSession && fullSession.messages.length > 0) {
        // Get the session title
        const sessionTitle = fullSession.title;
        // Get the first 8 words of the title
        const title = sessionTitle.split(' ').slice(0, 8).join(' ');

        // Get the first message content (the task)
        const taskContent = fullSession.messages[0]?.content || '';

        // Add to favorites storage
        await favoritesStorage.addPrompt(title, taskContent);

        // Update favorites in the UI
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);

        // Return to chat view after pinning
        handleBackToChat(true);
      }
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (setInputTextRef.current) {
      setInputTextRef.current(content);
    }
  };

  const handleBookmarkUpdateTitle = async (id: number, title: string) => {
    try {
      await favoritesStorage.updatePromptTitle(id, title);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt title:', error);
    }
  };

  const handleBookmarkDelete = async (id: number) => {
    try {
      await favoritesStorage.removePrompt(id);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to delete favorite prompt:', error);
    }
  };

  const handleBookmarkReorder = async (draggedId: number, targetId: number) => {
    try {
      await favoritesStorage.reorderPrompts(draggedId, targetId);

      // Fetch the updated list from storage
      const updatedPromptsFromStorage = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(updatedPromptsFromStorage);
    } catch (error) {
      console.error('Failed to reorder favorite prompts:', error);
    }
  };

  const handleReplay = async (_historySessionId: string): Promise<void> => {
    // Simplified replay for Electron
    appendMessage({
      actor: Actors.SYSTEM,
      content: 'Replay feature not available in this version',
      timestamp: Date.now(),
    });
  };

  // Load favorite prompts from storage
  useEffect(() => {
    const loadFavorites = async () => {
      try {
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);
      } catch (error) {
        console.error('Failed to load favorite prompts:', error);
      }
    };

    loadFavorites();
  }, []);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleMicClick = async () => {
    // Simplified for Electron - just toggle recording state
    if (isRecording) {
      setIsRecording(false);
      setIsProcessingSpeech(true);
      // Simulate processing
      setTimeout(() => {
        setIsProcessingSpeech(false);
        if (setInputTextRef.current) {
          setInputTextRef.current('Voice input processed');
        }
      }, 1000);
    } else {
      setIsRecording(true);
    }
  };

  const [inputText, setInputText] = useState('');
  const [lastResponse, setLastResponse] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus when component mounts (like Ask mode)
  useEffect(() => {
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 100);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !inputEnabled || isHistoricalSession) return;
    
    const text = inputText;
    setInputText('');
    setLastResponse(''); // Clear previous response
    setIsProcessing(true);
    handleSendMessage(text);
  };

  // Listen for nanobrowser responses
  useEffect(() => {
    const handleResponse = (_event: any, response: string) => {
      setLastResponse(response);
      setIsProcessing(false);
    };

    window.ipcRenderer.on('nanobrowser-response', handleResponse);
    
    return () => {
      window.ipcRenderer.removeListener('nanobrowser-response', handleResponse);
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {/* Chrome Agent Input Bar */}
      <div className="dark-input-bar rounded-full p-3">
        {isProcessing ? (
          <div className="flex items-center gap-2 text-white px-4 py-2">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
            <span className="text-sm">Processing...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="relative">
            <input
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Browser commands with full nanobrowser power..."
              disabled={!inputEnabled || isHistoricalSession}
              onFocus={(e) => {
                e.target.style.pointerEvents = 'auto';
              }}
              className="dark-input pr-14 app-region-no-drag w-full pointer-events-auto" style={{ pointerEvents: 'auto' }}
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
        )}
      </div>

      {/* Response Area */}
      {lastResponse && (
        <div className="dark-panel rounded-2xl p-4 max-w-md">
          <div className="text-white text-sm leading-relaxed">
            {lastResponse}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChromeAgent; 