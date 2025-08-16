/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from 'react';

const AskAgent = () => {
  const [inputText, setInputText] = useState('');
  const [lastResponse, setLastResponse] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSendMessage = async (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText) return;

    try {
      setIsProcessing(true);
      setLastResponse('Processing your request...');

      // Send message via IPC for screen analysis
      window.ipcRenderer.send('ask-message', text);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Ask error', errorMessage);
      setIsProcessing(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    
    const text = inputText;
    setInputText('');
    handleSendMessage(text);
  };

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    
    const textarea = e.target;
    textarea.style.height = '40px';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 40), 120);
    textarea.style.height = newHeight + 'px';
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  // Listen for responses
  useEffect(() => {
    const handleResponse = (_event: any, response: string) => {
      setLastResponse(response);
      setIsProcessing(false);
    };

    window.ipcRenderer.on('ask-response', handleResponse);
    return () => {
      window.ipcRenderer.removeListener('ask-response', handleResponse);
    };
  }, []);

  return (
    <div className="w-full">
      <div className="relative w-full">
        {lastResponse && (
          <div className="mb-3 p-3 rounded-xl bg-white/10 text-white text-sm">
            {lastResponse}
          </div>
        )}

        {/* Processing State - identical to ChromeAgent */}
        {isProcessing ? (
          <div className="flex items-center gap-2 text-white px-4 py-3" style={{
            background: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
            border: '0.5px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '12px'
          }}>
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
            <span className="text-sm">Processing...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask me about your screen..."
              disabled={isProcessing}
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
            
            {/* Submit Button - identical to ChromeAgent */}
            <button
              type="submit"
              disabled={!inputText.trim() || isProcessing}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleSubmit(e as any);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center transition-opacity pointer-events-auto"
              style={{ 
                background: 'rgba(255, 255, 255, 0.1)', 
                border: 'none',
                opacity: (!inputText.trim() || isProcessing) ? 0.3 : 0.8,
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
        )}
      </div>
    </div>
  );
};

export default AskAgent; 