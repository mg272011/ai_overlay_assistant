// @ts-ignore
import { app, BrowserWindow, ipcMain, Notification, screen, dialog, shell, Menu, desktopCapturer, nativeImage } from "electron";
// import OpenAI from 'openai'; // Unused
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppName, getBundleId } from "./utils/getAppInfo";
import { getClickableElements } from "./utils/getClickableElements";
import { takeAndSaveScreenshots } from "./utils/screenshots";
import { execPromise, logWithElapsed } from "./utils/utils";
// import { performAction } from "./performAction"; // Unused
// Removed unused imports: runAppleScript, key
import { Element } from "./types";
import { LiveAudioService } from "./services/LiveAudioService";
import { geminiVision } from "./services/GeminiVisionService";
import { initScreenHighlightService } from "./services/ScreenHighlightService";
import { ContextualActionsService } from "./services/ContextualActionsService";
import { browserDetection } from "./services/BrowserDetectionService";
// import { ListenService } from "./services/glass/ListenService"; // Replaced by JavaScript version
// Services are declared locally where needed

// Mock function to replace agent functionality
async function* mockAgentStreaming() {
  yield { type: "text", content: "Agent mode has been disabled. This functionality is no longer available." };
}

// OpenAI client for fallback
// OpenAI client disabled - not used in current agent system
// let openaiClient: OpenAI | null = null; // Unused
try {
  // openaiClient = new OpenAI();
} catch (error) {
  console.log('[MainHandlers] OpenAI client not available for fallback');
}

function createLogFolder(userPrompt: string) {
  logWithElapsed(
    "createLogFolder",
    `Creating log folder for prompt: ${userPrompt}`
  );
  const mainTimestamp = Date.now().toString();
  const promptFolderName = userPrompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const mainLogFolder = path.join(
    process.cwd(),
    "logs",
    `${mainTimestamp}-${promptFolderName}`
  );
  if (!fs.existsSync(mainLogFolder)) {
    fs.mkdirSync(mainLogFolder, { recursive: true });
    logWithElapsed("createLogFolder", `Created folder: ${mainLogFolder}`);
  }
  return mainLogFolder;
}

// Register global IPC handlers that should only be registered once
// Audio loopback handlers (for system audio capture)
// Simple handlers to prevent errors - actual audio capture happens via LiveAudioService
ipcMain.handle("enable-loopback-audio", async () => {
  console.log('[MainHandlers] enable-loopback-audio called - using LiveAudioService for audio capture');
  // LiveAudioService handles audio capture, this is just a placeholder
  return Promise.resolve();
});

ipcMain.handle("disable-loopback-audio", async () => {
  console.log('[MainHandlers] disable-loopback-audio called');
  return Promise.resolve();
});
// when initMain() is called in main.ts, so we don't need to register them here

let mainWindow: InstanceType<typeof BrowserWindow> | null = null;

// In-memory chat history per renderer (sender id)
type ChatRole = 'user' | 'assistant';
interface ChatMessage { role: ChatRole; content: string }
const chatHistories = new Map<number, ChatMessage[]>();

// type PlanStep = { // Unused
//   id: number;
//   title: string;
//   action: 'open_app' | 'navigate_url' | 'agent';
//   params?: Record<string, any>;
//   check?: { type: 'app_frontmost' | 'url_contains'; value: string };
// };

function getRecentHistoryString(senderId: number, limit: number = 4): string {
  const history = chatHistories.get(senderId) || [];
  const recent = history.slice(-limit);
  return recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
}

function appendToHistory(senderId: number, role: ChatRole, content: string): void {
  const history = chatHistories.get(senderId) || [];
  history.push({ role, content });
  // Keep a reasonable cap to avoid unbounded growth
  const maxMessages = 20;
  if (history.length > maxMessages) {
    history.splice(0, history.length - maxMessages);
  }
  chatHistories.set(senderId, history);
  console.log(`[MainHandlers] 💾 Added to backend history (${role}): ${content.substring(0, 50)}... | Total: ${history.length} messages`);
}

// Function to dynamically resize window based on content (only grow, never shrink)
function resizeWindowForContent(contentLength: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  
  // Get current size
  const [currentWidth, currentHeight] = mainWindow.getSize();
  const [maxWidth, maxHeight] = [1400, 1000]; // Maximum size
  
  // Calculate new dimensions based on content length
  const baseWidth = 800;
  const baseHeight = 600;
  
  // Add extra height for longer responses (roughly 20px per 100 characters)
  const extraHeight = Math.min(300, Math.floor(contentLength / 100) * 20);
  const targetHeight = Math.min(maxHeight, baseHeight + extraHeight);
  
  // Add some width if content is very long
  const extraWidth = Math.min(200, Math.floor(contentLength / 500) * 50);
  const targetWidth = Math.min(maxWidth, baseWidth + extraWidth);
  
  // Only grow, never shrink - use current size as minimum
  const newWidth = Math.max(currentWidth, targetWidth);
  const newHeight = Math.max(currentHeight, targetHeight);
  
  // Only resize if there's a significant change (avoid constant micro-adjustments)
  if (newWidth > currentWidth + 50 || newHeight > currentHeight + 50) {
    mainWindow.setSize(newWidth, newHeight, true); // true = animate
    mainWindow.center(); // Keep window centered after resize
  }
}

