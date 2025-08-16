/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from 'react';

interface ChromeAgentProps {
  onMessageSent?: (message: string) => void;
}

const ChromeAgent = ({ onMessageSent }: ChromeAgentProps) => {
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check for pending tasks from MacOSAgent or main process
  useEffect(() => {
    // Check for pending task from MacOSAgent in localStorage
    const pendingTask = localStorage.getItem('pendingAgentTask');
    if (pendingTask) {
      setInputText(pendingTask);
      localStorage.removeItem('pendingAgentTask');
      
      // Focus and execute the task
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        }
        handleSendMessage(pendingTask);
      }, 500);
      return;
    }
    
    // Also check for pending task from main process
    window.ipcRenderer.invoke('get-pending-agent-task').then((task: string | null) => {
      if (task) {
        setInputText(task);
        // Clear the task from main process
        window.ipcRenderer.send('clear-pending-agent-task');
        
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
          }
          handleSendMessage(task);
        }, 500);
      }
    }).catch(() => {
      // Ignore errors - task may not exist
    });
  }, []);

  const handleSendMessage = async (text: string) => {
    // Trim the input text first
    const trimmedText = text.trim();
    if (!trimmedText) return;

    try {
      // Notify parent component that a message was sent (to show chat panel)
      if (onMessageSent) {
        onMessageSent(trimmedText);
      }

      // Send message to Chrome via IPC
      window.ipcRenderer.send('nanobrowser-command', text);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
    }
  };



  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    
    const text = inputText;
    setInputText('');
    handleSendMessage(text);
  };

  // Auto-resize textarea to expand downward
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    
    // Auto-resize - expand downward when typing
    const textarea = e.target;
    textarea.style.height = '40px'; // Reset to minimum
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 40), 120); // Min 40px, max 120px
    textarea.style.height = newHeight + 'px';
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };



  return (
    <div className="w-full">
      <div className="relative w-full">
        <form onSubmit={handleSubmit} className="relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="What do you want to automate"
              onFocus={() => {
                window.ipcRenderer.send('chat:focus');
                if (inputRef.current) {
                  inputRef.current.style.pointerEvents = 'auto';
                }
              }}
              className="glass-input w-full resize-none overflow-hidden pr-12"
              style={{ 
                minHeight: '40px', 
                maxHeight: '120px',
                background: 'rgba(0, 0, 0, 0.3)',
                backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                border: '0.5px solid rgba(255, 255, 255, 0.3)',
                borderRadius: '12px',
                wordWrap: 'break-word',
                whiteSpace: 'pre-wrap'
              }}
              rows={1}
            />
            
            {/* Submit Button */}
            <button
              type="submit"
              disabled={!inputText.trim()}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleSubmit(e as any);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center transition-opacity pointer-events-auto"
              style={{ 
                background: 'rgba(255, 255, 255, 0.1)', 
                border: 'none',
                opacity: !inputText.trim() ? 0.3 : 0.8,
                pointerEvents: 'auto',
                zIndex: 10
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4z"/>
                <path d="M22 2 11 13"/>
              </svg>
            </button>
          </form>
        </div>
      </div>
    );
};

export default ChromeAgent; 