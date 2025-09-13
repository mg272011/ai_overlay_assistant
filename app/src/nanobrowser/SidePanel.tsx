/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect } from 'react';
import { type Message, Actors } from './storage';
import './SidePanel.css';

const SidePanel = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isChromeActive, setIsChromeActive] = useState(false);

  // Check if Chrome is active when component mounts
  useEffect(() => {
    try {
      console.log('[NanoBrowser] Component mounted');
      // Temporarily disable Chrome checking to prevent crashes
      setIsChromeActive(false);
    } catch (error) {
      console.error('[NanoBrowser] Error in mount:', error);
    }
  }, []);

  const handleSendMessage = (text: string) => {
    if (!text.trim()) return;
    
    // Add user message
    const userMessage: Message = {
      actor: Actors.USER,
      content: text,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMessage]);
    
    // Add mock response
    setTimeout(() => {
      const responseMessage: Message = {
        actor: Actors.SYSTEM,
        content: 'Command received: ' + text,
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, responseMessage]);
    }, 500);
    
    setInputText('');
  };

  return (
    <div className="h-full w-full flex flex-col bg-white shadow-xl pointer-events-auto">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold">
          {isChromeActive ? '🌐 Chrome Mode' : '🖥️ System Mode'}
        </h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-center text-white mt-8">
            <p className="mb-2">NanoBrowser Agent</p>
            <p className="text-sm">Type a command to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg, idx) => (
              <div key={idx} className={`p-3 rounded ${
                msg.actor === Actors.USER ? 'bg-black/20 text-white' : 'bg-gray-100'
              }`}>
                <div className="text-xs text-white mb-1">{msg.actor}</div>
                <div>{msg.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>

             {/* Input */}
       <div className="p-4 border-t border-gray-200 pointer-events-auto">
         <div className="flex gap-2 pointer-events-auto">
                     <input
             type="text"
             value={inputText}
             onChange={(e) => setInputText(e.target.value)}
             onKeyPress={(e) => {
               if (e.key === 'Enter') {
                 handleSendMessage(inputText);
               }
             }}
             placeholder="Type a command..."
             className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 pointer-events-auto"
             style={{ pointerEvents: 'auto' }}
           />
                     <button
             onClick={() => handleSendMessage(inputText)}
             className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 pointer-events-auto"
             style={{ pointerEvents: 'auto' }}
           >
             Send
           </button>
        </div>
      </div>
    </div>
  );
};

export default SidePanel; 