export function setupMainHandlers({ win }: { win: InstanceType<typeof BrowserWindow> | null }) {
  mainWindow = win; // Store reference for IPC handlers
  
  // Lazy initialization - only create when needed to avoid startup freezes
  let liveAudioService: LiveAudioService | null = null;
  // let glassListenService: ListenService | null = null; // Replaced by JavaScript version
  let glassJSListenService: any = null; // Glass JavaScript implementation for meeting/live
  let isGlassServiceInitializing = false; // Prevent concurrent initialization
  let contextualActionsSvc: ContextualActionsService | null = null;
  
  // Helper function to get or create live audio service  
  const getLiveAudioService = () => {
    if (!liveAudioService) {
      liveAudioService = new LiveAudioService();
    }
    return liveAudioService;
  };
  
  // Helper function to get or create Glass listen service
  // For meeting/live feedback mode, use the Glass JavaScript implementation
  const getGlassListenService = async () => {
    if (!glassJSListenService && !isGlassServiceInitializing) {
      isGlassServiceInitializing = true;
      try {
        // Use the JavaScript implementation from Glass (identical to Glass's meeting mode)
        // @ts-ignore - importing JS module without type definitions
        const module = await import('./services/glass-meeting/listenService.js');
        const GlassListenServiceClass = module.default;
        glassJSListenService = new GlassListenServiceClass();
        
        // Set up renderer communication for all services
        const sendToRenderer = (channel: string, data: any) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send(channel, data);
          }
        };
        
        glassJSListenService.sendToRenderer = sendToRenderer;
        glassJSListenService.sttService.sendToRenderer = sendToRenderer;
        glassJSListenService.summaryService.sendToRenderer = sendToRenderer;
      } catch (error) {
        console.error('[MainHandlers] Failed to create Glass service:', error);
        glassJSListenService = null;
        throw error;
      } finally {
        isGlassServiceInitializing = false;
      }
    }
    return glassJSListenService;
  };
  
  // Track CSS injected for meeting click-through mode so we can remove it
  let meetingCssKey: string | null = null;
  
  // Initialize screen highlight service
  if (win) {
    initScreenHighlightService(win);
  }

  // Bridge: adjust window height for listen view
  ipcMain.handle('listen-view-adjust-window-height', async (_evt, targetHeight: number) => {
    try {
      if (win && !win.isDestroyed()) {
        const [w] = win.getSize();
        const clamped = Math.max(300, Math.min(800, Math.floor(targetHeight)));
        win.setSize(w, clamped);
      }
    } catch (err) {
      console.error('Failed to adjust window height:', err);
    }
  });

  // Bridge: summary view question -> forward to renderer
  ipcMain.on('summary-view-send-question', (_evt, text: string) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('summary-view-send-question', text);
    }
  });
  
  // Virtual cursor handlers - DISABLED to prevent conflicts with toggle-collab-mode
  // The virtual cursor is now managed entirely through toggle-collab-mode
  ipcMain.on("show-virtual-cursor", async () => {
    console.log('[MainHandlers] show-virtual-cursor called - ignoring to prevent conflicts');
    // Legacy handler - now handled by toggle-collab-mode
  });
  
  ipcMain.on("hide-virtual-cursor", () => {
    console.log('[MainHandlers] hide-virtual-cursor called - ignoring to prevent conflicts');
    // Legacy handler - now handled by toggle-collab-mode
  });
  
  ipcMain.on("start-conversation-mode", async (_) => {
    console.log('[MainHandlers] Received start-conversation-mode - using Glass JavaScript meeting system');
    
    try {
      // Keep meeting UI above other windows and remove traffic lights
      if (win && !win.isDestroyed()) {
        try {
          // Ensure overlay shows on all spaces including fullscreen
          try { (win as any).setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
          try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
          try { win.setFullScreenable(false); } catch {}
          try { (win as any).moveTop(); } catch {}
        } catch {}
      }

      // Initialize Glass services if not yet
      const listenSvc = await getGlassListenService();
      if (listenSvc && !listenSvc.isSessionActive()) {
        await listenSvc.initializeSession('en');
      }

      // Start local live audio capture if available
      const service = getLiveAudioService();
      await service.start({
        onGeminiChunk: (chunk) => { try { win?.webContents.send('gemini-transcript', chunk); } catch {} },
        onTranscript: (res) => { try { win?.webContents.send('live-transcript', res); } catch {} },
        onUtteranceEnd: () => { try { win?.webContents.send('utterance-end'); } catch {} },
      });

      // Focus renderer for quick actions
      if (win && !win.isDestroyed()) {
        win.webContents.send('live-audio-ready');
      }
    } catch (error) {
      console.error('[MainHandlers] Failed to start conversation mode:', error);
    if (win && !win.isDestroyed()) {
      const msg = (error && (error as any).message) ? (error as any).message : String(error);
      win.webContents.send('live-audio-error', msg);
    }
    }
  });
  
  ipcMain.on("stop-conversation-mode", async () => {
    console.log('[MainHandlers] Received stop-conversation-mode');
    console.log('[MainHandlers] Stopping Glass JavaScript ListenService...');
    
    try {
      if (glassJSListenService) {
        await glassJSListenService.closeSession();
        // Clear the service to allow fresh initialization next time
        glassJSListenService = null;
      }
      
      console.log('[MainHandlers] ✅ Glass JavaScript ListenService stopped');
      if (win && !win.isDestroyed()) {
        // Keep window always on top even when stopping conversation
                  try {
            win.setAlwaysOnTop(true, 'screen-saver'); // Keep on top
            // Keep visible on all workspaces including fullscreen
            try { (win as any).setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
            // Keep traffic lights hidden when exiting live mode
            win.setWindowButtonVisibility?.(false);
            if (meetingCssKey) {
              win.webContents.removeInsertedCSS(meetingCssKey);
              meetingCssKey = null;
            }
          } catch {}
        win.webContents.send("live-audio-stopped");
      }
    } catch (error) {
      console.error('[MainHandlers] Error stopping Glass service:', error);
      // Still clear the service even if cleanup failed
      glassJSListenService = null;
    }
  });
  
  // Live audio streaming handler - receives chunks from renderer
  ipcMain.on("live-audio-chunk", async (_, chunk: Uint8Array) => {
    // Removed cluttering audio log
    
    try {
      // Convert to base64 and send to Glass JavaScript STT
      if (glassJSListenService && glassJSListenService.isSessionActive()) {
        const buffer = Buffer.from(chunk);
        
        // The audio is interleaved stereo PCM16 at 16kHz
        // Channel 0 (left) = Microphone (user speaking)
        // Channel 1 (right) = System audio (other person speaking)
        // 
        // NOTE: In meeting mode, both channels contain microphone audio since we don't capture system audio
        // We should only send to the microphone STT to avoid duplicate transcriptions
        
        // Extract left channel (mic) and right channel (system)
        const leftChannel = Buffer.alloc(buffer.length / 2);
        const rightChannel = Buffer.alloc(buffer.length / 2);
        
        let leftIndex = 0;
        let rightIndex = 0;
        
        for (let i = 0; i < buffer.length; i += 4) { // 4 bytes = 1 stereo sample (2 bytes left, 2 bytes right)
          // Left channel (mic)
          leftChannel[leftIndex++] = buffer[i];
          leftChannel[leftIndex++] = buffer[i + 1];
          
          // Right channel (system)
          rightChannel[rightIndex++] = buffer[i + 2];
          rightChannel[rightIndex++] = buffer[i + 3];
        }
        
        // Always send left channel to mic STT (You/Me)
        const micBase64 = leftChannel.toString('base64');
        await glassJSListenService.sendMicAudioContent(micBase64);
        
        // Only send right channel to system STT (Them) if we're NOT in meeting mode
        // In meeting mode, both channels contain microphone audio, so sending to system STT
        // would create duplicate transcriptions labeled as "Them"
        const isMeetingMode = true; // We know we're in meeting mode if this handler is called
        
        if (!isMeetingMode) {
          const systemBase64 = rightChannel.toString('base64');
          await glassJSListenService.sendSystemAudioContent(systemBase64);
          console.log('[MainHandlers] 🎤 Sent left channel to Mic STT, right channel to System STT');
        } else {
          // Sent left channel to Mic STT
        }
      }
    } catch (error) {
      console.error('[MainHandlers] Error processing live audio chunk:', error);
    }
  });

  // Generate contextual actions on demand from renderer (e.g., per final turn)
  ipcMain.on('generate-contextual-actions', async (_evt, payload: { text: string; speaker: string }) => {
    try {
      console.log('[MainHandlers] 🚀 Received generate-contextual-actions');
      console.log('[MainHandlers] Generating contextual actions for:', payload.speaker, '-', payload.text?.substring(0, 80));
      
      // Agent functionality removed - use lightweight service instance
      if (!contextualActionsSvc) {
        console.log('[MainHandlers] Creating new ContextualActionsService instance');
        contextualActionsSvc = new ContextualActionsService();
      }
      
      contextualActionsSvc.addConversationTurn(payload.speaker, payload.text);
      const results = await contextualActionsSvc.generateContextualActions(payload.text, payload.speaker);
      
      console.log('[MainHandlers] 🚀 Generated results:', {
        searchItems: results.searchItems?.length || 0,
        suggestions: results.suggestions?.length || 0,
        searchTexts: results.searchItems?.map(item => item.text),
        suggestionTexts: results.suggestions?.map(item => item.text)
      });
      
      if (results.searchItems?.length) {
        console.log('[MainHandlers] Sending contextual-search event with', results.searchItems.length, 'items');
        win?.webContents.send('contextual-search', results.searchItems);
      }
      
      if (results.suggestions?.length) {
        console.log('[MainHandlers] Sending contextual-suggestions event with', results.suggestions.length, 'items');
        win?.webContents.send('contextual-suggestions', results.suggestions);
      } else {
        console.log('[MainHandlers] No suggestions to send');
      }
    } catch (err) {
      console.error('[MainHandlers] ❌ generate-contextual-actions failed:', err);
    }
  });



  // Start a per-action meeting chat (separate from the main chat)
  ipcMain.on('start-meeting-chat', async (event, payload: { chatId: string; action: any }) => {
    console.log('[MeetingChat] ===== START-MEETING-CHAT HANDLER CALLED =====');
    console.log('[MeetingChat] Received payload:', JSON.stringify(payload, null, 2));
    try {
      const { chatId, action } = payload || {} as any;
      console.log('[MeetingChat] Extracted chatId:', chatId, 'action:', action);
      if (!chatId) {
        console.error('[MeetingChat] No chatId provided, returning early');
        return;
      }

      // Ensure contextual actions service is initialized
    contextualActionsSvc = contextualActionsSvc || new ContextualActionsService();

      // Get recent conversation from Glass meeting service if available
      let recent = '';
      if (glassJSListenService) {
        try {
          // Get recent conversation turns from the Glass meeting service
          const recentTurns = await glassJSListenService.getRecentTranscripts(6);
          if (recentTurns && recentTurns.length > 0) {
            recent = recentTurns.map((t: any) => `${t.speaker}: ${t.text}`).join('\n');
            console.log('[MainHandlers] Got recent meeting context:', recent.substring(0, 200) + '...');
          }
        } catch (err) {
          console.log('[MainHandlers] Could not get recent transcripts from Glass meeting:', err);
        }
      }
      
      // Fallback to chat history if no meeting context
      if (!recent) {
        recent = getRecentHistoryString(event.sender.id, 6);
      }
      
      const seed = action?.type === 'say-next'
        ? `Meeting Conversation (last 6 turns):\n${recent}\n\nBased on this conversation, provide ONE specific, actionable thing I should say next.`
        : (action?.query || action?.text || '');

      // Stream fake chunks for UX while fetching
      const send = (type: string, content?: string) => {
        console.log(`[MeetingChat] 📤 ===== SEND FUNCTION CALLED =====`);
        console.log(`[MeetingChat] 📤 Type: ${type}`);
        console.log(`[MeetingChat] 📤 Content length: ${content?.length || 0}`);
        console.log(`[MeetingChat] 📤 Raw content: ${JSON.stringify(content)}`);
        console.log(`[MeetingChat] 📤 Chat ID: ${chatId}`);
        console.log(`[MeetingChat] 📤 MainWindow exists: ${!!mainWindow}`);
        console.log(`[MeetingChat] 📤 MainWindow webContents exists: ${!!mainWindow?.webContents}`);
        
        const payload = { chatId, type, content };
        console.log(`[MeetingChat] 📤 Payload being sent: ${JSON.stringify(payload)}`);
        
        try {
          mainWindow?.webContents.send('meeting-chat-stream', payload);
          console.log(`[MeetingChat] 📤 ✅ Successfully sent meeting-chat-stream event to renderer`);
        } catch (sendError) {
          console.error(`[MeetingChat] 📤 ❌ Error sending to renderer:`, sendError);
        }
        console.log(`[MeetingChat] 📤 ===== SEND FUNCTION COMPLETED =====`);
      };

      if (action?.type === 'say-next') {
        // Better prompt for more specific suggestions using Gemini 2.5 Flash
        try {
          console.log('[MeetingChat] Processing say-next action...');
          const geminiKey = process.env.GEMINI_API_KEY;
          console.log('[MeetingChat] GEMINI_API_KEY present:', !!geminiKey);
          
          if (geminiKey) {
            console.log('[MeetingChat] Using Gemini 2.5 Flash for say-next...');
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ 
              model: "gemini-2.5-flash",
              generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 120, // 3-4 sentences
              }
            });
            
            // Include document context if available
            let documentContext = '';
            if ((global as any).meetingDocuments && (global as any).meetingDocuments.length > 0) {
              documentContext = '\n\nMEETING CONTEXT DOCUMENTS:\n';
              (global as any).meetingDocuments.forEach((doc: any) => {
                if (doc.content && typeof doc.content === 'string') {
                  // For text documents, include content
                  if (doc.type.includes('text') || doc.name.endsWith('.txt') || doc.name.endsWith('.md')) {
                    documentContext += `\n[${doc.name}]:\n${doc.content.substring(0, 1000)}...\n`;
                  }
                }
              });
            }
            
            const prompt = `You suggest exactly what someone should say next in a meeting. 

Provide 3-4 sentences that the person can actually say.
Be specific and directly related to the last few exchanges.
Use natural conversational language.
Move the conversation forward productively.
${documentContext ? 'Use the provided context documents (which could be resumes, agendas, project info, meeting notes, etc.) to give more informed, personalized responses that draw from relevant details.' : ''}

Do NOT say things like "Consider asking..." or "You might want to..." - just provide the actual words to say.

${seed}${documentContext}`;
            
            console.log('[MeetingChat] Sending request to Gemini...');
            console.log('[MeetingChat] Prompt being sent:', prompt);
            const result = await model.generateContent(prompt);
            console.log('[MeetingChat] Got Gemini response - raw result:', result);
            console.log('[MeetingChat] Response object:', result.response);
            
            let text = '';
            try {
              text = result.response?.text?.() || '';
              console.log('[MeetingChat] Response text method result:', text);
            } catch (textError) {
              console.error('[MeetingChat] Error calling text():', textError);
              // Try alternative access methods
              if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                text = result.response.candidates[0].content.parts[0].text;
                console.log('[MeetingChat] Got response from candidates structure');
              }
            }
            
            text = text.trim() || 'Could you elaborate on that last point?';
            console.log('[MeetingChat] Final processed text:', text);
            console.log('[MeetingChat] Text length:', text.length);
            console.log('[MeetingChat] Sending text to frontend...');
            send('text', text);
            console.log('[MeetingChat] Sent text, now sending stream_end...');
            send('stream_end');
            console.log('[MeetingChat] Say-next complete - all done!');
          } else {
            console.log('[MeetingChat] No GEMINI_API_KEY, using fallback response');
            // Fallback deterministic text
            send('text', 'What are the next steps we need to take to move this forward?');
            send('stream_end');
          }
        } catch (err) {
          console.error('[MeetingChat] say-next failed:', err);
          console.error('[MeetingChat] Error details:', err instanceof Error ? err.message : String(err));
          send('text', 'Ask for clarification on the last point and propose a next step.');
          send('stream_end');
        }
        return;
      }

      // For search actions: use Gemini 2.5 Flash for faster, longer responses
      if (action?.type === 'search' && (action?.query || action?.text)) {
        const searchQuery = action.query || action.text;
        console.log('[MeetingChat] 🔍 ===== SEARCH ACTION STARTED =====');
        console.log('[MeetingChat] 🔍 Search query:', searchQuery);
        console.log('[MeetingChat] 🔍 Chat ID:', chatId);
        console.log('[MeetingChat] 🔍 Action object:', JSON.stringify(action, null, 2));
        
        try {
          const geminiKey = process.env.GEMINI_API_KEY;
          console.log('[MeetingChat] 🔍 GEMINI_API_KEY present:', !!geminiKey);
          console.log('[MeetingChat] 🔍 GEMINI_API_KEY length:', geminiKey ? geminiKey.length : 0);
          
          if (geminiKey) {
            console.log('[MeetingChat] 🔍 Importing GoogleGenerativeAI...');
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            console.log('[MeetingChat] 🔍 Creating GenAI instance...');
            const genAI = new GoogleGenerativeAI(geminiKey);
            console.log('[MeetingChat] 🔍 Getting model...');
            const model = genAI.getGenerativeModel({ 
              model: "gemini-2.5-flash",
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 400, // Enough for a complete search response
              }
            });
            console.log('[MeetingChat] 🔍 Model configured successfully');
            
            const prompt = `You are a helpful assistant performing a web search for the user. 
Provide a clear, informative response with the most important and relevant facts.
Be direct and comprehensive but concise.

Web search query: "${searchQuery}"

Provide a helpful response with key information about the topic.`;
            
            // Generate response
            console.log('[MeetingChat] 🔍 Calling Gemini with prompt length:', prompt.length);
            console.log('[MeetingChat] 🔍 Full prompt:', prompt);
            
            console.log('[MeetingChat] 🔍 Making API call to Gemini...');
            const result = await model.generateContent(prompt);
            console.log('[MeetingChat] 🔍 API call completed, processing result...');
            console.log('[MeetingChat] 🔍 Result object:', result);
            console.log('[MeetingChat] 🔍 Result.response:', result.response);
            console.log('[MeetingChat] 🔍 Result.response.text:', typeof result.response?.text);
            
            let fullResponse = '';
            try {
              fullResponse = result.response?.text?.() || '';
              console.log('[MeetingChat] 🔍 Called text() successfully');
            } catch (textError) {
              console.error('[MeetingChat] 🔍 Error calling text():', textError);
              // Try alternative access methods
              if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
                fullResponse = result.response.candidates[0].content.parts[0].text;
                console.log('[MeetingChat] 🔍 Got response from candidates structure');
              }
            }
            
            console.log('[MeetingChat] 🔍 RAW FULL RESPONSE:', JSON.stringify(fullResponse));
            console.log('[MeetingChat] 🔍 Response type:', typeof fullResponse);
            console.log('[MeetingChat] 🔍 Response length:', fullResponse?.length || 0);
            console.log('[MeetingChat] 🔍 Response preview:', fullResponse?.substring?.(0, 200) || 'N/A');
            console.log('[MeetingChat] 🔍 Response trimmed empty?:', (!fullResponse || fullResponse.trim().length === 0));
            
            if (!fullResponse || fullResponse.trim().length === 0) {
              console.error('[MeetingChat] 🔍 ❌ EMPTY RESPONSE FROM GEMINI!');
              console.error('[MeetingChat] 🔍 ❌ Full result object for debugging:', JSON.stringify(result, null, 2));
              
              // Try to extract from candidates structure as fallback
              const resultAny = result as any;
              if (resultAny?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const fallbackResponse = resultAny.candidates[0].content.parts[0].text;
                console.log('[MeetingChat] 🔍 Using fallback response from candidates:', fallbackResponse);
                send('text', fallbackResponse);
                send('stream_end');
                return;
              }
              
              send('text', 'I received an empty response. Please try your search again.');
              send('stream_end');
              return;
            }
            
            console.log('[MeetingChat] 🔍 Starting to stream response...');
            // Stream the response in chunks for better UX
            const chunkSize = 50; // Characters per chunk
            let totalSent = 0;
            for (let i = 0; i < fullResponse.length; i += chunkSize) {
              const chunk = fullResponse.slice(i, i + chunkSize);
              console.log('[MeetingChat] 🔍 Sending chunk:', JSON.stringify(chunk));
              send('text', chunk);
              totalSent += chunk.length;
              await new Promise(resolve => setTimeout(resolve, 20)); // Small delay for streaming effect
            }
            
            console.log('[MeetingChat] 🔍 Total characters sent:', totalSent);
            console.log('[MeetingChat] 🔍 Sending stream_end...');
            send('stream_end');
            console.log('[MeetingChat] 🔍 ===== SEARCH ACTION COMPLETED =====');
          } else {
            // Fallback if no Gemini key
            send('text', `I would search for: "${searchQuery}"\n\nUnfortunately, I need a Gemini API key configured to provide search results.`);
            send('stream_end');
          }
        } catch (err) {
          console.error('[MeetingChat] 🔍 ❌ ===== SEARCH FAILED =====');
          console.error('[MeetingChat] 🔍 ❌ Error object:', err);
          console.error('[MeetingChat] 🔍 ❌ Error message:', err instanceof Error ? err.message : String(err));
          console.error('[MeetingChat] 🔍 ❌ Error stack:', err instanceof Error ? err.stack : 'No stack trace');
          console.log('[MeetingChat] 🔍 ❌ Sending fallback response...');
          send('text', `Search for "${searchQuery}" - Unable to complete search at this time. Error: ${err instanceof Error ? err.message : String(err)}`);
          send('stream_end');
          console.log('[MeetingChat] 🔍 ❌ ===== SEARCH ERROR HANDLING COMPLETED =====');
        }
        return;
      }
      
      // For other generic actions - use Gemini Flash
      if (action?.query || action?.text) {
        const q = action.query || action.text;
        console.log('[MeetingChat] Processing generic action:', q);
        
        try {
          const geminiKey = process.env.GEMINI_API_KEY;
          if (geminiKey) {
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ 
              model: "gemini-2.5-flash",
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 400, // Enough for a complete response
              }
            });
            
            // Create a helpful prompt based on the action
            const prompt = `Provide a brief, helpful response about: "${q}"

Write exactly 3-4 clear, informative sentences.
Focus on the most important and actionable information.
Be direct and concise. No bullet points, just flowing sentences.`;
            
            // Generate response
            const result = await model.generateContent(prompt);
            const fullResponse = result.response.text();
            
            // Stream the response with typing effect
            const words = fullResponse.split(' ');
            
            for (let i = 0; i < words.length; i++) {
              const wordToSend = (i > 0 ? ' ' : '') + words[i];
              send('text', wordToSend);
              
              // Small delay for typing effect (faster than character by character)
              if (i < words.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 30));
              }
            }
            
            send('stream_end');
            console.log('[MeetingChat] Generic action response completed');
          } else {
            // Fallback if no Gemini key
            send('text', 'Please configure GEMINI_API_KEY to enable AI responses.');
            send('stream_end');
          }
        } catch (err) {
          console.error('[MeetingChat] Generic action failed:', err);
          // Make sure to show error to user
          send('text', `I encountered an error processing your request about "${q}". Please try again.`);
          send('stream_end');
        }
        return;
      }
    } catch (e) {
      console.error('[MeetingChat] Failed to start chat:', e);
    }
  });

  // Glass-specific audio handlers
  ipcMain.on("glass-audio-chunk", async (_, data: { speaker: 'me' | 'them', audio: Float32Array }) => {
    const glassService = await getGlassListenService();
    const sttService = (glassService as any).sttService;
    if (sttService) {
      await sttService.addAudioChunk(data.speaker, data.audio);
    }
  });
  
  // Handle audio capture errors
  ipcMain.on("audio-capture-error", (_, error) => {
    logWithElapsed("setupMainHandlers", `Audio capture error: ${error}`);
    win?.webContents.send("conversation-error", { error });
  });
  
  ipcMain.on("audio-transcript", async (_, { transcript, speaker }) => {
    // Agent functionality removed - conversation monitoring disabled
    console.log(`Audio transcript received: [${speaker}] ${transcript}`);
  });

  // Additional Clonely-style handlers for live audio features
  ipcMain.on('live-audio-done', () => {
    console.log('[MainHandlers] Finishing turn...');
    const audioService = getLiveAudioService();
    if (!audioService.isActive()) return;
    audioService.finishTurn();
  });

  ipcMain.on('live-image-chunk', (_event, jpegBase64: string) => {
    console.log('[MainHandlers] Sending image chunk to Gemini...');
    const audioService = getLiveAudioService();
    audioService.sendImageChunk(jpegBase64);
  });

  ipcMain.on('live-audio-toggle-gemini', (_event, mute: boolean) => {
    console.log(`[MainHandlers] Toggling Gemini audio, mute: ${mute}`);
    const audioService = getLiveAudioService();
    audioService.toggleGeminiAudio(mute);
  });

  ipcMain.on('live-audio-send-text-input', (_event, text: string) => {
    console.log('[MainHandlers] Sending text input to Gemini:', text);
    const audioService = getLiveAudioService();
    audioService.sendTextInput(text);
  });
  
  // Add handler for mode toggling (simplified - no virtual cursor)
  ipcMain.on("toggle-collab-mode", async (_, isEnabled: boolean) => {
    try {
      if (isEnabled) {
        console.log('[MainHandlers] Agent mode enabled');
      } else {
        console.log('[MainHandlers] Agent mode disabled');
      }
    } catch (error) {
      console.error('[MainHandlers] Error toggling mode:', error);
    }
  });

  
  // Window controls
  ipcMain.on("minimize-window", () => {
    console.log('[MainHandlers] minimize-window called!');
    try {
      if (win && !win.isDestroyed()) {
        const currentlyHidden = !!(win as any).__opusHidden;
        if (!currentlyHidden && win.isVisible()) {
          // Hide completely
          win.hide();
          (win as any).__opusHidden = true;
          console.log('[MainHandlers] Window hidden');
        } else {
          // Show and bring to front
          win.show();
          try { (win as any).setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
          try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
          try { (win as any).moveTop?.(); } catch {}
          try { win.focus(); } catch {}
          try { win.setIgnoreMouseEvents(false); } catch {}
          (win as any).__opusHidden = false;
          console.log('[MainHandlers] Window shown');
        }
      }
    } catch (error) {
      console.error("Error handling hide:", error);
    }
  });

  ipcMain.on("set-ignore-mouse-events", (_, ignore: boolean) => {
    console.log('[MainHandlers] set-ignore-mouse-events called:', ignore);
    // Don't actually set ignore mouse events - keep window always interactive
    // This prevents the minimize issue when clicking buttons
  });
  
  // Disable resize handler to keep Clonely's fixed window behavior
  /*
  ipcMain.on("resize", async (_, w, h) => {
    logWithElapsed("setupMainHandlers", "resize event received");
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width } = primaryDisplay.workAreaSize;
    if (win) {
      const [winWidth] = win.getSize();
      const x = Math.round(width * 0.85 - winWidth / 2);
      win.setPosition(x, 50, true);
    }
    win?.setSize(w, h, true);
    logWithElapsed("setupMainHandlers", "resize event handled");
  });
  */

  ipcMain.on("message", async (event, userPrompt, options?: { 
    mode: string;
    isHighlightChat?: boolean;
    highlightedImage?: string;
    resumeContext?: { fileName: string, content: string };
  }) => {
        // Handle highlight chat first - use GPT-4o directly
    if (options?.isHighlightChat && options?.highlightedImage) {
      console.log('[MainHandlers] 🎯 Processing highlight chat with GPT-4o, prompt:', userPrompt);
      
      try {
        // Create log folder for this highlight chat
        const logFolder = createLogFolder(`highlight-${userPrompt.substring(0, 30)}`);
        const timestampFolder = path.join(logFolder, `${Date.now()}`);
        if (!fs.existsSync(timestampFolder)) {
          fs.mkdirSync(timestampFolder, { recursive: true });
        }
        
        // Save the highlighted image for logging
        const imagePath = path.join(timestampFolder, 'highlighted-image.png');
        const imageBuffer = Buffer.from(options.highlightedImage, 'base64');
        fs.writeFileSync(imagePath, imageBuffer);
        
        // Screen highlight analysis - use direct OpenAI call instead of removed agent streaming
        const streamGenerator = async function* () {
          try {
            const OpenAI = (await import('openai')).default;
            const openai = new OpenAI({
              apiKey: process.env.OPENAI_API_KEY
            });

            const analysisPrompt = `You are analyzing a highlighted/selected portion of a user's screen. The user asks: "${userPrompt}"

Please analyze the highlighted content and provide a helpful response. Consider:
- What type of content this appears to be (code, text, UI, error message, documentation, etc.)
- Answer the user's specific question about this content
- Provide clear, actionable information
- If it's code, explain what it does
- If it's an error, suggest how to fix it
- If it's documentation, summarize the key points

Keep your response under 7 sentences maximum. Be conversational and helpful.`;

            const response = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: analysisPrompt },
                    {
                      type: "image_url",
                      image_url: {
                        url: `data:image/png;base64,${options.highlightedImage}`
                      }
                    }
                  ]
                }
              ],
              max_tokens: 500
            });

            const analysisText = response.choices[0]?.message?.content || "I couldn't analyze the highlighted content.";
            yield { type: "text", content: analysisText };
          } catch (error) {
            console.error('[MainHandlers] Error in screen highlight analysis:', error);
            yield { type: "text", content: "Sorry, I couldn't analyze the highlighted content due to an error." };
          }
        }();
        
        console.log('[MainHandlers] 🎯 Starting GPT-5 analysis stream...');
        
        // Stream the response back to the frontend
        let highlightResponse = "";
        for await (const chunk of streamGenerator) {
          if (chunk.type === "text") {
            event.sender.send("stream", { type: "text", content: chunk.content });
            highlightResponse += chunk.content;
            // Dynamically resize window for highlight responses
            resizeWindowForContent(highlightResponse.length);
          } else if (chunk.type === "tool_start") {
            event.sender.send("stream", { type: "tool_start", toolName: (chunk as any).toolName });
          } else if (chunk.type === "tool_result") {
            event.sender.send("stream", { type: "tool_result", content: chunk.content });
          }
        }
        
        // End the stream explicitly without adding a 'complete' message in highlight mode
        event.sender.send("stream", { type: "stream_end" });
        console.log('[MainHandlers] ✅ Highlight analysis stream complete');
        
      } catch (error) {
        console.error('[MainHandlers] ❌ Error processing highlight chat:', error);
        event.sender.send("reply", {
          type: "error",
          message: "Failed to analyze highlighted content. Please try again."
        });
      }
      
      return; // Exit early for highlight chat
    }
    
    // Don't resize window - keep Clonely's fixed size
    logWithElapsed("setupMainHandlers", "message event received");
            // Agent mode removed - always false
        const isAgentMode = false;
    const isChatMode = options?.mode === "chat";
    
    // FAST PATH: Handle Chat mode immediately (bypass app detection entirely)
    if (isChatMode) {
      try {
        console.log('[MainHandlers] 💬 Chat mode (fast path): Starting response...');
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });

        // Get recent conversation for this renderer and append the current user turn
        const senderId = event.sender.id;
        const recentHistory = getRecentHistoryString(senderId, 4);
        appendToHistory(senderId, 'user', userPrompt);

        // Step 1: Ask if screenshot is needed
        const analysisPrompt = `The user says: "${userPrompt}"

Recent conversation:
${recentHistory || '(none)'}

TASK: Determine if this requires seeing the user's screen to answer properly.

Respond with exactly this format:
SCREENSHOT_NEEDED: [YES/NO]
REASON: [brief reason]`;

        // Add timeout for analysis to prevent hanging
        const analysisPromise = openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: analysisPrompt }],
          max_tokens: 100,
          temperature: 0.3
        });
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Analysis timeout')), 5000)
        );
        
        let needsScreenshot = false;
        try {
          const analysisResult = await Promise.race([analysisPromise, timeoutPromise]) as any;
          const analysisText = analysisResult.choices[0]?.message?.content || '';
          needsScreenshot = analysisText.includes('SCREENSHOT_NEEDED: YES');
          console.log(`[MainHandlers] 💬 Chat fast path: Screenshot needed = ${needsScreenshot}`);
        } catch (timeoutError) {
          console.warn('[MainHandlers] Screenshot analysis timed out, proceeding without screenshot');
          needsScreenshot = false;
        }

        // Optional: include one screenshot if needed
        let screenshotBase64: string | undefined;
        let stepFolder: string | undefined;
        if (needsScreenshot) {
          const mainLogFolder = createLogFolder(userPrompt);
          const stepTimestamp = Date.now().toString();
          stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
          if (!fs.existsSync(stepFolder)) fs.mkdirSync(stepFolder, { recursive: true });
          try {
            screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
          } catch (e) {
            console.warn('[MainHandlers] Chat fast path: screenshot capture failed, continuing without image');
          }
        }

               // Step 2: Stream a friendly, expressive conversational response (no tools)
       const chatPrompt = `You are in Chat mode. Have a friendly but neutral conversation with the user. Avoid sounding robotic.
- Be helpful and use a natural tone without excessive enthusiasm. 
- Provide useful context when appropriate. Be concise when the situation calls for it, but feel free to be more detailed when helpful.
${screenshotBase64 ? "You may reference the user's screen if relevant." : "Answer based on the text question only."}

Recent conversation:
${recentHistory || '(none)'}

User: ${userPrompt}`;

        // Prepare messages for OpenAI
        const messages: any[] = [{ role: "user", content: [] }];
        messages[0].content.push({ type: "text", text: chatPrompt });
        if (screenshotBase64) {
          messages[0].content.push({
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${screenshotBase64}`
            }
          });
        }

        let fullAssistant = '';
        let streamStarted = false;

        
        // Set a timeout for the entire streaming operation
        const streamTimeout = setTimeout(() => {
          if (!streamStarted) {
            console.error('[MainHandlers] Chat stream timeout - no response received');
            event.sender.send("reply", { 
              type: "error", 
              message: "Response timeout. Please try again." 
            });
            event.sender.send("stream", { type: "stream_end" });
            // Also send as ask-response for frontend compatibility
            event.reply('ask-response', "Response timeout. Please try again.");
          }
        }, 20000); // 15 second timeout
        
        try {
          console.log('[MainHandlers] Starting GPT-4o stream...');
          const stream = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
            max_tokens: 800,
            temperature: 0.7,
            stream: true
          });
          
          for await (const chunk of stream) {
            const chunkText = chunk.choices[0]?.delta?.content || '';
            
            if (chunkText) {
              streamStarted = true;
              clearTimeout(streamTimeout); // Clear timeout once we get first chunk
              
              fullAssistant += chunkText;
              
              // Send each chunk directly without complex deduplication
              event.sender.send("stream", { type: "text", content: chunkText });
            }
          }
          
          console.log('[MainHandlers] Stream complete. Full response length:', fullAssistant.length);
          event.sender.send("stream", { type: "stream_end" });
          
          if (fullAssistant.trim()) {
            console.log('[MainHandlers] Sending ask-response with full text');
            appendToHistory(senderId, 'assistant', fullAssistant.trim());
            // Also send as ask-response for frontend compatibility
            event.reply('ask-response', fullAssistant.trim());
            console.log('[MainHandlers] ask-response sent successfully');
          } else {
            console.warn('[MainHandlers] No response text to send!');
          }
        } finally {
          clearTimeout(streamTimeout);
        }
      } catch (error: any) {
        console.error('[MainHandlers] ❌ Chat fast path error:', error);
        console.error('[MainHandlers] Error details:', {
          message: error?.message,
          stack: error?.stack,
          name: error?.name,
          code: error?.code,
          status: error?.status
        });
        
        // Send a more informative error message
        const errorMessage = error?.message?.includes('API key') 
          ? "API key issue. Please check your OpenAI API key."
          : error?.message?.includes('quota') || error?.message?.includes('rate_limit')
          ? "API quota exceeded. Please try again later."
          : `Chat error: ${error?.message || 'Unknown error'}`;
        
        event.sender.send("reply", { 
          type: "error", 
          message: errorMessage 
        });
        
        // Also send stream_end to clean up UI state
        event.sender.send("stream", { type: "stream_end" });
        
        // Also send as ask-response for frontend compatibility
        event.reply('ask-response', errorMessage);
      }
      return;
    }
    
    // Virtual cursor management is now handled entirely by toggle-collab-mode
    // to prevent conflicts and mouse blocking issues
    
    // SILENT PRE-ASSESSMENT for agent mode (collaborative mode)
    let preAssessment: any = null;
    const isOpenOnlyPrompt = false; // Skip this check for speed
    // Skip pre-assessment for speed - agent will figure it out
    if (isAgentMode) {
      console.log(`[MainHandlers] 🚀 Fast mode: Skipping pre-assessment, agent will handle navigation`);
    }
    
            const history: any[] = [];
    let appName: string = "";
    let isOpenCommand = false;
    
    try {
      // Fast path for agent mode - use hybrid app detection
      if (isAgentMode) {
        console.log(`[MainHandlers] 🚀 Agent mode: Using hybrid app detection`);
        // Agent functionality removed - skip app detection
        console.log(`[MainHandlers] 🚀 Agent mode disabled - using default app detection`);
        const needsApp = false;
        if (needsApp) {
          console.log(`[MainHandlers] 🚀 App opening needed`);
          appName = "Desktop";
          isOpenCommand = true;
          console.log(`[MainHandlers] 🚀 Extracted app name: ${appName}`);
        } else {
          console.log(`[MainHandlers] 🚀 Gemini says: No app opening needed`);
          appName = "Desktop";
          isOpenCommand = false;
        }
      } else if (isChatMode) {
        console.log(`[MainHandlers] 💬 Chat mode: Skipping app detection, going to conversational analysis`);
        appName = "NONE"; // Don't try to detect any app in chat mode
        isOpenCommand = false;
      } else {
        // Use pre-assessment to inform app detection (only in agent mode)
        if (preAssessment && preAssessment.targetApp && preAssessment.needsNavigation) {
          appName = preAssessment.targetApp;
          isOpenCommand = true;
          console.log(`[MainHandlers] 🔍 Using pre-assessment result: ${appName} (navigation needed)`);

          // If this is a presentation task, prefer a browser workflow to Google Slides
          const isPresentation = /\b(presentation|slides|slide deck|deck|ppt|keynote)\b/i.test(userPrompt);
          if (isPresentation) {
            const browser = 'Google Chrome'; // Default browser
            console.log(`[MainHandlers] 🎯 Presentation task detected — routing via browser: ${browser}`);
            appName = browser;
            isOpenCommand = true;
          } else {
            // If the suggested app isn't installed, fallback to browser
            try { await getBundleId(appName); }
            catch {
              const browser = 'Google Chrome'; // Default browser
              console.log(`[MainHandlers] ⚠️ ${appName} not available — falling back to browser: ${browser}`);
              appName = browser;
              isOpenCommand = true;
            }
          }
        } else if (preAssessment && !preAssessment.needsNavigation) {
          appName = "NONE"; // Work with currently open apps
          isOpenCommand = false;
          console.log(`[MainHandlers] 🔍 Pre-assessment: No navigation needed, working with current apps`);
        } else {
          // Fallback to normal app detection
          appName = await getAppName(userPrompt) || "NONE";

          // If app detection failed but user intent is a presentation, choose a browser
          if (appName === "NONE") {
            const isPresentation = /\b(presentation|slides|slide deck|deck|ppt|keynote)\b/i.test(userPrompt);
            if (isPresentation) {
              const browser = 'Google Chrome'; // Default browser
              console.log(`[MainHandlers] 🎯 Presentation task with unknown app — choosing browser: ${browser}`);
              appName = browser;
              isOpenCommand = true;
            }
          }
        }
      }
      
      // Check if no app is needed (conversational/screen analysis message)
      if (appName === "NONE") {
        // In chat mode, use the smart fast assessment instead of hardcoded keywords
        if (isChatMode) {
          // Skip all agent mode logic and go directly to chat mode handling below
          console.log('[MainHandlers] 💬 Chat mode with NONE app - skipping to fast assessment...');
          // Do nothing here - let it fall through to the chat mode logic below
        } else {
          // Agent mode: Enhanced logic with pre-assessment context
          const isScreenAnalysis = userPrompt.toLowerCase().includes("screen") || 
                                   userPrompt.toLowerCase().includes("see") ||
                                   userPrompt.toLowerCase().includes("what") ||
                                   userPrompt.toLowerCase().includes("describe") ||
                                   userPrompt.toLowerCase().includes("analyze") ||
                                   userPrompt.toLowerCase().includes("looking");
          
          // If pre-assessment indicates we can work with current apps, treat as normal task
          const shouldWorkWithCurrentApps = preAssessment && !preAssessment.needsNavigation && 
                                           preAssessment.currentApps.length > 0;
          
          if (isScreenAnalysis && !shouldWorkWithCurrentApps) {
          // Perform screen analysis without requiring specific app
          const mainLogFolder = createLogFolder(userPrompt);
          const stepTimestamp = Date.now().toString();
          const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
          if (!fs.existsSync(stepFolder)) {
            fs.mkdirSync(stepFolder, { recursive: true });
          }
          
          try {
            // Take screenshot for analysis (skip in agent mode to prevent random screenshots)
            let screenshotBase64: string | undefined = undefined;
            if (!isAgentMode) {
              screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
              console.log('[MainHandlers] Screenshot captured, base64 length:', screenshotBase64?.length || 0);
            } else {
              console.log('[MainHandlers] 🚀 Agent mode: Skipping screenshot - will be handled by actions as needed');
            }
            
            // Agent functionality disabled - use mock response
            const streamGenerator = mockAgentStreaming();

            // Stream the analysis response
            console.log('[MainHandlers] Starting to stream screen analysis...');
            for await (const chunk of streamGenerator) {
              console.log('[MainHandlers] Received chunk:', chunk);
              if (chunk.type === "text") {
                event.sender.send("stream", {
                  type: "text",
                  content: chunk.content
                });
              } else if (chunk.type === "tool_call") {
                // Skip tool calls for analysis
                continue;
              } else if (chunk.type === "done") {
                event.sender.send("stream", {
                  type: "stream_end",
                  content: chunk.content
                });
                return;
              }
            }
            
            // After streaming is complete
            const analysisComplete = "I've analyzed your screen!";
            event.sender.send("reply", {
              type: "success",
              message: analysisComplete
            });
            
            // Notify frontend that streaming is done
            event.sender.send("stream", {
              type: "stream_end"
            });
            
            console.log('[MainHandlers] Screen analysis complete');
            return;
          } catch (error) {
            console.error('[MainHandlers] Error during screen analysis:', error);
            event.sender.send("reply", {
              type: "error",
              message: "Failed to analyze screen: " + error
            });
            return;
          }
        } else if (shouldWorkWithCurrentApps && preAssessment) {
          // Pre-assessment indicates we can work with current apps (e.g., "help with presentation" when PowerPoint is open)
          console.log(`[MainHandlers] 🔍 Working with current apps based on pre-assessment:`, preAssessment.currentApps);
          
          // Prefer explicitly requested app if present (e.g., "Open Chrome")
          let mainApp = preAssessment.currentApps[0] || "Desktop";
          try {
            const explicitApp = await getAppName(userPrompt);
            if (explicitApp) {
              mainApp = explicitApp;
              console.log(`[MainHandlers] ✅ Using explicitly requested app: ${mainApp}`);
            }
          } catch {}
          
          // Resolve bundle id for the chosen app
          let bundleIdForMainApp = "";
          try {
            bundleIdForMainApp = await getBundleId(mainApp);
            console.log(`[MainHandlers] 🔗 Resolved bundle id for ${mainApp}: ${bundleIdForMainApp}`);
          } catch (e) {
            console.warn(`[MainHandlers] ⚠️ Could not resolve bundle id for ${mainApp}:`, e);
          }
          
          // Process the prompt normally but with current app context
          const mainLogFolder = createLogFolder(userPrompt);
          const stepTimestamp = Date.now().toString();
          const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
          if (!fs.existsSync(stepFolder)) {
            fs.mkdirSync(stepFolder, { recursive: true });
          }
          
          try {
            // Take screenshot for context (skip in agent mode to prevent random screenshots)
            let screenshotBase64: string | undefined = undefined;
            if (!isAgentMode) {
              screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
              console.log('[MainHandlers] Screenshot captured for current app work, base64 length:', screenshotBase64?.length || 0);
            } else {
              console.log('[MainHandlers] 🚀 Agent mode: Skipping screenshot - will be handled by actions as needed');
            }
            
            // Skip clickable elements in agent mode for speed
            let clickableElements: Element[] = [];
            if (!isAgentMode && bundleIdForMainApp) {
              try {
                const result = await getClickableElements(bundleIdForMainApp, stepFolder);
                clickableElements = result.clickableElements;
                console.log(`[MainHandlers] Found ${clickableElements.length} clickable elements in ${mainApp}`);
              } catch (error) {
                console.warn(`[MainHandlers] Could not get clickable elements for ${mainApp}:`, error);
              }
            } else if (isAgentMode) {
              console.log(`[MainHandlers] 🚀 Agent mode: Skipping clickable elements for speed`);
            }
            
            // Use mock agent response
            const streamGenerator = mockAgentStreaming();

            // Stream the response
            console.log('[MainHandlers] Starting to stream current app interaction...');
            for await (const chunk of streamGenerator) {
              console.log('[MainHandlers] Received chunk:', chunk);
              if (chunk.type === "text") {
                event.sender.send("stream", {
                  type: "text",
                  content: chunk.content
                });
              } else if (chunk.type === "tool_call") {
                // Tool calls are handled by performAction
                continue;
              } else if (chunk.type === "done") {
                event.sender.send("stream", {
                  type: "stream_end",
                  content: chunk.content
                });
                return;
              }
            }
            
            console.log('[MainHandlers] Current app interaction complete');
            return;
          } catch (error) {
            console.error('[MainHandlers] Error during current app interaction:', error);
            event.sender.send("reply", {
              type: "error",
              message: "Failed to interact with current apps: " + error
            });
            return;
          }
        } else {
          // General conversational handling
          if (isChatMode) {
            // Fast two-step approach for chat mode
                         console.log('[MainHandlers] 💬 Chat mode: Starting fast response...', 'Prompt:', userPrompt);
            
            // Step 1: Quick Groq Llama-4 check (no screenshot) - should be ~200-500ms
            const { default: OpenAI } = await import("openai");
            const groq = new OpenAI({
              apiKey: process.env.GROQ_API_KEY || '',
              baseURL: 'https://api.groq.com/openai/v1'
            });

            const analysisPrompt = `The user says: "${userPrompt}"

TASK: Determine if this requires seeing the user's screen to answer properly.

Respond with exactly this format:
SCREENSHOT_NEEDED: [YES/NO]
REASON: [brief reason]

Examples:
- "Hi" or "Hello" → NO (general greeting)
- "What's on my screen?" → YES (explicitly asking about screen)
- "Explain this error" → YES (likely referring to something on screen)  
- "How do I code in Python?" → NO (general knowledge question)
- "What does this mean?" → YES (likely referring to something visible)
- "Tell me a joke" → NO (general request)`;

            try {
              const senderId = event.sender.id;
              const recentHistory = getRecentHistoryString(senderId, 4);
              console.log('[MainHandlers] 📚 Ask mode context (last 4 messages):');
              console.log(recentHistory || '(no previous messages)');
              appendToHistory(senderId, 'user', userPrompt);
              
              const analysisResult = await groq.chat.completions.create({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [{ role: 'user', content: analysisPrompt }],
                max_tokens: 100,
                temperature: 0.1
              });
              
              const analysisText = analysisResult.choices[0].message.content?.trim() || '';
              
              const needsScreenshot = analysisText.includes('SCREENSHOT_NEEDED: YES');

               console.log(`[MainHandlers] 💬 Analysis complete - Screenshot needed: ${needsScreenshot}`);

              if (needsScreenshot) {
                // Step 2: Take screenshot and do full analysis
                console.log('[MainHandlers] 💬 Taking screenshot for visual analysis...');
                const mainLogFolder = createLogFolder(userPrompt);
                const stepTimestamp = Date.now().toString();
                const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
                if (!fs.existsSync(stepFolder)) {
                  fs.mkdirSync(stepFolder, { recursive: true });
                }

                let screenshotBase64: string | undefined;
                try {
                  screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
                } catch (e) {
                  console.warn('[MainHandlers] Screenshot failed, using text-only response');
                }

                // Use Gemini 2.5 Flash for full analysis with screenshot
                const chatPrompt = `You are in Chat mode. The user asks: "${userPrompt}"

${screenshotBase64 ? 'I can see the user\'s screen. ' : ''}Please provide a helpful response. Be conversational and natural.

Recent conversation:
${recentHistory || '(none)'}

${screenshotBase64 ? 'Analyze what\'s visible on the screen and answer their question.' : 'Answer based on the context of their question.'}`;

                // Use OpenAI for vision capability (Groq doesn't support images yet)
                const { default: OpenAIClient } = await import("openai");
                const openai = new OpenAIClient({
                  apiKey: process.env.OPENAI_API_KEY || ''
                });

                const messages: any[] = [{
                  role: 'user',
                  content: screenshotBase64 ? [
                    { type: 'text', text: chatPrompt },
                    { 
                      type: 'image_url', 
                      image_url: { url: `data:image/png;base64,${screenshotBase64}` }
                    }
                  ] : chatPrompt
                }];

                let fullAssistant = '';
                const result = await openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: messages,
                  stream: true,
                  max_tokens: 1000,
                  temperature: 0.7
                });
                 
                // Stream the response
                for await (const chunk of result) {
                  const chunkText = chunk.choices[0]?.delta?.content || '';
                  if (chunkText) {
                    event.sender.send("stream", { type: "text", content: chunkText });
                    fullAssistant += chunkText;
                  }
                }
                event.sender.send("stream", { type: "stream_end" });
                if (fullAssistant.trim()) {
                  appendToHistory(senderId, 'assistant', fullAssistant.trim());
                }
              } else {
                // Step 2: Always generate a proper conversational response (no screenshot needed)
                console.log('[MainHandlers] 💬 No screenshot needed, generating conversational response...');
                console.log('[MainHandlers] 📚 Using context for response:');
                console.log(recentHistory || '(no previous messages)');
                
                const chatPrompt = `You are in Chat mode. Have a natural conversation with the user. Be helpful and friendly. Be concise when appropriate, but provide detailed responses when they would be more helpful.

Recent conversation:
${recentHistory || '(none)'}

User: ${userPrompt}`;

                console.log('[MainHandlers] 💬 Streaming Groq Llama-4 conversational response...');
                const result = await groq.chat.completions.create({
                  model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                  messages: [{ role: 'user', content: chatPrompt }],
                  stream: true,
                  max_tokens: 800,
                  temperature: 0.7
                });

                let fullAssistant = '';
                for await (const chunk of result) {
                  const chunkText = chunk.choices[0]?.delta?.content || '';
                  if (chunkText) {
                    event.sender.send('stream', { type: 'text', content: chunkText });
                    fullAssistant += chunkText;
                  }
                }
                 event.sender.send('stream', { type: 'stream_end' });
                 if (fullAssistant.trim()) {
                   appendToHistory(senderId, 'assistant', fullAssistant.trim());
                 }
              }

            } catch (error) {
              console.error('[MainHandlers] Chat mode error:', error);
              event.sender.send("reply", {
                type: "error", 
                message: "Sorry, I had trouble processing your message. Please try again."
              });
            }

          } else {
            // Agent mode - use LLM for greeting (no hardcoded messages!)
            console.log('[MainHandlers] 🤖 Agent mode: Generating LLM greeting...');
            
            try {
              const { GoogleGenerativeAI } = await import("@google/generative-ai");
              const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
              const agentModel = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                generationConfig: {
                  temperature: 0.7,
                  maxOutputTokens: 200, // Keep greetings concise
                }
              });

              const agentPrompt = `You are in Agent mode - you can help with tasks and perform actions on the computer. The user just opened the agent interface.

Provide a friendly greeting that invites them to ask for help with tasks. Be welcoming and natural.`;

              console.log('[MainHandlers] 🤖 Streaming agent greeting...');
              const result = await agentModel.generateContentStream(agentPrompt);
              
              for await (const chunk of result.stream) {
                const chunkText = chunk.text();
                if (chunkText) {
                  console.log('[MainHandlers] 🤖 Agent greeting chunk:', chunkText.substring(0, 50) + '...');
                  event.sender.send("stream", { type: "text", content: chunkText });
                }
              }
              console.log('[MainHandlers] 🤖 Agent greeting complete');
              event.sender.send("stream", { type: "stream_end" });

            } catch (error) {
              console.error('[MainHandlers] Agent greeting error:', error);
              event.sender.send("reply", {
                type: "error", 
                message: "I'm ready to help! What can I do for you?"
              });
            }
          }
        }
        } // Close the else block for agent mode
        return;
      }
      
      // Only open the app if NOT in collaborative mode or NOT an open command
      isOpenCommand = userPrompt.toLowerCase().includes("open");
      
      // In chat mode, prevent any actions like opening apps
      if (isChatMode && isOpenCommand) {
        // Let the natural response system handle this through contextual LLM responses
        // No hardcoded mode switching messages
        return;
      }
      
      // In agent mode for "open" commands, execute directly with visual navigation
      if (isAgentMode && isOpenCommand) {
        console.log(`[MainHandlers] Collaborative mode: Using visual navigation to open ${appName}`);
        
        try {
          // Open app using simple AppleScript
          await execPromise(`osascript -e 'tell application "${appName}" to activate'`);
      // For a simple open-only prompt, stop here — do not run the action agent
      if (isOpenOnlyPrompt) {
        return;
      }
      // Agent functionality removed
          return;
          
        } catch (error) {
          console.error(`[MainHandlers] Error in visual navigation:`, error);
          event.sender.send("reply", {
            type: "error",
            message: `Failed to open ${appName}: ${error}`,
          });
          return;
        }
      }
      
      // Only open the app if NOT in collaborative mode or NOT an open command
      if (!isAgentMode || !isOpenCommand) {
        await execPromise(`open -ga "${appName}"`);
        console.log(`[MainHandlers] Pre-opened ${appName} (collab: ${isAgentMode}, open cmd: ${isOpenCommand})`);
      } else {
        console.log(`[MainHandlers] Skipping pre-open of ${appName} in collab mode - letting agent handle it`);
      }
    } catch {
      logWithElapsed("setupMainHandlers", "Could not determine app");
      event.sender.send("reply", {
        type: "error",
        message: "Could not determine app.",
      });
      return;
    }
    logWithElapsed("setupMainHandlers", "appSelectionAgent run complete");
    if (!appName) {
      logWithElapsed("setupMainHandlers", "Could not determine app");
      event.sender.send("reply", {
        type: "error",
        message: "Could not determine app.",
      });
      return;
    }
    let bundleId: string = "";
    try {
      bundleId = await getBundleId(appName);
      logWithElapsed("setupMainHandlers", `Got bundleId: ${bundleId}`);
    } catch {
      logWithElapsed(
        "setupMainHandlers",
        `Could not get bundle id for ${appName}`
      );
      event.sender.send("reply", {
        type: "error",
        message: `Could not get bundle id for ${appName}`,
      });
      return;
    }
    const mainLogFolder = createLogFolder(userPrompt);
    console.log("\n");

    // Planning path for multi-step tasks in agent mode (disabled)
    if (isAgentMode) {
      console.log(`[MainHandlers] Agent mode planning disabled - using direct automation`);
    }

    let done = false;
    while (!done) {
      const stepTimestamp = Date.now().toString();
      const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
      if (!fs.existsSync(stepFolder)) {
        fs.mkdirSync(stepFolder, { recursive: true });
      }
      let clickableElements: Element[] = [];
      
      // In collab mode for "open" commands, use Desktop context to see current state
      const useDesktopContext = isAgentMode && isOpenCommand && !done;
      const contextApp = useDesktopContext ? "Desktop" : appName;
      const contextBundleId = useDesktopContext ? "com.apple.finder" : bundleId;
      
      if (useDesktopContext) {
        console.log(`[MainHandlers] Using Desktop context to check if ${appName} needs to be opened`);
      }
      
      try {
        const { clickableElements: els } = await getClickableElements(
          contextBundleId,
          stepFolder
        );
        clickableElements = els;
        console.log(`found ${clickableElements.length} elements`);
        logWithElapsed("setupMainHandlers", "Got clickable elements");
      } catch {
        logWithElapsed(
          "setupMainHandlers",
          `Could not get clickable elements for ${contextApp}`
        );
      }

      let screenshotBase64;
      try {
        screenshotBase64 = await takeAndSaveScreenshots(contextApp, stepFolder);
      } catch (err) {
        logWithElapsed(
          "setupMainHandlers",
          `Could not take screenshot: ${
            err instanceof Error ? err.stack || err.message : String(err)
          }`
        );
      }

      let action = "";
      let hasToolCall = false;

      logWithElapsed("runActionAgent", `Running action agent for app: ${contextApp}`);
      
      // Modify prompt based on mode
      let agentPrompt = userPrompt;
      
      // In chat mode, focus only on visual analysis and conversation
      if (isChatMode) {
        agentPrompt = `You are in Chat mode - you can only analyze what's on screen and have conversations. You CANNOT perform any actions like opening apps, clicking, or using tools.
        
User asks: "${userPrompt}"

Please analyze what's currently visible on the screen and provide a helpful conversational response. Focus on:
- Describing what you see
- Answering questions about content
- Explaining text, images, or UI elements
- Providing helpful insights about what's displayed

Do NOT use any tools. Just provide a conversational response about what you observe.`;
      } else if (useDesktopContext) {
        if (clickableElements.length === 0) {
          agentPrompt = `Open ${appName} immediately using Applescript. Your response must be EXACTLY:
=Applescript
tell application "${appName}"
  activate
end tell

Do NOT describe the screen. Do NOT add anything else. Just use the exact format above.`;
          console.log(`[MainHandlers] No clickable elements - instructing to use Applescript`);
        } else {
          agentPrompt = `Open ${appName} by clicking on its icon in the Dock (if available in the clickable elements) or using Applescript. The app is not currently open.`;
        }
        console.log(`[MainHandlers] Modified prompt for Desktop context: ${agentPrompt.substring(0, 100)}...`);
      }
      
      logWithElapsed("runActionAgent", "Saved agent-prompt.txt");
      logWithElapsed("runActionAgent", `Agent input has image: ${!!screenshotBase64}`);
      if (screenshotBase64) {
        logWithElapsed("runActionAgent", `Image data length: ${screenshotBase64.length}`);
      }
      
      const streamGenerator = mockAgentStreaming();

      // Stream tokens and handle tool calls
      for await (const chunk of streamGenerator) {
        switch (chunk.type) {
          case "text":
            event.sender.send("stream", {
              type: "text",
              content: chunk.content
            });
            action += chunk.content;
            // Dynamically resize window as content grows
            resizeWindowForContent(action.length);
            break;
          case "tool_start":
          case "tool_args":
          case "tool_execute":
            // Tool functionality disabled
            break;
          case "tool_result":
            event.sender.send("stream", {
              type: "tool_result",
              content: chunk.content
            });
            break;
        }
      }
      
      // Send a completion signal to frontend
      if (!hasToolCall && action.trim()) {
        // This was just text, mark streaming as complete for this chunk
        setTimeout(() => {
          event.sender.send("stream", { type: "chunk_complete" });
        }, 50);
      }

      logWithElapsed("setupMainHandlers", "actionAgent run complete");
      if (!action && !hasToolCall) {
        logWithElapsed("setupMainHandlers", "No action returned");
        event.sender.send("stream", { type: "stream_end" });
        setTimeout(() => {
          event.sender.send("reply", {
            type: "error",
            message: "No action returned.",
          });
        }, 50);
        return;
      }
      
      if (action === "done" || action === "(done)" || action.endsWith("STOP")) {
        logWithElapsed("setupMainHandlers", "Task complete");
        
        // Explicitly end streaming before sending completion reply
        event.sender.send("stream", { type: "stream_end" });
        
        // Small delay to ensure streaming ends before sending completion
        setTimeout(() => {
          event.sender.send("reply", {
            type: "complete",
            message: "Task complete.",
          });
        }, 50);
        
        new Notification({
          title: "Task complete",
          body: "Neatly's task is complete!",
        }).show();
        
        // Note: Virtual cursor remains visible in agent mode after task completion
        // It will only be hidden when the user explicitly exits agent mode
        
        done = true;
        break;
      }

      // Add to history after each interaction
      if (action.trim() || hasToolCall) {
        history.push({
          role: "assistant",
          content: [{ type: "output_text", text: action }],
          status: "completed",
        });
      }
      console.log("\n");
    }
    
    // Ensure streaming is properly ended if we exit the loop
    if (!done) {
      logWithElapsed("setupMainHandlers", "Loop ended without explicit completion");
      event.sender.send("stream", { type: "stream_end" });
      setTimeout(() => {
        event.sender.send("reply", {
          type: "complete", 
          message: "Task completed."
        });
      }, 50);
    }

    

    // Planning path for multi-step tasks in agent mode (disabled)
    if (isAgentMode) {
      console.log(`[MainHandlers] Agent mode planning disabled - using direct automation`);
    }
  });

  // Toggle click-through based on chat input focus/blur
  ipcMain.on('chat:focus', () => {
    try {
      if (win && !win.isDestroyed()) {
        // Keep overlay above and interactive
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any);
        win.setAlwaysOnTop(true, 'screen-saver');
        // @ts-ignore
        win.moveTop?.();
        win.setIgnoreMouseEvents(false);
      }
    } catch {}
  });

  ipcMain.on('chat:blur', () => {
    try {
      if (win && !win.isDestroyed()) {
        // Keep overlay above but pass clicks through
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setIgnoreMouseEvents(true, { forward: true } as any);
      }
    } catch {}
  });

  // Advanced mouse detection for interactive areas
  ipcMain.on('mouse:enter-interactive', () => {
    try {
      if (win && !win.isDestroyed()) {
        // Make window interactive when mouse enters interactive areas
        win.setIgnoreMouseEvents(false);
      }
    } catch {}
  });

  ipcMain.on('mouse:leave-interactive', () => {
    try {
      if (win && !win.isDestroyed()) {
        // Make window click-through when mouse leaves interactive areas
        win.setIgnoreMouseEvents(true, { forward: true } as any);
      }
    } catch {}
  });

  // Browser Agent Mode handlers
  // Removed duplicate start-browser-monitoring handler; unified handler exists below

  ipcMain.on("stop-browser-monitoring", async (_event) => {
    try {
      console.log('[MainHandlers] Stopping browser monitoring for agent mode');
      browserDetection.stopMonitoring();
      browserDetection.removeAllListeners('browser-detected');
      
      // Note: macOS agent handles its own cleanup
      console.log('[MainHandlers] Browser monitoring stopped successfully');
      
    } catch (error) {
      console.error('[MainHandlers] Error stopping browser monitoring:', error);
    }
  });

  // Emergency stop handler
  ipcMain.on("emergency-stop-monitoring", async (_event) => {
    try {
      console.log('[MainHandlers] Emergency stop - Closing automation');
      
      // Note: macOS agent handles its own cleanup
      console.log('[MainHandlers] Emergency stop: macOS agent handles its own cleanup');
      
      // For NanoBrowser, close the sidebar
      mainWindow?.webContents.send('nanobrowser-closed', true);
    } catch (error) {
      console.error('[MainHandlers] Error in emergency stop:', error);
    }
  });

  // Helper to open macOS System Settings for screen recording permissions
  ipcMain.on("open-screen-recording-settings", async (_event) => {
    try {
      console.log('[MainHandlers] Opening Screen Recording settings...');
      const childProcess = await import('node:child_process');
      // Open System Settings to Screen Recording permissions
      childProcess.spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
    } catch (error) {
      console.error('[MainHandlers] Failed to open Screen Recording settings:', error);
    }
  });

  // Check if Chrome is active
  ipcMain.on("check-chrome-active", async (event) => {
    try {
      const activeBrowser = await browserDetection.getActiveBrowser();
      console.log('[MainHandlers] Active browser detected:', activeBrowser);
      const isChromeActive = activeBrowser?.name === 'Google Chrome';
      console.log('[MainHandlers] Is Chrome active?', isChromeActive);
      event.reply("chrome-status", isChromeActive);
    } catch (error) {
      console.error('[MainHandlers] Error checking Chrome status:', error);
      event.reply("chrome-status", false);
    }
  });

  // Start browser monitoring for agent mode
  ipcMain.on("start-browser-monitoring", async (event) => {
    try {
      console.log('[MainHandlers] Starting browser monitoring for agent mode');
      await browserDetection.startMonitoring();
      
      // Listen for browser detection events
      const handleBrowserDetected = (browserInfo: any) => {
        console.log('[MainHandlers] Browser detected:', browserInfo);
        const isChromeActive = browserInfo.name === 'Google Chrome';
        if (isChromeActive) {
          console.log('[MainHandlers] Chrome detected - sending auto-switch signal');
          mainWindow?.webContents.send('browser-detected', { 
            browserName: browserInfo.name, 
            isChromeActive: true 
          });
        }
      };
      
      // Remove any existing listeners first
      browserDetection.removeAllListeners('browser-detected');
      
      // Add new listener
      browserDetection.on('browser-detected', handleBrowserDetected);
      
      event.reply("browser-monitoring-started", true);
    } catch (error) {
      console.error('[MainHandlers] Error starting browser monitoring:', error);
      event.reply("browser-monitoring-started", false);
    }
  });

  // Check accessibility permissions
  ipcMain.handle('check-accessibility-permissions', async () => {
    try {
      // Use Swift script to check accessibility permissions
      const swiftPath = path.join(app.getAppPath(), 'swift', 'accessibility.swift');
      await execPromise(`swift ${swiftPath} --check-only`);
      return { enabled: true };
    } catch (error) {
      // If Swift script fails, accessibility is not enabled
      console.log('[MainHandlers] Accessibility check failed:', error);
      return { enabled: false };
    }
  });

  // Open System Settings to accessibility page
  ipcMain.on('open-accessibility-settings', async () => {
    try {
      await execPromise('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
      console.log('[MainHandlers] Opened accessibility settings');
    } catch (error) {
      console.error('[MainHandlers] Failed to open accessibility settings:', error);
    }
  });

  // Open Chrome browser
  ipcMain.on("open-chrome", async (_event) => {
    try {
      console.log('[MainHandlers] Opening Chrome and setting fullscreen...');
      
      // First activate Chrome
      await execPromise(`osascript -e 'tell application "Google Chrome" to activate'`);
      
      // Wait a moment for Chrome to activate
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Just activate Chrome (no fullscreen here - let nanobrowser handle it)
      try {
        await execPromise(`osascript -e '
          tell application "Google Chrome"
            if (count of windows) is 0 then
              make new window
            end if
            activate
          end tell'`);
        console.log('[MainHandlers] Chrome activated successfully');
      } catch (windowError) {
        console.log('[MainHandlers] Chrome activation failed:', windowError);
      }
      
      console.log('[MainHandlers] Chrome opened and activated successfully');
    } catch (error) {
      console.error('[MainHandlers] Error opening Chrome:', error);
    }
  });

  // Handle NanoBrowser commands
  ipcMain.on("nanobrowser-command", async (event, command: string) => {
    try {
      console.log('[MainHandlers] NanoBrowser command received:', command);
      console.log('[MainHandlers] Using macOS agent for NanoBrowser commands...');

      // Use macOS agent for all NanoBrowser commands
      const { TerminatorMacOSAgent } = await import('./services/macos/TerminatorMacOSAgent.ts');
      const { AgentOverlayService } = await import('./services/AgentOverlayService.ts');
      
      // Show blue overlay immediately with fade-in animation
      const overlay = new AgentOverlayService();
      await overlay.show();
      
      console.log('[MainHandlers] Executing macOS automation...');
      const agent = new TerminatorMacOSAgent();
      await agent.executeTask(command, event as any, 'nanobrowser-response');
      console.log('[MainHandlers] Agent execution completed');

    } catch (error) {
      console.error('[MainHandlers] Error processing NanoBrowser command:', error);
      event.reply('nanobrowser-response', `Error: ${error}`);
    }
  });

  // Handle NanoBrowser stop
  ipcMain.on("nanobrowser-stop", async (event) => {
    try {
      console.log('[MainHandlers] 🛑 Automation stop requested');
      
      // Note: macOS agent handles its own cleanup
      console.log('[MainHandlers] macOS agent handles its own cleanup');
      
      event.reply('nanobrowser-response', 'Automation stopped');
      
    } catch (error) {
      console.error('[MainHandlers] Error stopping automation:', error);
      event.reply('nanobrowser-response', `Error: ${error}`);
    }
  });

  // Intelligent Gemini-powered macOS command handler
  ipcMain.on("gemini-macos-command", async (event, userInput: string, conversationHistory?: Array<{role: 'user' | 'assistant', content: string}>) => {
    try {
      console.log('[MainHandlers] Processing Gemini macOS command:', userInput);
      
      // Immediately reset UI to thinking state for new requests
      event.reply('gemini-macos-response', {
        type: 'thinking',
        content: ''
      });
      
      // Get any uploaded images for this sender
      const uploadedImages = (event.sender as any).uploadedImages || [];
      if (uploadedImages.length > 0) {
        console.log('[MainHandlers] MacOS Agent including', uploadedImages.length, 'uploaded images');
        // Clear images after use
        (event.sender as any).uploadedImages = [];
      }
      
      // Use LLM to intelligently determine if this is conversational vs actionable
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
      
      // Build context from conversation history
      const contextString = conversationHistory && conversationHistory.length > 0 
        ? `\n\nConversation context:\n${conversationHistory.slice(-4).map(msg => `${msg.role}: ${msg.content}`).join('\n')}`
        : '';
      
      const classificationPrompt = `Analyze this user input and determine if it requires automation or is conversational:

User input: "${userInput}"${contextString}

Respond with JSON only:
{
  "type": "automation" | "conversational",
  "response": "contextual response if conversational, empty if automation"
}

Guidelines:
- "automation": Tasks requiring system actions (open apps, browse web, file operations, messaging, calculations, etc.)
  * Common automation patterns: "message/text [person]", "open [app]", "go to [website]", "calculate [math]", "search for [topic]"
  * ANY task involving apps is automation: "use [app]", "talk to [app]", "conversation with [app]", "chat with [app]"
  * Include commands with typos or informal language that clearly indicate actions
  * If it mentions an app name (ChatGPT, Safari, Messages, etc.) → automation
- "conversational": Pure greetings, thank you, casual responses, acknowledgments, questions about the assistant
  * ONLY when NO apps, actions, or tasks are mentioned
- Consider conversation context - if they just completed a task and say "thanks", respond conversationally  
- Be intelligent about context - "open safari" = automation, "thanks that worked!" = conversational
- When in doubt, prefer automation - better to try automating than miss a legitimate request`;

      try {
        const classificationResult = await model.generateContent(classificationPrompt);
        const classificationText = classificationResult.response.text().trim();
        
        // Clean markdown formatting from LLM response
        let cleanJson = classificationText;
        if (classificationText.includes('```json')) {
          cleanJson = classificationText.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        } else if (classificationText.includes('```')) {
          cleanJson = classificationText.replace(/```\s*/, '').replace(/```\s*$/, '').trim();
        }
        
        const classification = JSON.parse(cleanJson);
        console.log('[MainHandlers] Classification result:', classification);
        
        if (classification.type === 'conversational' && classification.response) {
          console.log('[MainHandlers] LLM classified as conversational, responding directly');
          event.reply('gemini-macos-response', {
            type: 'conversation',
            content: classification.response
          });
          return;
        } else if (classification.type === 'conversational') {
          console.log('[MainHandlers] Conversational but no response provided, generating default');
          event.reply('gemini-macos-response', {
            type: 'conversation',
            content: 'Hello! How can I help you today?'
          });
          return;
        }
      } catch (classificationError) {
        console.log('[MainHandlers] LLM classification failed, proceeding with automation:', classificationError);
        // If classification fails, default to treating as automation request
      }
      
      // Agent mode: Use intelligent system for automation requests
      console.log('[MainHandlers] Agent mode - using intelligent agent system for:', userInput);
      
      // Add conversation context to the task if available
      let contextualTask = userInput;
      if (conversationHistory && conversationHistory.length > 0) {
        const recentContext = conversationHistory.slice(-4).map(msg => 
          `${msg.role}: ${msg.content}`
        ).join('\n');
        contextualTask = `Previous conversation context:\n${recentContext}\n\nCurrent request: ${userInput}`;
        console.log('[MainHandlers] Including conversation context for agent task');
      }
      
      // Execute the intelligent AI automation immediately
      console.log('[MainHandlers] Executing intelligent automation:', contextualTask);
      
      try {
        // Always use macOS agent for everything - no more complex routing!
        console.log('[MainHandlers] 🖥️ Using macOS agent for all tasks (browser + desktop)');
        console.log('[MainHandlers] 🔍 IMPORTANT: Using MACOS AGENT with scanning for everything!');
        
        const { TerminatorMacOSAgent } = await import('./services/macos/TerminatorMacOSAgent.ts');
        const { AgentOverlayService } = await import('./services/AgentOverlayService.ts');
        
        // Show blue overlay immediately with fade-in animation
        const overlay = new AgentOverlayService();
        await overlay.show();
        
        console.log('[MainHandlers] Executing macOS automation...');
        const agent = new TerminatorMacOSAgent();
        currentAgent = agent; // Store reference for termination
        agent.executeTask(contextualTask, event as any, 'gemini-macos-response');
        
        console.log('[MainHandlers] AI action plan completed');
      } catch (error) {
        console.error('[MainHandlers] Error executing AI automation:', error);
        event.reply('gemini-macos-response', {
          type: 'conversation',
          content: `Error starting intelligent automation: ${error}`
        });
      }
      return;
    } catch (error) {
      console.error('[MainHandlers] Main handler error:', error);
      event.reply('gemini-macos-response', {
        type: 'conversation',
        content: 'Error processing request'
      });
    }
  });

  // Handle pending agent task retrieval
  ipcMain.handle("get-pending-agent-task", async () => {
    return process.env.PENDING_AGENT_TASK || null;
  });

  // Handle pending agent task clearing
  ipcMain.on("clear-pending-agent-task", async () => {
    delete process.env.PENDING_AGENT_TASK;
  });

  // Meeting document upload handler
  ipcMain.on('meeting-document-uploaded', (_event, document) => {
    console.log('[MainHandlers] 📄 Meeting document uploaded:', document.name);
    
    // Store document globally for meeting context
    if (!(global as any).meetingDocuments) {
      (global as any).meetingDocuments = [];
    }
    
    (global as any).meetingDocuments.push({
      name: document.name,
      content: document.content,
      type: document.type,
      uploadedAt: document.uploadedAt
    });
    
    console.log('[MainHandlers] 📄 Total meeting documents:', (global as any).meetingDocuments.length);
  });

  // Handle image uploads from Ask/Agent modes
  ipcMain.on('images-uploaded', (event, data) => {
    console.log('[MainHandlers] 📷 Images uploaded:', data.images?.length || 0);
    // Store images for the current session - they'll be included with the next message
    (event.sender as any).uploadedImages = data.images || [];
  });

  // Generate personalized completion message
  ipcMain.on("generate-completion-message", async (event, originalTask: string) => {
    try {
      console.log('[MainHandlers] Generating completion message for task:', originalTask);
      
      const prompt = `The user asked an AI agent to: "${originalTask}"

The task has been completed successfully! Generate a short, fun, enthusiastic completion message (max 10 words) that:
- Shows excitement about the completed task
- Is personalized to what they actually did
- Has personality and happiness
- Uses casual, friendly language

Examples:
- For posting: "Done! Hope it goes viral! 🚀"
- For deleting messages: "Done! All cleaned up! ✨"
- For shopping: "Done! Happy shopping! 🛍️"
- For sending emails: "Done! Message sent perfectly! 📧"

Just return the completion message, nothing else.`;

      // Use Gemini 2.0 Flash for completion message
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY not found');
      }
      
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 50,
        }
      });

      const response = await result.response;
      const message = response.text()?.trim() || 'Done! ✨';
      
      console.log('[MainHandlers] Generated completion message:', message);
      event.reply('completion-message-response', { 
        type: 'completion_message', 
        message: message 
      });

    } catch (error) {
      console.error('[MainHandlers] Failed to generate completion message:', error);
      event.reply('completion-message-response', { 
        type: 'completion_message', 
        message: 'Done! ✨' 
      });
    }
  });

  // Store reference to current agent for termination
  let currentAgent: any = null;

  // Terminate agent immediately
  ipcMain.on("terminate-agent", async (event) => {
    try {
      console.log('[MainHandlers] Agent termination requested by user');
      
      // Stop any running automation
      if (currentAgent) {
        console.log('[MainHandlers] Stopping TerminatorAgent...');
        currentAgent.stop();
        currentAgent = null;
      }
      
      // Send immediate termination response
      event.reply('gemini-macos-response', {
        type: 'terminated',
        content: 'Agent stopped by user'
      });
      
      console.log('[MainHandlers] Agent terminated successfully');
    } catch (error) {
      console.error('[MainHandlers] Error terminating agent:', error);
    }
  });

  // Process sendMessage requests (ask mode)
  ipcMain.on("sendMessage", async (event, message: string, options: any = {}) => {
    console.log('[MainHandlers] Received sendMessage:', message, 'Options:', options);
    
    const senderId = event.sender.id;
    // const sessionId = `session-${senderId}-${Date.now()}`; // Unused
    
    // Neatly identity intercept: if user asks who you are, always answer consistently
    const lowered = (message || '').trim().toLowerCase();
    if (lowered === 'who are you' || lowered === 'who are you?' || lowered === 'what are you' || lowered === 'what are you?' || lowered.includes('who are you') || lowered.includes('what are you') || lowered.includes('your name')) {
      const identity = 'I am Neatly, your on-device assistant.';
      appendToHistory(senderId, 'assistant', identity);
      event.reply('ask-response', identity);
      return;
    }

    // Get any uploaded images for this sender
    const uploadedImages = (event.sender as any).uploadedImages || [];
    if (uploadedImages.length > 0) {
      console.log('[MainHandlers] Including', uploadedImages.length, 'uploaded images');
      // Clear images after use
      (event.sender as any).uploadedImages = [];
    }
    
    // Append to history for this sender
    appendToHistory(senderId, 'user', message);
    
    if (options.mode === "chat") {
      try {
        let screenshot = null;
        
        // Take screenshot for screen analysis if no images provided
        if (uploadedImages.length === 0) {
          console.log('[MainHandlers] Taking screenshot for ask mode...');
          const primaryDisplay = screen.getPrimaryDisplay();
          screenshot = await win?.webContents.capturePage({
            x: 0,
            y: 0,
            width: primaryDisplay.bounds.width,
            height: primaryDisplay.bounds.height
          });
          console.log('[MainHandlers] Screenshot captured successfully');
        }
        
        let imageData = '';
        if (screenshot) {
          imageData = screenshot.toDataURL();
          console.log('[MainHandlers] Screenshot converted to data URL, length:', imageData.length);
        } else if (uploadedImages.length > 0) {
          // Use first uploaded image for analysis
          imageData = uploadedImages[0].data;
          console.log('[MainHandlers] Using uploaded image, length:', imageData.length);
        }
        
        // Build prompt for image analysis, branded for Neatly
        const prompt = uploadedImages.length > 0 
          ? `You are Neatly, an on-device assistant. The user uploaded ${uploadedImages.length} image(s) and asks: "${message}". Analyze the image(s) and provide a helpful, concise response.`
          : `You are Neatly, an on-device assistant. The user is asking about what's visible on their screen: "${message}". Analyze the screenshot and provide a helpful response based on what you can see.`;
        
        console.log('[MainHandlers] Sending to Gemini Vision for analysis...');
        const response = await geminiVision.analyzeImageWithPrompt(imageData, prompt);
        console.log('[MainHandlers] Gemini Vision response received:', response ? 'Success' : 'Empty');
        
        if (response) {
          event.reply('ask-response', response);
          appendToHistory(senderId, 'assistant', response);
          console.log('[MainHandlers] Ask response sent to renderer');
        } else {
          console.warn('[MainHandlers] Empty response from Gemini Vision');
          event.reply('ask-response', 'I was able to analyze your screen but couldn\'t generate a response. Please try asking again.');
        }
      } catch (error) {
        console.error('[MainHandlers] Vision analysis failed:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'No stack trace';
        console.error('[MainHandlers] Error details:', errorMessage);
        console.error('[MainHandlers] Error stack:', errorStack);
        event.reply('ask-response', `Sorry, I encountered an error analyzing the image: ${errorMessage}`);
      }
    } else {
      // Handle other modes...
    }
  });

  // Select mode (screen highlight) IPC
  ipcMain.removeAllListeners("start-screen-highlight"); // Remove any existing listeners
  ipcMain.on("start-screen-highlight", async (_event) => {
    try {
      console.log('[MainHandlers] Starting screen highlight - aggressive cleanup first');
      
      // Close ALL windows that might be highlight overlays
      const allWindows = BrowserWindow.getAllWindows();
      allWindows.forEach(window => {
        if (!window.isDestroyed()) {
          const title = window.getTitle();
          if (title === 'Screen Highlight' || title === '' || window.isAlwaysOnTop()) {
            // Check if it's likely an overlay (transparent, always on top, etc.)
            if (window !== win) { // Don't close the main window
              console.log('[MainHandlers] Force closing potential overlay window:', title);
              window.close();
            }
          }
        }
      });
      
      const { getScreenHighlightService } = await import("./services/ScreenHighlightService");
      const highlightService = getScreenHighlightService();
      if (highlightService) {
        // Force cleanup any existing overlay before starting new one
        console.log('[MainHandlers] Cleaning up existing overlay service');
        highlightService.cleanup();
        
        // Longer delay to ensure cleanup completes
        await new Promise(resolve => setTimeout(resolve, 300));
        
        await highlightService.startScreenHighlight();
      } else {
        console.error('[MainHandlers] start-screen-highlight requested but service not initialized');
      }
    } catch (err) {
      console.error('[MainHandlers] Failed to start screen highlight:', err);
    }
  });

  ipcMain.on("cancel-screen-highlight", async (_event) => {
    try {
      const { getScreenHighlightService } = await import("./services/ScreenHighlightService");
      const highlightService = getScreenHighlightService();
      if ((highlightService as any)?.cleanup) {
        (highlightService as any).cleanup();
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send('screen-highlight-cancelled');
      }
    } catch (err) {
      console.error('[MainHandlers] Failed to cancel screen highlight:', err);
    }
  });

  // Relay from overlay back to renderer when ESC or UI cancels selection
  ipcMain.on("screen-highlight-cancelled", async (_event) => {
    console.log('[MainHandlers] Forwarding screen-highlight-cancelled to renderer');
    if (win && !win.isDestroyed()) {
      win.webContents.send('screen-highlight-cancelled');
    }
    
    // Clean up the screen highlight service on cancel
    const { getScreenHighlightService } = await import("./services/ScreenHighlightService");
    const highlightService = getScreenHighlightService();
    if (highlightService) {
      highlightService.cleanup();
    }
  });

  // Overlay requests area capture; we take a fresh screen capture of the primary display and crop it
  ipcMain.on("capture-screen-area-for-prompt", async (_event, selection: { x: number; y: number; width: number; height: number }) => {
    try {
      console.log('[MainHandlers] Capturing screen area:', selection);
      
      // Get actual screen dimensions
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: actualScreenWidth, height: actualScreenHeight } = primaryDisplay.bounds;
      const scaleFactor = primaryDisplay.scaleFactor;
      
      // Account for menu bar height on macOS + additional offset for accuracy  
      const menuBarHeight = -40; // NEGATIVE offset - screenshot was too high, so we need to go DOWN
      
      console.log('[MainHandlers] Screen info:', { 
        actualScreenWidth, 
        actualScreenHeight, 
        scaleFactor,
        menuBarHeight
      });
      
      // Capture primary screen thumbnail via desktopCapturer
      const sources = await desktopCapturer.getSources({ 
        types: ['screen'], 
        thumbnailSize: { 
          width: actualScreenWidth * scaleFactor, 
          height: actualScreenHeight * scaleFactor 
        }, 
        fetchWindowIcons: false 
      });
      const primary = sources[0];
      if (!primary || primary.thumbnail.isEmpty()) {
        throw new Error('No screen source available');
      }
      const image = primary.thumbnail;
      const capturedWidth = image.getSize().width;
      const capturedHeight = image.getSize().height;
      
      console.log('[MainHandlers] Captured image size:', { capturedWidth, capturedHeight });

      // Calculate scaling ratios
      const scaleX = capturedWidth / actualScreenWidth;
      const scaleY = capturedHeight / actualScreenHeight;
      
      console.log('[MainHandlers] Scale ratios:', { scaleX, scaleY });

      // Scale selection coordinates to match captured image
      // Adjust Y coordinate to account for menu bar
      const adjustedY = selection.y - menuBarHeight;
      
      const scaledX = selection.x * scaleX;
      const scaledY = Math.max(0, adjustedY * scaleY); // Ensure Y is not negative
      const scaledWidth = selection.width * scaleX;
      const scaledHeight = selection.height * scaleY;
      
      console.log('[MainHandlers] Scaled selection:', { 
        originalY: selection.y,
        adjustedY,
        scaledX, scaledY, scaledWidth, scaledHeight 
      });

      // Clamp selection to image bounds
      const sx = Math.max(0, Math.min(scaledX, capturedWidth - 1));
      const sy = Math.max(0, Math.min(scaledY, capturedHeight - 1));
      const sw = Math.max(1, Math.min(scaledWidth, capturedWidth - sx));
      const sh = Math.max(1, Math.min(scaledHeight, capturedHeight - sy));
      
      console.log('[MainHandlers] Final crop area:', { sx, sy, sw, sh });

      const cropped = image.crop({ x: Math.floor(sx), y: Math.floor(sy), width: Math.floor(sw), height: Math.floor(sh) });
      const imageBase64 = cropped.toPNG().toString('base64');

      if (win && !win.isDestroyed()) {
        win.webContents.send('screen-captured-for-prompt', { imageBase64 });
      }
      
      // Clean up the screen highlight service after capture
      const { getScreenHighlightService } = await import("./services/ScreenHighlightService");
      const highlightService = getScreenHighlightService();
      if (highlightService) {
        highlightService.cleanup();
      }
    } catch (err) {
      console.error('[MainHandlers] Failed to capture screen area:', err);
      
      // Also cleanup on error
      const { getScreenHighlightService } = await import("./services/ScreenHighlightService");
      const highlightService = getScreenHighlightService();
      if (highlightService) {
        highlightService.cleanup();
      }
    }
  });

  let recordingIntervals = new Map<number, NodeJS.Timeout>();
  let recordingBuffers = new Map<number, string[]>();

  // Screen recording: start capturing screenshots every ~200ms
  ipcMain.on('recording:start', async (event) => {
    try {
      const senderId = event.sender.id;
      // Reset any previous session
      if (recordingIntervals.has(senderId)) {
        clearInterval(recordingIntervals.get(senderId)!);
        recordingIntervals.delete(senderId);
      }
      recordingBuffers.set(senderId, []);

      const captureOnce = async () => {
        try {
          const primaryDisplay = screen.getPrimaryDisplay();
          const { width: sw, height: sh } = primaryDisplay.bounds;
          const scaleFactor = primaryDisplay.scaleFactor;
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            fetchWindowIcons: false,
            thumbnailSize: { width: Math.max(1, Math.floor(sw * scaleFactor)), height: Math.max(1, Math.floor(sh * scaleFactor)) }
          });
          const primary = sources[0];
          if (!primary || primary.thumbnail.isEmpty()) return;
          const base64 = primary.thumbnail.toPNG().toString('base64');
          const arr = recordingBuffers.get(senderId);
          if (arr) {
            arr.push(base64);
            // Optional: bound memory (e.g., keep last N)
            if (arr.length > 2000) arr.shift();
          }
          // Progress update to renderer (count only)
          if (win && !win.isDestroyed()) {
            win.webContents.send('recording:progress', { count: recordingBuffers.get(senderId)?.length || 0 });
          }
        } catch (e) {
          // swallow individual capture errors
        }
      };

      // Prime first capture immediately to align with 200ms cadence
      await captureOnce();
      const interval = setInterval(captureOnce, 200);
      recordingIntervals.set(senderId, interval);
      if (win && !win.isDestroyed()) {
        win.webContents.send('recording:started');
      }
    } catch (err) {
      console.error('[MainHandlers] Failed to start recording:', err);
      if (win && !win.isDestroyed()) {
        win.webContents.send('recording:error', String(err));
      }
    }
  });

  // Stop recording and return images (kept in memory until analyze or reset)
  ipcMain.on('recording:stop', (event) => {
    const senderId = event.sender.id;
    if (recordingIntervals.has(senderId)) {
      clearInterval(recordingIntervals.get(senderId)!);
      recordingIntervals.delete(senderId);
    }
    const images = recordingBuffers.get(senderId) || [];
    if (win && !win.isDestroyed()) {
      win.webContents.send('recording:stopped', { count: images.length });
    }
  });

  // Analyze recorded images with a user prompt and then clear buffer for this sender
  ipcMain.on('recording:analyze', async (event, userPrompt: string) => {
    const senderId = event.sender.id;
    try {
      const images = recordingBuffers.get(senderId) || [];
      if (images.length === 0) {
        event.reply('ask-response', 'No screenshots were recorded. Try recording again.');
        return;
      }

      // Identity intercept for recording flow as well
      const loweredPrompt = (userPrompt || '').trim().toLowerCase();
      if (loweredPrompt.includes('who are you') || loweredPrompt.includes('what are you') || loweredPrompt.includes('your name')) {
        const identity = 'I am Neatly, your on-device assistant.';
        appendToHistory(senderId, 'assistant', identity);
        event.reply('ask-response', identity);
        recordingBuffers.delete(senderId);
        return;
      }

      // Append to per-sender chat history
      appendToHistory(senderId, 'user', userPrompt);

      // Send to Vision multi-image analyzer with video context, branded for Neatly
      const videoPrompt = `You are Neatly, an on-device assistant. You are analyzing ${images.length} sequential screenshots captured from a screen recording (like frames from a video). When the user asks "what do you see?" or "what did I do?", they mean throughout the ENTIRE recording - analyze ALL ${images.length} frames equally, not just the most recent ones.

User's question: "${userPrompt}"

IMPORTANT: Analyze the COMPLETE sequence from start to finish. When answering questions like "what did I do on my computer?", describe activities throughout the entire recording duration, not just what's visible in the final frames. Look at all frames to understand the full timeline of actions and activities.

Provide a concise, helpful answer as Neatly that covers the entire recording period.`;
      
      const response = await geminiVision.analyzeImagesWithPrompt(images, videoPrompt);
      appendToHistory(senderId, 'assistant', response);

      // Reply back to renderer using existing ask-response channel to show in chat
      event.reply('ask-response', response);

      // Clear buffer after analysis to release memory
      recordingBuffers.delete(senderId);
    } catch (err) {
      console.error('[MainHandlers] recording:analyze failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      event.reply('ask-response', `Sorry, I couldn't analyze the recording: ${msg}`);
    }
  });

  // Clipboard IPC
  ipcMain.handle('clipboard-write', async (_event, payload: { text?: string; html?: string; imageBase64?: string }) => {
    const { ClipboardService } = await import('./services/ClipboardService');
    return ClipboardService.write(payload || {});
  });

  ipcMain.handle('clipboard-read-text', async () => {
    const { ClipboardService } = await import('./services/ClipboardService');
    return ClipboardService.readText();
  });

  ipcMain.handle('clipboard-read-html', async () => {
    const { ClipboardService } = await import('./services/ClipboardService');
    return ClipboardService.readHTML();
  });

  ipcMain.handle('clipboard-read-image-base64', async () => {
    const { ClipboardService } = await import('./services/ClipboardService');
    return ClipboardService.readImageBase64();
  });

  // Copy screenshot area directly to clipboard
  ipcMain.on('copy-screen-area-to-clipboard', async (_event, selection: { x: number; y: number; width: number; height: number }) => {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const captured = await win?.webContents.capturePage({
        x: 0,
        y: 0,
        width: primaryDisplay.bounds.width,
        height: primaryDisplay.bounds.height,
      });
      if (!captured) return;

      const image = nativeImage.createFromDataURL(captured.toDataURL());
      const imageSize = image.getSize();
      const scaleX = imageSize.width / primaryDisplay.size.width;
      const scaleY = imageSize.height / primaryDisplay.size.height;

      // Adjust for menu bar on macOS
      const menuBarHeight = process.platform === 'darwin' ? screen.getPrimaryDisplay().bounds.y * -1 : 0;
      const adjustedY = selection.y - menuBarHeight;

      const sx = Math.max(0, Math.min(Math.floor(selection.x * scaleX), imageSize.width - 1));
      const sy = Math.max(0, Math.min(Math.floor(Math.max(0, adjustedY) * scaleY), imageSize.height - 1));
      const sw = Math.max(1, Math.min(Math.floor(selection.width * scaleX), imageSize.width - sx));
      const sh = Math.max(1, Math.min(Math.floor(selection.height * scaleY), imageSize.height - sy));

      const cropped = image.crop({ x: sx, y: sy, width: sw, height: sh });
      const { ClipboardService } = await import('./services/ClipboardService');
      ClipboardService.write({ imageBase64: cropped.toPNG().toString('base64') });
      if (win && !win.isDestroyed()) win.webContents.send('copied-screen-area-to-clipboard');

      const { getScreenHighlightService } = await import('./services/ScreenHighlightService');
      const highlightService = getScreenHighlightService();
      if (highlightService) highlightService.cleanup();
    } catch (err) {
      console.error('[MainHandlers] Failed to copy screen area to clipboard:', err);
    }
  });

  // Paste image from clipboard into the focused app by simulating Cmd+V via System Events
  ipcMain.on('paste-image-from-clipboard', async () => {
    try {
      await execPromise(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`);
    } catch (err) {
      console.error('[MainHandlers] Failed to paste image via keystroke:', err);
    }
  });
}