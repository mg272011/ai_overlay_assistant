import { useState, useRef } from 'react';

interface MacOSAgentProps {
  onMessageSent?: (message: string) => void;
  conversationHistory?: Array<{role: 'user' | 'assistant', content: string}>;
}

const MacOSAgent = ({ onMessageSent, conversationHistory }: MacOSAgentProps) => {
  const [inputText, setInputText] = useState('');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && uploadedImages.length === 0) return;
    
    const text = inputText;
    setInputText('');

    // Notify parent component that a message was sent (to show chat panel)
    if (onMessageSent) {
      onMessageSent(text || "Uploaded images with automation request");
    }

    // If we have images, include them in the command
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
      
      // Send to Gemini API for intelligent processing with images
      window.ipcRenderer.send('gemini-macos-command', text, conversationHistory);
      
      // Clear uploaded images after sending
      setUploadedImages([]);
    } else {
      // Send to Gemini API for intelligent processing
      window.ipcRenderer.send('gemini-macos-command', text, conversationHistory);
    }
    
    // Store current task in case we need to switch to Chrome
    localStorage.setItem('pendingAgentTask', text);
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
            placeholder={uploadedImages.length > 0 ? "Describe automation task with these images..." : "Describe what you'd like to automate on your computer"}
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

          <button
            type="submit"
            disabled={(!inputText.trim() && uploadedImages.length === 0)}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleSubmit(e as any);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 flex items-center justify-center gap-1 transition-opacity pointer-events-auto text-xs"
            style={{ 
              background: 'transparent', 
              border: 'none',
              opacity: (!inputText.trim() && uploadedImages.length === 0) ? 0.3 : 0.8,
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
};

export default MacOSAgent; 