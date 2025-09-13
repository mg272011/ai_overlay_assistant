/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

interface AskAgentProps {
  onMessageSent?: (message: string) => void;
}

export interface AskAgentHandle {
  focus: () => void;
}

const AskAgent = forwardRef<AskAgentHandle, AskAgentProps>(({ onMessageSent }, ref) => {
  const [inputText, setInputText] = useState('');
  const [lastResponse, setLastResponse] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<File[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
      setUploadedImages(prev => [...prev, ...imageFiles]);
    }
  };

  const removeImage = (index: number) => {
    setUploadedImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSendMessage = async (text: string) => {
    const trimmedText = text.trim();
    if (!trimmedText && uploadedImages.length === 0) return;

    try {
      setIsProcessing(true);
      setLastResponse(''); // Clear previous response

      // Notify parent component that a message was sent (to show chat panel)
      if (onMessageSent) {
        onMessageSent(trimmedText || "Uploaded images");
      }

      // If we have images, send them via IPC
      if (uploadedImages.length > 0) {
        const imageData = await Promise.all(
          uploadedImages.map(async (file) => {
            return new Promise<{name: string, data: string}>((resolve) => {
              const reader = new FileReader();
              reader.onload = (e) => {
                resolve({
                  name: file.name,
                  data: e.target?.result as string
                });
              };
              reader.readAsDataURL(file);
            });
          })
        );
        
        // First send images
        window.ipcRenderer.send('images-uploaded', { images: imageData });
        
        // Then send message with images mode
        (window.ipcRenderer.sendMessage as any)(trimmedText, { 
          mode: "chat"
        });
        
        // Clear uploaded images after sending
        setUploadedImages([]);
      } else {
        // Send message via IPC for screen analysis
        (window.ipcRenderer.sendMessage as any)(text, { mode: "chat" });
      }

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

  // Expose focus method to parent component
  useImperativeHandle(ref, () => ({
    focus: () => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }));

  // Listen for responses
  useEffect(() => {
    const handleResponse = (_event: any, response: string) => {
      setLastResponse(response);
      setIsProcessing(false);
    };

    const handleStream = (_event: any, data: { type: string; content?: string }) => {
      if (data.type === 'text' && data.content) {
        // Accumulate streaming text
        setLastResponse(prev => prev + data.content);
      } else if (data.type === 'stream_end') {
        // Stream finished
        setIsProcessing(false);
      }
    };

    window.ipcRenderer.on('ask-response', handleResponse);
    window.ipcRenderer.on('stream', handleStream);
    return () => {
      window.ipcRenderer.removeListener('ask-response', handleResponse);
      window.ipcRenderer.removeListener('stream', handleStream);
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

        {/* Image previews */}
        {uploadedImages.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {uploadedImages.map((image, index) => (
              <div key={index} className="relative group">
                <img
                  src={URL.createObjectURL(image)}
                  alt={`Upload ${index + 1}`}
                  className="w-16 h-16 object-cover rounded-lg border border-white/20"
                />
                <button
                  onClick={() => removeImage(index)}
                  className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="relative">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={uploadedImages.length > 0 ? "Ask about these images..." : "Ask questions about what's visible on your screen"}
            disabled={isProcessing}
            onFocus={() => {
              window.ipcRenderer.send('chat:focus');
              if (inputRef.current) {
                inputRef.current.style.pointerEvents = 'auto';
              }
            }}
            className="glass-input w-full resize-none overflow-hidden pr-24"
            style={{ 
              minHeight: '40px', 
              maxHeight: '120px',
              background: 'rgba(0, 0, 0, 0.3)',
              backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
              border: '0.5px solid rgba(255, 255, 255, 0.3)',
              borderRadius: '12px',
              wordWrap: 'break-word',
              whiteSpace: 'pre-wrap',
              display: 'flex',
              alignItems: 'center'
            }}
            rows={1}
          />
          
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileUpload}
            className="hidden"
          />
          
          {/* Photo upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onMouseEnter={() => {
              window.ipcRenderer.send('mouse:enter-interactive');
            }}
            onMouseLeave={() => {
              window.ipcRenderer.send('mouse:leave-interactive');
            }}
            className="absolute right-16 top-1/2 -translate-y-1/2 p-1 transition-opacity pointer-events-auto"
            style={{ 
              background: 'transparent', 
              border: 'none',
              opacity: 0.7,
              pointerEvents: 'auto',
              zIndex: 10,
              color: 'white'
            }}
            title="Upload photos"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          
          {/* Submit Button */}
          <button
            type="submit"
            disabled={(!inputText.trim() && uploadedImages.length === 0) || isProcessing}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleSubmit(e as any);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 flex items-center justify-center gap-1 transition-opacity pointer-events-auto text-xs"
            style={{ 
              background: 'transparent', 
              border: 'none',
              opacity: ((!inputText.trim() && uploadedImages.length === 0) || isProcessing) ? 0.3 : 0.8,
              pointerEvents: 'auto',
              zIndex: 10,
              color: 'white'
            }}
          >
            <span>send</span>
            <span style={{ fontSize: '10px', opacity: 0.7 }}>↵</span>
          </button>
        </form>
      </div>
    </div>
  );
});

AskAgent.displayName = 'AskAgent';

export default AskAgent; 