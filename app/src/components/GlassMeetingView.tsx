import React, { useState, useEffect, useRef } from 'react';
import type { ContextualAction, MeetingSuggestion } from '../../electron/services/ContextualActionsService';

interface ConversationTurn {
  id?: string;
  speaker: string;
  text: string;
  timestamp: Date;
  isPartial?: boolean;
  isFinal?: boolean;
}

interface AnalysisResult {
  topic: {
    header: string;
    description: string;
  };
  summary: string[];
  actions: string[];
  questions: string[];
  keyPoints: string[];
  timestamp: Date;
}

interface GlassMeetingViewProps {
  onActionClick?: (action: string) => void;
}

export const GlassMeetingView: React.FC<GlassMeetingViewProps> = ({ onActionClick }) => {
  void onActionClick;
  const [conversationHistory, setConversationHistory] = useState<ConversationTurn[]>([]);
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisResult | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [_status, setStatus] = useState('Ready');
  const [currentTranscript, setCurrentTranscript] = useState<{me?: ConversationTurn, them?: ConversationTurn}>({});
  const [viewMode, setViewMode] = useState<'transcript' | 'insights'>('transcript');
  const [elapsedTime, setElapsedTime] = useState('00:00');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [isHovering, setIsHovering] = useState(false);
  const [searchItems, setSearchItems] = useState<ContextualAction[]>([]);
  const [suggestions, setSuggestions] = useState<MeetingSuggestion[]>([]);
  
  // Debug state changes and force re-render
  useEffect(() => {
    console.log('[Glass Meeting View] searchItems state updated:', searchItems);
    console.log('[Glass Meeting View] searchItems length:', searchItems.length);
  }, [searchItems]);
  
  useEffect(() => {
    console.log('[Glass Meeting View] 🔴 SUGGESTIONS STATE CHANGED:', suggestions);
    console.log('[Glass Meeting View] 🔴 SUGGESTIONS LENGTH:', suggestions.length);
    console.log('[Glass Meeting View] 🔴 SUGGESTIONS CONTENT:', suggestions.map(s => s.text || s));
    console.log('[Glass Meeting View] 🔴 VIEW MODE:', viewMode);
    console.log('[Glass Meeting View] 🔴 SHOULD RENDER:', viewMode === 'transcript' && suggestions.length > 0);
  }, [suggestions, viewMode]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number | null>(null);

  // Timer effect
  useEffect(() => {
    if (isListening && !startTimeRef.current) {
      startTimeRef.current = Date.now();
    } else if (!isListening) {
      startTimeRef.current = null;
    }

    const interval = isListening ? setInterval(() => {
      if (startTimeRef.current) {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        setElapsedTime(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
      }
    }, 1000) : null;

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isListening]);

  useEffect(() => {
    // Listen for Glass JavaScript meeting events from main process
    
    // Real-time STT updates (partial and final)
    const handleSTTUpdate = (_: any, data: { speaker: string; text: string; isPartial: boolean; isFinal: boolean; timestamp: number }) => {
      console.log('[Glass Meeting View] STT update:', data);
      
      const turn: ConversationTurn = {
        id: `${data.speaker}-${data.timestamp}`,
        speaker: data.speaker,
        text: data.text,
        timestamp: new Date(data.timestamp),
        isPartial: data.isPartial,
        isFinal: data.isFinal
      };

      if (data.isPartial) {
        // Update current transcript display for real-time feedback
        setCurrentTranscript(prev => ({
          ...prev,
          [data.speaker.toLowerCase()]: turn
        }));
      }
      
      if (data.isFinal) {
        // Clear current transcript when final
        setCurrentTranscript(prev => ({
          ...prev,
          [data.speaker.toLowerCase()]: undefined
        }));
      }
    };
    
    // Final transcription complete
    const handleTranscriptionComplete = (_: any, turn: ConversationTurn) => {
      console.log('[Glass Meeting View] Transcription complete:', turn);
      setConversationHistory(prev => {
        // Keep only last 20 messages to prevent endless scrolling
        const updated = [...prev, turn];
        if (updated.length > 20) {
          return updated.slice(-20);
        }
        return updated;
      });
      
      // NO LONGER trigger contextual actions here - wait for analysis instead
      // This prevents generating bad search actions on every single transcription
      
      // Auto-scroll to bottom
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    };

    // Analysis updates
    const handleAnalysisUpdate = (_: any, analysis: AnalysisResult) => {
      console.log('[Glass Meeting View] Analysis update:', analysis);
      setCurrentAnalysis(analysis);
      
      // Extract questions as suggestions
      if (analysis.questions && analysis.questions.length > 0) {
        console.log('[Glass Meeting View] Found questions in analysis:', analysis.questions);
        const questionSuggestions = analysis.questions.map((q, i) => ({
          id: `question-${i}`,
          text: q,
          type: 'question' as const,
          confidence: 1
        }));
        setSuggestions(questionSuggestions);
        console.log('[Glass Meeting View] Set suggestions from analysis questions:', questionSuggestions);
      }
      
      // NOW trigger contextual actions since we have proper analysis/summary
      if (analysis.summary && analysis.summary.length > 0) {
        console.log('[Glass Meeting View] Analysis ready, triggering contextual actions');
        const recentConversation = conversationHistory.slice(-3).map(turn => turn.text).join(' ');
        if (recentConversation.length > 50) {
          window.ipcRenderer.send('generate-contextual-actions', { 
            text: recentConversation, 
            speaker: 'analysis' 
          });
        }
      }
    };
    
    // Analysis complete (same as update but for clarity)
    const handleAnalysisComplete = (_: any, analysis: AnalysisResult) => {
      console.log('[Glass Meeting View] Analysis complete:', analysis);
      setCurrentAnalysis(analysis);
      
      // Extract questions as suggestions
      if (analysis.questions && analysis.questions.length > 0) {
        console.log('[Glass Meeting View] Found questions in analysis complete:', analysis.questions);
        const questionSuggestions = analysis.questions.map((q, i) => ({
          id: `question-complete-${i}`,
          text: q,
          type: 'question' as const,
          confidence: 1
        }));
        setSuggestions(questionSuggestions);
        console.log('[Glass Meeting View] Set suggestions from analysis complete:', questionSuggestions);
      }
      
      // Trigger contextual actions with the full analysis context
      if (analysis.summary && analysis.summary.length > 0) {
        console.log('[Glass Meeting View] Analysis complete, triggering final contextual actions');
        const fullContext = analysis.summary.join(' ') + ' ' + conversationHistory.slice(-2).map(turn => turn.text).join(' ');
        window.ipcRenderer.send('generate-contextual-actions', { 
          text: fullContext, 
          speaker: 'analysis-complete' 
        });
      }
    };

    // Status updates
    const handleStatusUpdate = (_: any, statusText: string) => {
      console.log('[Glass Meeting View] Status:', statusText);
      setStatus(statusText);
    };

    // Session state changes
    const handleSessionInitialized = (_: any, data: { sessionId: string; timestamp: Date }) => {
      console.log('[Glass Meeting View] Session initialized:', data);
      setIsListening(true);
      setConversationHistory([]);
      setCurrentAnalysis(null);
      setElapsedTime('00:00');
    };
    
    const handleSessionClosed = (_: any) => {
      console.log('[Glass Meeting View] Session closed');
      setIsListening(false);
    };
    
    // Live audio ready/error
    const handleLiveAudioReady = () => {
      console.log('[Glass Meeting View] Live audio ready');
      setIsListening(true);
    };
    
    const handleLiveAudioError = (_: any, error: string) => {
      console.log('[Glass Meeting View] Live audio error:', error);
      setIsListening(false);
      setStatus(`Error: ${error}`);
    };
    
    const handleLiveAudioStopped = () => {
      console.log('[Glass Meeting View] Live audio stopped');
      setIsListening(false);
    };

    // Contextual search items from ContextualActions service
    const handleContextualSearch = (_: any, data: any) => {
      console.log('[Glass Meeting View] 🔍 ===== CONTEXTUAL SEARCH EVENT RECEIVED =====');
      console.log('[Glass Meeting View] 🔍 Raw contextual search data:', JSON.stringify(data, null, 2));
      
      // Handle both array and object with searchItems property
      const items = Array.isArray(data) ? data : (data?.searchItems || data);
      console.log('[Glass Meeting View] 🔍 Processed search items:', JSON.stringify(items, null, 2));
      
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
        console.log('[Glass Meeting View] 🔍 ✅ SET search items from ContextualActions:', JSON.stringify(formattedItems, null, 2));
        console.log('[Glass Meeting View] 🔍 ✅ Current searchItems state after setting:', formattedItems.length);
      } else {
        console.log('[Glass Meeting View] 🔍 ❌ No search items to display from ContextualActions - items:', items);
        console.log('[Glass Meeting View] 🔍 ❌ Array.isArray(items):', Array.isArray(items));
        console.log('[Glass Meeting View] 🔍 ❌ items?.length:', items?.length);
      }
    };

    // Meeting suggestions - DO NOT OVERWRITE WITH EMPTY DATA
    const handleContextualSuggestions = (_: any, data: any) => {
      console.log('[Glass Meeting View] 🌟 ===== CONTEXTUAL SUGGESTIONS EVENT RECEIVED =====');
      console.log('[Glass Meeting View] 🌟 Raw contextual suggestions data:', JSON.stringify(data, null, 2));
      console.log('[Glass Meeting View] 🌟 Current suggestions before update:', suggestions);
      
      // IMPORTANT: Ignore empty arrays from ContextualActions service
      if (Array.isArray(data) && data.length === 0) {
        console.log('[Glass Meeting View] 🌟 ❌ IGNORING empty contextual suggestions array - keeping existing questions');
        return; // DO NOT overwrite existing suggestions with empty array
      }
      
      // Handle various data formats
      let items = data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // If it's an object, try to extract suggestions/questions array
        items = data.suggestions || data.questions || data.items || data;
      }
      
      console.log('[Glass Meeting View] 🌟 Processed contextual suggestions:', JSON.stringify(items, null, 2));
      
      // Only set if we have actual items (not empty array)
      if (Array.isArray(items) && items.length > 0) {
        setSuggestions(items);
        console.log('[Glass Meeting View] 🌟 ✅ SET suggestions state with', items.length, 'contextual items');
      } else if (items && typeof items === 'object' && Object.keys(items).length > 0) {
        // If still an object with content, try to convert to array
        setSuggestions([items]);
        console.log('[Glass Meeting View] SET suggestions state with single contextual item wrapped in array');
      } else {
        console.log('[Glass Meeting View] Ignoring empty contextual suggestions data - keeping existing');
      }
    };

    // Register all Glass JavaScript meeting event listeners
    window.ipcRenderer.on('stt-update', handleSTTUpdate);
    window.ipcRenderer.on('transcription-complete', handleTranscriptionComplete);
    window.ipcRenderer.on('analysis-update', handleAnalysisUpdate);
    window.ipcRenderer.on('analysis-complete', handleAnalysisComplete);
    window.ipcRenderer.on('update-status', handleStatusUpdate);
    window.ipcRenderer.on('session-initialized', handleSessionInitialized);
    window.ipcRenderer.on('session-closed', handleSessionClosed);
    window.ipcRenderer.on('live-audio-ready', handleLiveAudioReady);
    window.ipcRenderer.on('live-audio-error', handleLiveAudioError);
    window.ipcRenderer.on('live-audio-stopped', handleLiveAudioStopped);
    window.ipcRenderer.on('contextual-search', handleContextualSearch);
    window.ipcRenderer.on('contextual-suggestions', handleContextualSuggestions);

    return () => {
      window.ipcRenderer.off('stt-update', handleSTTUpdate);
      window.ipcRenderer.off('transcription-complete', handleTranscriptionComplete);
      window.ipcRenderer.off('analysis-update', handleAnalysisUpdate);
      window.ipcRenderer.off('analysis-complete', handleAnalysisComplete);
      window.ipcRenderer.off('update-status', handleStatusUpdate);
      window.ipcRenderer.off('session-initialized', handleSessionInitialized);
      window.ipcRenderer.off('session-closed', handleSessionClosed);
      window.ipcRenderer.off('live-audio-ready', handleLiveAudioReady);
      window.ipcRenderer.off('live-audio-error', handleLiveAudioError);
      window.ipcRenderer.off('live-audio-stopped', handleLiveAudioStopped);
      window.ipcRenderer.off('contextual-search', handleContextualSearch);
      window.ipcRenderer.off('contextual-suggestions', handleContextualSuggestions);
    };
  }, []);

  const toggleViewMode = () => {
    setViewMode(prev => prev === 'transcript' ? 'insights' : 'transcript');
  };

  const handleCopy = () => {
    let textToCopy = '';
    
    if (viewMode === 'transcript') {
      textToCopy = conversationHistory
        .map(turn => `${turn.speaker}: ${turn.text}`)
        .join('\n');
    } else if (currentAnalysis) {
      textToCopy = `Topic: ${currentAnalysis.topic.header}\n${currentAnalysis.topic.description}\n\n`;
      if (currentAnalysis.keyPoints.length > 0) {
        textToCopy += `Key Points:\n${currentAnalysis.keyPoints.map(p => `• ${p}`).join('\n')}\n\n`;
      }
      if (currentAnalysis.actions.length > 0) {
        textToCopy += `Action Items:\n${currentAnalysis.actions.map(a => `✓ ${a}`).join('\n')}\n\n`;
      }
      if (currentAnalysis.questions.length > 0) {
        textToCopy += `Follow-up Questions:\n${currentAnalysis.questions.map(q => `? ${q}`).join('\n')}`;
      }
    }
    
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const displayText = isHovering
    ? viewMode === 'transcript'
      ? 'Copy Transcript'
      : 'Copy Glass Analysis'
    : viewMode === 'insights'
    ? `Live insights`
            : `Listening... ${elapsedTime}`;

  return (
    <div className="assistant-container">
      {/* Top Bar - Glass style */}
      <div className="top-bar">
        <div className="bar-left-text">
          <span className="bar-left-text-content">{displayText}</span>
        </div>
        <div className="bar-controls">
          <button className="toggle-button" onClick={toggleViewMode}>
            {viewMode === 'insights' ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span>Show Transcript</span>
              </>
            ) : (
              <>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M22 12v7a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                </svg>
                <span>Show Insights</span>
              </>
            )}
          </button>
          <button
            className={`copy-button ${copyState === 'copied' ? 'copied' : ''}`}
            onClick={handleCopy}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            <svg className="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            <svg className="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="content-area">
        {/* Transcript View */}
        {viewMode === 'transcript' && (
          <div className="transcription-container">
            {conversationHistory.length === 0 && !currentTranscript.me && !currentTranscript.them ? (
              <div className="empty-state">Waiting for conversation...</div>
            ) : (
              <div className="messages-container">
                {conversationHistory.map((turn) => (
                  <div
                    key={turn.id}
                    className={`stt-message ${turn.speaker.toLowerCase()}`}
                  >
                    <div className="transcript-text">{turn.text}</div>
                  </div>
                ))}
                
                {/* Show current partial transcripts */}
                {currentTranscript.me && (
                  <div className="stt-message me partial">
                    <div className="transcript-text">{currentTranscript.me.text}</div>
                  </div>
                )}
                {currentTranscript.them && (
                  <div className="stt-message them partial">
                    <div className="transcript-text">{currentTranscript.them.text}</div>
                  </div>
                )}
                <div ref={scrollRef}></div>
              </div>
            )}
            
            {/* Search Items - things mentioned that can be looked up */}
            {searchItems.length > 0 && (
              <div className="contextual-actions-container" style={{ 
                display: 'block',
                marginTop: '8px',
                visibility: 'visible' as any,
                opacity: 1,
                background: 'rgba(0, 0, 0, 0.3)',
                backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                border: '0.5px solid rgba(255, 255, 255, 0.3)',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(31, 38, 135, 0.15), 0 4px 16px rgba(255, 255, 255, 0.1) inset'
              }}>
                <h4 className="contextual-actions-title" style={{ color: '#ffffff' }}>
                  Actions ({searchItems.length} items)
                </h4>
                <div className="contextual-actions-list">
                  {searchItems.map((item, index) => {
                    console.log('[Glass Meeting View] 🟠 RENDERING ACTION:', index, item);
                    return (
                      <div
                        key={item.id || `search-${index}`}
                        className="contextual-action-item"
                        style={{
                          cursor: 'pointer',
                          display: 'block',
                          visibility: 'visible' as any,
                          opacity: 1,
                          background: 'rgba(255, 255, 255, 0.05)',
                          padding: '8px 12px',
                          marginBottom: '4px',
                          borderRadius: '6px',
                          color: '#ffffff'
                        }}
                        onClick={() => {
                          console.log('[Glass Meeting View] 🔍 Action clicked:', item);
                          // Emit event to open search window
                          const event = new CustomEvent('meeting-action-clicked', {
                            detail: {
                              type: 'search',
                              text: item.text,
                              query: item.query || item.text
                            },
                            bubbles: true,
                            composed: true
                          });
                          
                          // Find the listen-view element and dispatch the event
                          const listenView = document.querySelector('listen-view');
                          if (listenView) {
                            listenView.dispatchEvent(event);
                            console.log('[Glass Meeting View] 🔍 Dispatched meeting-action-clicked event');
                          } else {
                            console.error('[Glass Meeting View] Could not find listen-view element');
                          }
                        }}
                        title={`Click to search: ${item.text}`}
                      >
                        <span className="action-icon">🔍</span>
                        <span className="action-text" style={{ color: '#ffffff', marginLeft: '8px' }}>
                          {(item.text || item.query || 'Unknown').replace(/^["']|["']$/g, '')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* What should I say next - Questions/Suggestions */}
            {suggestions.length > 0 && (
              <div className="contextual-actions-container" style={{ 
                display: 'block', 
                marginTop: '8px', 
                visibility: 'visible' as any, 
                opacity: 1,
                background: 'rgba(0, 0, 0, 0.3)',
                backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
                border: '0.5px solid rgba(255, 255, 255, 0.3)',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(31, 38, 135, 0.15), 0 4px 16px rgba(255, 255, 255, 0.1) inset'
              }}>
                <h4 className="contextual-actions-title" style={{ color: '#ffffff' }}>
                  What should I say next ({suggestions.length} questions)
                </h4>
                <div className="contextual-actions-list">
                  {suggestions.map((suggestion, index) => {
                    const text = typeof suggestion === 'string' ? suggestion : (suggestion.text || '');
                    console.log('[Glass Meeting View] 🟢 RENDERING SUGGESTION:', index, text);
                    return (
                      <div
                        key={suggestion.id || `suggestion-${index}`}
                        className="contextual-action-item suggestion-item"
                        style={{ 
                          cursor: 'pointer', 
                          display: 'block',
                          visibility: 'visible' as any,
                          opacity: 1,
                          background: 'rgba(255, 255, 255, 0.05)',
                          padding: '8px 12px',
                          marginBottom: '4px',
                          borderRadius: '6px',
                          color: '#ffffff'
                        }}
                        onClick={() => {
                          navigator.clipboard.writeText(text);
                          console.log('[Glass Meeting] Suggestion clicked:', text);
                        }}
                        title="Click to copy"
                      >
                        <span className="action-text" style={{ color: '#ffffff' }}>💬 {(text || 'Unknown').replace(/^["']|["']$/g, '')}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Insights View */}
        {viewMode === 'insights' && (
          <div className="insights-container">
            {currentAnalysis ? (
              <>
                {/* Topic Header */}
                {currentAnalysis.topic && (
                  <div className="insights-section">
                    <h3 className="insights-title">{currentAnalysis.topic.header}</h3>
                    <p className="insights-description">{currentAnalysis.topic.description}</p>
                  </div>
                )}

                {/* Key Points */}
                {currentAnalysis.keyPoints && currentAnalysis.keyPoints.length > 0 && (
                  <div className="insights-section">
                    <h4>Key Points</h4>
                    {currentAnalysis.keyPoints.map((point, i) => (
                      <div key={i} className="outline-item">{point}</div>
                    ))}
                  </div>
                )}

                {/* Suggestions */}
                {currentAnalysis.actions && currentAnalysis.actions.length > 0 && (
                  <div className="insights-section">
                    <h4>Suggestions</h4>
                    {currentAnalysis.actions.map((action, i) => (
                      <div
                        key={i}
                        className="request-item"
                      >
                        {action}
                      </div>
                    ))}
                  </div>
                )}

                {/* Follow-up Questions */}
                {currentAnalysis.questions && currentAnalysis.questions.length > 0 && (
                  <div className="insights-section">
                    <h4>Questions to Consider</h4>
                    {currentAnalysis.questions.map((question, i) => (
                      <div
                        key={i}
                        className="request-item"
                      >
                        {question}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                {isListening ? 'Analyzing conversation...' : 'Start a meeting to see insights'}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Glass-identical styles */}
      <style>{`
        .assistant-container {
          display: flex;
          flex-direction: column;
          color: #ffffff;
          box-sizing: border-box;
          position: relative;
          background: rgba(45, 45, 50, 0.12); /* Light gray, slightly visible */
          backdrop-filter: blur(8px) saturate(250%) contrast(150%) brightness(115%);
          -webkit-backdrop-filter: blur(8px) saturate(250%) contrast(150%) brightness(115%);
          overflow: hidden;
          border-radius: 12px;
          width: 100%;
          height: 100%;
          min-height: 400px; /* Ensure minimum height */
          max-height: 600px;
          box-shadow: none !important;
          border: none;
          pointer-events: none; /* Allow clicking through */
        }

        .assistant-container::after {
          display: none; /* Remove gradient border effect that might cause shadow */
        }

        .assistant-container::before {
          display: none; /* Remove shadow completely */
        }

        .top-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 16px;
          min-height: 32px;
          position: relative;
          z-index: 1;
          width: 100%;
          box-sizing: border-box;
          flex-shrink: 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          pointer-events: auto; /* Keep header interactive */
          box-shadow: none !important;
        }

        .bar-left-text {
          color: white;
          font-size: 13px;
          font-family: 'Helvetica Neue', sans-serif;
          font-weight: 500;
          position: relative;
          overflow: hidden;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
          max-width: 200px;
        }

        .bar-left-text-content {
          display: inline-block;
          transition: transform 0.3s ease;
        }

        .bar-controls {
          display: flex;
          gap: 4px;
          align-items: center;
          flex-shrink: 0;
          width: 120px;
          justify-content: flex-end;
          box-sizing: border-box;
          padding: 4px;
        }

        .toggle-button {
          display: flex;
          align-items: center;
          gap: 5px;
          background: transparent;
          color: rgba(255, 255, 255, 0.9);
          border: none;
          outline: none;
          box-shadow: none;
          padding: 4px 8px;
          border-radius: 5px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          height: 24px;
          white-space: nowrap;
          transition: background-color 0.15s ease;
          justify-content: center;
        }

        .toggle-button:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .toggle-button svg {
          flex-shrink: 0;
          width: 12px;
          height: 12px;
        }

        .copy-button {
          background: transparent;
          color: rgba(255, 255, 255, 0.9);
          border: none;
          outline: none;
          box-shadow: none;
          padding: 4px;
          border-radius: 3px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 24px;
          height: 24px;
          flex-shrink: 0;
          transition: background-color 0.15s ease;
          position: relative;
          overflow: hidden;
        }

        .copy-button:hover {
          background: rgba(255, 255, 255, 0.15);
        }

        .copy-button svg {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
        }

        .copy-button .check-icon {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .copy-icon {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .check-icon {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }

        .content-area {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          pointer-events: auto; /* Keep content area interactive for scrolling and actions */
          box-shadow: none !important;
          border: none;
        }

        .transcription-container,
        .insights-container {
          overflow-y: auto;
          padding: 12px 12px 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 150px;
          max-height: 600px;
          position: relative;
          z-index: 1;
          flex: 1;
          box-shadow: none !important;
          border: none;
        }

        .transcription-container::-webkit-scrollbar,
        .insights-container::-webkit-scrollbar {
          width: 8px;
        }

        .transcription-container::-webkit-scrollbar-track,
        .insights-container::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.1);
          border-radius: 4px;
        }

        .transcription-container::-webkit-scrollbar-thumb,
        .insights-container::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.3);
          border-radius: 4px;
        }

        .transcription-container::-webkit-scrollbar-thumb:hover,
        .insights-container::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.5);
        }

        .messages-container {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
        }

        .stt-message {
          padding: 2px 0;
          word-wrap: break-word;
          word-break: break-word;
          line-height: 1.5;
          font-size: 13px;
          box-sizing: border-box;
          display: flex;
          align-items: flex-start;
          gap: 6px;
          background: transparent;
          border: none;
          transition: none;
          max-width: 80%;
        }

        .stt-message.them {
          align-self: flex-start;
          text-align: left;
        }

        .stt-message.me {
          align-self: flex-end;
          text-align: right;
        }

        .stt-message::before { content: none; }

        .stt-message.them::before { content: none; }

        .stt-message.me::before { content: none; }

        .stt-message .transcript-text {
          color: rgba(255, 255, 255, 0.9);
          font-weight: 400;
          white-space: pre-wrap;
        }

        .stt-message.partial {
          opacity: 0.85;
          background: transparent;
        }

        .stt-message.partial .transcript-text {
          font-style: normal;
        }

        .empty-state {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100px;
          color: rgba(255, 255, 255, 0.6);
          font-size: 12px;
          font-style: italic;
        }

        .insights-title {
          color: rgba(255, 255, 255, 0.8);
          font-size: 15px;
          font-weight: 500;
          font-family: 'Helvetica Neue', sans-serif;
          margin: 12px 0 8px 0;
          display: block;
        }

        .insights-container h4 {
          color: #ffffff;
          font-size: 12px;
          font-weight: 600;
          margin: 12px 0 8px 0;
          padding: 4px 8px;
          border-radius: 4px;
          background: transparent;
          cursor: default;
        }

        .insights-container h4:hover {
          background: transparent;
        }

        .insights-container h4:first-child {
          margin-top: 0;
        }

        .outline-item {
          color: #ffffff;
          font-size: 11px;
          line-height: 1.4;
          margin: 4px 0;
          padding: 6px 8px;
          border-radius: 4px;
          background: transparent;
          transition: background-color 0.15s ease;
          cursor: pointer;
          word-wrap: break-word;
        }

        .outline-item:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .request-item {
          color: rgba(255, 255, 255, 0.85);
          font-size: 11px;
          line-height: 1.4;
          margin: 4px 0;
          padding: 6px 8px;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.03);
          transition: background-color 0.15s ease;
          word-wrap: break-word;
          cursor: default;
        }

        .request-item.clickable {
          cursor: pointer;
        }

        .request-item.clickable:hover {
          background: rgba(255, 255, 255, 0.1);
        }

        .insights-section {
          margin-bottom: 16px;
        }

        .insights-section:last-child {
          margin-bottom: 0;
        }

        .insights-description {
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
          margin: 0 0 12px 0;
        }

        .contextual-actions-container {
          margin-top: 16px;
          padding: 12px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.02);
          border-radius: 8px;
          pointer-events: auto; /* Keep actions clickable */
          box-shadow: none !important;
          border-bottom: none;
        }

        .contextual-actions-title {
          color: rgba(255, 255, 255, 0.9);
          font-size: 12px;
          font-weight: 600;
          margin: 0 0 8px 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .contextual-actions-title::before {
          font-size: 10px;
        }

        h4.contextual-actions-title:first-child::before {
          content: '🔍'; /* Search icon for Actions */
        }

        h4.contextual-actions-title:last-child::before {
          content: '💬'; /* Chat icon for Suggestions */
        }

        .contextual-actions-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .contextual-action-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          color: white;
          font-size: 11px;
          font-weight: 400;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
          width: 100%;
          box-sizing: border-box;
        }

        .contextual-action-item:hover:not(.non-clickable) {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
          transform: translateY(-1px);
        }

        .contextual-action-item.non-clickable {
          cursor: default;
          opacity: 0.8;
        }

        .contextual-action-item.non-clickable:hover {
          transform: none;
        }

        .action-type {
          background: rgba(0, 122, 255, 0.8);
          color: white;
          padding: 2px 6px;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          flex-shrink: 0;
        }

        .action-text {
          flex: 1;
          font-weight: 500;
        }

        .suggestion-item .action-type {
          background: rgba(52, 199, 89, 0.8);
        }
      `}</style>
    </div>
  );
}; 