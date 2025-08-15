import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

interface ChatInputProps {
  onSendMessage: (text: string) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (setter: (text: string) => void) => void;
  isDarkMode?: boolean;
  // Historical session ID - if provided, shows replay button instead of send button
  historicalSessionId?: string | null;
  onReplay?: (sessionId: string) => void;
}

export default function ChatInput({
  onSendMessage,
  onStopTask,
  onMicClick,
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  isDarkMode = false,
  historicalSessionId,
  onReplay,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const isSendButtonDisabled = useMemo(() => disabled || text.trim() === '', [disabled, text]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Handle text changes and resize textarea
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);

    // Resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
    }
  };

  // Expose a method to set content from outside
  useEffect(() => {
    if (setContent) {
      setContent(setText);
    }
  }, [setContent]);

  // Initial resize when component mounts
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
    }
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (text.trim()) {
        onSendMessage(text);
        setText('');
      }
    },
    [text, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  return (
    <form
      onSubmit={handleSubmit}
      className={`overflow-hidden rounded-lg border transition-colors ${disabled ? 'cursor-not-allowed' : 'focus-within:border-sky-400 hover:border-sky-400'} ${isDarkMode ? 'border-slate-700' : ''}`}
      aria-label="Chat input form">
      <div className="flex flex-col">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-disabled={disabled}
          rows={5}
          className={`w-full resize-none border-none p-2 focus:outline-none ${
            disabled
              ? isDarkMode
                ? 'cursor-not-allowed bg-slate-800 text-white'
                : 'cursor-not-allowed bg-gray-100 text-white'
              : isDarkMode
                ? 'bg-slate-800 text-white'
                : 'bg-white text-white'
          }`}
          placeholder="What can I help you with?"
          aria-label="Message input"
        />

        <div
          className={`flex items-center justify-between px-2 py-1.5 ${
            disabled ? (isDarkMode ? 'bg-slate-800' : 'bg-gray-100') : isDarkMode ? 'bg-slate-800' : 'bg-white'
          }`}>
          <div className="flex gap-2 text-white">
            {onMicClick && (
              <button
                type="button"
                onClick={onMicClick}
                disabled={disabled || isProcessingSpeech}
                aria-label={
                  isProcessingSpeech ? 'Processing speech...' : isRecording ? 'Stop recording' : 'Start voice input'
                }
                className={`rounded-md p-1.5 transition-colors ${
                  disabled || isProcessingSpeech
                    ? 'cursor-not-allowed opacity-50'
                    : isRecording
                      ? 'bg-red-500 text-white hover:bg-red-600'
                      : isDarkMode
                        ? 'hover:bg-slate-700 text-white hover:text-white'
                        : 'hover:bg-gray-100 text-white hover:text-white'
                }`}>
                {isProcessingSpeech ? (
                  <AiOutlineLoading3Quarters className="h-4 w-4 animate-spin" />
                ) : (
                  <FaMicrophone className={`h-4 w-4 ${isRecording ? 'animate-pulse' : ''}`} />
                )}
              </button>
            )}
          </div>

          {showStopButton ? (
            <button
              type="button"
              onClick={onStopTask}
              className="rounded-md bg-red-500 px-3 py-1 text-white transition-colors hover:bg-red-600">
              Stop
            </button>
          ) : historicalSessionId ? (
            <button
              type="button"
              onClick={handleReplay}
              disabled={!historicalSessionId}
              aria-disabled={!historicalSessionId}
              className={`rounded-md bg-green-500 px-3 py-1 text-white transition-colors hover:enabled:bg-green-600 ${!historicalSessionId ? 'cursor-not-allowed opacity-50' : ''}`}>
              Replay
            </button>
          ) : (
            <button
              type="submit"
              disabled={isSendButtonDisabled}
              aria-disabled={isSendButtonDisabled}
              className={`rounded-md bg-[#19C2FF] px-3 py-1 text-white transition-colors hover:enabled:bg-[#0073DC] ${isSendButtonDisabled ? 'cursor-not-allowed opacity-50' : ''}`}>
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
