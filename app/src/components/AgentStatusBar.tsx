import { useState, useEffect } from 'react';

interface AgentStatusBarProps {
  isVisible: boolean;
  // isThinking intentionally unused in UI now to reduce noise
  isThinking: boolean;
  userMessage: string; // Keep for compatibility but won't display
}

const AgentStatusBar = ({ isVisible, isThinking: _isThinking, userMessage }: AgentStatusBarProps) => {
  const [currentAction, setCurrentAction] = useState<string>('');
  
  // Generate personalized completion message using Gemini via backend
  const generateCompletionMessage = async (originalTask: string): Promise<string> => {
    try {
      // Send request to backend to generate completion message
      return new Promise((resolve) => {
        const handleCompletionResponse = (_event: any, response: any) => {
          if (response.type === 'completion_message') {
            window.ipcRenderer.off('completion-message-response', handleCompletionResponse);
            resolve(response.message || 'Done! ✨');
          }
        };

        window.ipcRenderer.on('completion-message-response', handleCompletionResponse);
        window.ipcRenderer.send('generate-completion-message', originalTask);

        // Fallback timeout
        setTimeout(() => {
          window.ipcRenderer.off('completion-message-response', handleCompletionResponse);
          resolve('Done! ✨');
        }, 3000);
      });
    } catch (error) {
      console.error('Failed to generate completion message:', error);
      return 'Done! ✨';
    }
  };

  // Listen for agent responses to show actions
  useEffect(() => {
    const handleGeminiMacosResponse = (_event: any, response: any) => {
      if (!isVisible) return;
      
      console.log('[AgentStatusBar] Received response:', response);
      console.log('[AgentStatusBar] Response type:', response.type);
      console.log('[AgentStatusBar] Response content:', response.content);
      
      // Handle longer agent responses (summaries, detailed responses)
      if (response.type === 'agent_response' && response.content) {
        // This is a longer response from the agent - display full content
        setCurrentAction(response.content);
        return;
      }
      
      if (response.type === 'agent_action' && response.content) {
        // This is the main action update from TerminatorAgent
        const raw = String(response.content);
        const content = raw.toLowerCase();
        console.log('[AgentStatusBar] Agent action:', raw);
        
        // Parse conversational responses and convert to direct action format
        if (content.includes('navigat')) {
          // Extract URL/destination from "Navigate to X website" or "Opening Google Chrome to navigate to x.com"
          const navMatch = raw.match(/navigat(?:e|ing)?\s+to\s+([^\s\.\n!?,]+(?:\.[^\s\.\n!?,]+)*)/i) || 
                           raw.match(/to\s+([^\s\.\n!?,]+\.[^\s\.\n!?,]+)/i); // URLs like x.com
          if (navMatch) {
            setCurrentAction(`navigating to ${navMatch[1]}`);
          } else {
            // Look for app names in navigation context
            const appMatch = raw.match(/(?:opening|navigate.*to)\s+([A-Za-z\s]+?)(?:\s+to|\s+via|\s*$)/i);
            if (appMatch) {
              setCurrentAction(`navigating to ${appMatch[1].trim()}`);
            } else {
              setCurrentAction('navigating');
            }
          }
        } else if (content.includes('click') || content.includes('submit')) {
          // Extract element name from various click formats
          const clickMatch = raw.match(/(?:click|submit)(?:ing)?\s+(?:the\s+)?(?:search\s+)?(?:query\s+)?(?:for\s+)?[\"\']?([^\"\'\.!?\n]+)[\"\']?/i);
          if (clickMatch) {
            let elementName = clickMatch[1].trim();
            // Clean up common phrases
            elementName = elementName.replace(/\s+(button|link|element|field|menu|option|query)$/i, '');
            setCurrentAction(`clicking ${elementName}`);
          } else {
            setCurrentAction('clicking element');
          }
        } else if (content.includes('typ')) {
          // Extract ONLY the quoted text from "Type 'mrbeast' in the search field"
          const typeMatch = raw.match(/typ(?:e|ing)\s+[\"\']([^\"\']+)[\"\']/) || 
                           raw.match(/[\"\']([^\"\']+)[\"\'].*typ/i); // Handle different word orders
          if (typeMatch) {
            const typedText = typeMatch[1].trim();
            setCurrentAction(`typing "${typedText}"`);
          } else {
            setCurrentAction('typing text');
          }
        } else if (content.includes('scroll')) {
          setCurrentAction('scrolling page');
        } else if (content.includes('open')) {
          // Handle opening apps/websites
          const openMatch = raw.match(/open(?:ing)?\s+([^\s\.\n!?]+)/i);
          if (openMatch) {
            setCurrentAction(`opening ${openMatch[1]}`);
          } else {
            setCurrentAction('opening page');
          }
        } else if (content.includes('search')) {
          setCurrentAction('searching');
        } else {
          // Clean up conversational prefixes and show direct action
          const cleanAction = raw
            .replace(/^(now i'll|next i'll|i'm going to|let me|time to|i'll now|going to|about to|i need to|let me try to|working on|i'll|next step:|now:|proceeding to)\s*/i, '')
            .replace(/^(try to|attempt to|start|begin)\s*/i, '');
          setCurrentAction(cleanAction);
        }
      } else if (response.type === 'step' && response.content) {
        // Step updates from TerminatorAgent - these contain action results
        const content = response.content;
        console.log('[AgentStatusBar] Step update:', content);
        
        // Extract action details from step content like "1. click the button - clicked web element button"
        if (content.includes('click')) {
          // Look for element name in either part of "1. click the button - clicked web element button"
          const elementMatch = content.match(/click(?:ed|ing)?\s+(?:web\s+element\s+)?(?:the\s+)?[\"\']?([^\"\'\.!\?\n\-]+)[\"\']?/i);
          if (elementMatch) {
            setCurrentAction(`clicking ${elementMatch[1].trim()}`);
          } else {
            setCurrentAction('clicking element');
          }
        } else if (content.includes('typ')) {
          // Look for ONLY quoted text in step results
          const typeMatch = content.match(/typ(?:ed|ing)\s+[\"\']([^\"\']+)[\"\']/) ||
                           content.match(/[\"\']([^\"\']+)[\"\'].*typ/i);
          if (typeMatch) {
            const typedText = typeMatch[1].trim();
            setCurrentAction(`typing "${typedText}"`);
          } else {
            setCurrentAction('typing text');
          }
        } else if (content.includes('scroll')) {
          setCurrentAction('scrolling page');
        } else if (content.includes('navigat') || content.includes('open')) {
          setCurrentAction('opening page');
        } else {
          // Generic step update - fall back to thinking state
          setCurrentAction('');
        }
      } else if (response.type === 'plan' && response.content) {
        // Fallback for plan responses - show thinking
        setCurrentAction('');
      } else if (response.type === 'step_start') {
        // Action starting - show thinking
        setCurrentAction('');
      } else if (response.type === 'action_update') {
        // Use specific content if available, otherwise thinking
        setCurrentAction(response.content || '');
      } else if (response.type === 'thinking') {
        // Reset to thinking state for new requests
        setCurrentAction('');
      } else if (response.type === 'conversation') {
        // Handle conversational responses
        setCurrentAction(response.content || 'Hello!');
        setTimeout(() => {
          // Auto-close conversational responses after 3 seconds
          window.dispatchEvent(new CustomEvent('agent-status-close'));
        }, 3000);
      } else if (response.type === 'complete' || response.type === 'completion') {
        // Generate personalized completion message
        generateCompletionMessage(userMessage).then((personalizedMessage) => {
          setCurrentAction(personalizedMessage);
          setTimeout(() => {
            // Auto-close after showing personalized message for 5 seconds for longer messages
            /* keep for future UX timing adjustments */
            // const isLongerMessage = personalizedMessage.length > 100;
            window.dispatchEvent(new CustomEvent('agent-status-close'));
          }, 5000); // Extended time for longer messages
        });
      } else if (response.content) {
        // Parse any other content for specific action details
        const content = response.content;
        
        // Look for action logs or status updates with specific details
        const clickLogMatch = content.match(/clicked?\s+(?:web\s+element\s+)?[\"\']?([^\"\']+)[\"\']?/i);
        if (clickLogMatch) {
          setCurrentAction(`clicking ${clickLogMatch[1].trim()}`);
          return;
        }
        
        const typeLogMatch = content.match(/typ(?:ed?|ing)\s+[\"\']([^\"\']+)[\"\']|typ(?:ed?|ing)\s+([^\.\n!?]+)/i);
        if (typeLogMatch) {
          const typedText = typeLogMatch[1] || typeLogMatch[2];
          setCurrentAction(`typing "${typedText.trim()}"`);
          return;
        }
        
        const scrollLogMatch = content.match(/scroll(?:ed?|ing)\s+([^\.\n!?]+)/i);
        if (scrollLogMatch) {
          setCurrentAction(`scrolling ${scrollLogMatch[1].trim()}`);
          return;
        }
        
        // Generic action detection
        if (content.toLowerCase().includes('clicking')) {
          setCurrentAction('clicking element');
        } else if (content.toLowerCase().includes('typing')) {
          setCurrentAction('typing text');
        } else if (content.toLowerCase().includes('scrolling')) {
          setCurrentAction('scrolling page');
        } else if (content.toLowerCase().includes('navigat')) {
          setCurrentAction('navigating');
                 } else if (content.toLowerCase().includes('searching')) {
           setCurrentAction('searching');
         }
       } else if (response.content && typeof response.content === 'string') {
                 // Generic fallback - look for action keywords in any response content
        const content = response.content.toLowerCase();
        if (content.includes('click')) {
          const elementMatch = content.match(/click(?:ing|ed)?\s+(?:web\s+element\s+)?(?:the\s+)?[\"\']?([^\"\'\.!?\n\-]+)[\"\']?/i);
          if (elementMatch) {
            const elementName = elementMatch[1].trim();
            setCurrentAction(`clicking ${elementName}`);
          } else {
            setCurrentAction('clicking element');
          }
        } else if (content.includes('typ')) {
          const typeMatch = content.match(/typ(?:e|ed|ing)\s+[\"\']([^\"\']+)[\"\']/) ||
                           content.match(/[\"\']([^\"\']+)[\"\'].*typ/i);
          if (typeMatch) {
            const typedText = typeMatch[1].trim();
            setCurrentAction(`typing "${typedText}"`);
          } else {
            setCurrentAction('typing text');
          }
        } else if (content.includes('scroll')) {
          setCurrentAction('scrolling page');
        } else if (content.includes('navigat') || content.includes('open')) {
          setCurrentAction('opening page');
         } else {
           // Log unhandled response types for debugging
           console.log('[AgentStatusBar] Unhandled response type:', response.type, 'Content:', response.content);
         }
       } else {
         // Log unhandled response types for debugging
         console.log('[AgentStatusBar] Unhandled response type:', response.type, 'Content:', response.content);
       }
    };

    window.ipcRenderer.on('gemini-macos-response', handleGeminiMacosResponse);

    return () => {
      window.ipcRenderer.off('gemini-macos-response', handleGeminiMacosResponse);
    };
  }, [isVisible]);

  // Don't reset action when thinking starts - keep showing the last action
  // useEffect(() => {
  //   if (isThinking) {
  //     setCurrentAction('');
  //   }
  // }, [isThinking]);

  if (!isVisible) return null;

  return (
    <div 
      className="pointer-events-auto input-bar-enter fixed top-11 left-1/2 transform -translate-x-1/2 z-40"
      style={{ 
        width: '450px', 
        minWidth: '400px', 
        maxWidth: '500px'
      }}
      onMouseEnter={() => {
        window.ipcRenderer.send('mouse:enter-interactive');
      }}
      onMouseLeave={() => {
        window.ipcRenderer.send('mouse:leave-interactive');
      }}
    >
      <div className="glass-chat-input-area">
        <div 
          className="flex items-start px-4 py-3"
          style={{ 
            minHeight: '40px',
            maxHeight: 'none', // Allow unlimited height expansion
            height: 'auto', // Auto height based on content
            background: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg)',
            border: 'none',
            borderRadius: '12px',
            color: 'white',
            fontSize: '14px'
          }}
        >
          {/* Status text - now supports multi-line */}
          <div className="flex-1 text-white text-sm pr-3" style={{ 
            lineHeight: '1.4',
            whiteSpace: 'pre-wrap', // Preserve line breaks and allow wrapping
            wordWrap: 'break-word' // Break long words if needed
          }}>
            {currentAction ? (
              <span>{currentAction}</span>
            ) : (
              <span className="thinking-text">thinking....</span>
            )}
          </div>
          
          {/* Button container - always at top right */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Stop button */}
            <button
              onClick={() => {
                // Stop the agent immediately
                console.log('[AgentStatusBar] Stop button clicked - terminating agent');
                window.ipcRenderer.send('terminate-agent');
                window.dispatchEvent(new CustomEvent('agent-status-close'));
              }}
              onMouseEnter={() => {
                window.ipcRenderer.send('mouse:enter-interactive');
              }}
              onMouseLeave={() => {
                window.ipcRenderer.send('mouse:leave-interactive');
              }}
              className="w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-110"
              style={{
                background: 'rgba(255, 255, 255, 0.15)',
                backdropFilter: 'blur(10px)'
              }}
              title="Stop agent"
            >
              <div 
                className="w-2.5 h-2.5 rounded-sm"
                style={{
                  background: 'rgba(255, 255, 255, 0.7)'
                }}
              />
            </button>
            
            {/* Close button */}
            <button
              onClick={() => {
                // Reset to input mode by clearing status
                window.dispatchEvent(new CustomEvent('agent-status-close'));
              }}
              onMouseEnter={() => {
                window.ipcRenderer.send('mouse:enter-interactive');
              }}
              onMouseLeave={() => {
                window.ipcRenderer.send('mouse:leave-interactive');
              }}
              className="text-white/40 hover:text-white/70 transition-colors p-1"
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentStatusBar; 