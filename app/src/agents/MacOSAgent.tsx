import { useState, useRef, useEffect } from 'react';

const MacOSAgent = () => {
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastResponse, setLastResponse] = useState<string>('');
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
    if (!inputText.trim() || isProcessing) return;
    
    const text = inputText;
    setInputText('');
    setIsProcessing(true);
    setLastResponse(''); // Clear previous response

    // Send to Gemini API for intelligent processing
    window.ipcRenderer.send('gemini-macos-command', text);
    
    // Listen for response
    const handleResponse = (_event: any, response: { type: 'conversation' | 'applescript', content: string, applescript?: string }) => {
      setIsProcessing(false);
      setLastResponse(response.content);
      console.log('[MacOS Agent] Response:', response.content);
    };
    
    window.ipcRenderer.once('gemini-macos-response', handleResponse);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Agent Input Bar */}
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
              placeholder="Chat or give browser commands..."
              disabled={isProcessing}
              onFocus={(e) => {
                e.target.style.pointerEvents = 'auto';
              }}
              className="dark-input pr-14 app-region-no-drag w-full pointer-events-auto"
              style={{ pointerEvents: 'auto' }}
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

export default MacOSAgent; 