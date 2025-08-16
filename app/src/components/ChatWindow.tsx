import React, { useState, useEffect, useRef } from 'react';

interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: Date;
  isTyping?: boolean;
}

interface ChatWindowProps {
  isOpen: boolean;
  onClose: () => void;
  onSendMessage: (message: string) => void;
  messages: Message[];
  isThinking: boolean;
  agentMode: string;
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  isOpen,
  onClose: _onClose,
  onSendMessage,
  messages,
  isThinking,
  agentMode: _agentMode
}) => {
  const [inputValue, setInputValue] = useState('');
  const [displayedText, setDisplayedText] = useState<{[key: string]: string}>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Handle word-by-word typing animation for assistant messages (ChatGPT style)
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'assistant' && lastMessage.isTyping) {
      const words = lastMessage.content.split(' ');
      let currentWordIndex = 0;
      
      // Start with empty text
      setDisplayedText(prev => ({
        ...prev,
        [lastMessage.id]: ''
      }));
      
      const typeInterval = setInterval(() => {
        if (currentWordIndex < words.length) {
          const currentText = words.slice(0, currentWordIndex + 1).join(' ');
          setDisplayedText(prev => ({
            ...prev,
            [lastMessage.id]: currentText
          }));
          currentWordIndex++;
        } else {
          clearInterval(typeInterval);
          // Mark typing as complete
          setDisplayedText(prev => ({
            ...prev,
            [lastMessage.id]: lastMessage.content
          }));
          // Remove typing indicator
          lastMessage.isTyping = false;
        }
      }, 120); // ChatGPT-like timing between words

      return () => clearInterval(typeInterval);
    }
  }, [messages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, displayedText, isThinking]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isThinking) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  };

  if (!isOpen) return null;

  return (
    <div className={`fixed inset-x-0 top-16 mx-auto w-[500px] h-[600px] z-40 window-open`}>
      <div className="h-full bg-black/30 backdrop-blur-2xl rounded-2xl border border-white/10 shadow-2xl flex flex-col">
        {/* Messages Area - No header, just messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {messages.map((message) => {
            const displayContent = message.role === 'assistant' && message.isTyping 
              ? (displayedText[message.id] || '')
              : message.content;
            
            return (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} message-enter`}
              >
                {message.role === 'user' ? (
                  // User message - top right style
                  <div className="max-w-[70%] text-right">
                    <div className="inline-block bg-blue-600 text-white px-4 py-2 rounded-2xl rounded-tr-sm">
                      <p className="text-sm whitespace-pre-wrap">{displayContent}</p>
                    </div>
                    <div className="text-xs text-white/40 mt-1">You</div>
                  </div>
                ) : (
                  // Assistant message - left side
                  <div className="max-w-[70%]">
                                         <div className="inline-block bg-white/10 text-white px-4 py-2 rounded-2xl rounded-tl-sm">
                       <p className="text-sm whitespace-pre-wrap">
                         {displayContent}
                         {message.isTyping && displayContent && (
                           <span className="inline-block w-0.5 h-4 bg-white/80 ml-0.5 animate-pulse"></span>
                         )}
                       </p>
                     </div>
                    <div className="text-xs text-white/40 mt-1">Assistant</div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Thinking state with glare */}
          {isThinking && (
            <div className="flex justify-start message-enter">
              <div className="bg-white/10 text-white px-4 py-3 rounded-2xl rounded-tl-sm">
                <p className="text-sm thinking-text">Thinking...</p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-white/10">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Type your message..."
              disabled={isThinking}
              className="flex-1 bg-white/5 text-white placeholder-white/40 px-4 py-2 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-white/20 transition-all"
            />
            <button
              type="submit"
              disabled={!inputValue.trim() || isThinking}
              className="p-2 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ChatWindow; 