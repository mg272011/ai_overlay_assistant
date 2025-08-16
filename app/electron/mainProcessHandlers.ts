// @ts-ignore
import { app, BrowserWindow, ipcMain, Notification, screen } from "electron";
import OpenAI from 'openai';
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppName, getBundleId } from "./utils/getAppInfo";
import { getClickableElements } from "./utils/getClickableElements";
import { takeAndSaveScreenshots } from "./utils/screenshots";
import { execPromise, logWithElapsed } from "./utils/utils";
import { performAction } from "./performAction";
// Removed unused imports: runAppleScript, key
import { Element } from "./types";
import { LiveAudioService } from "./services/LiveAudioService";
// Removed unused import: geminiVision
import { initScreenHighlightService, getScreenHighlightService } from "./services/ScreenHighlightService";
import { ContextualActionsService } from "./services/ContextualActionsService";
import { browserDetection } from "./services/BrowserDetectionService";
// import { ListenService } from "./services/glass/ListenService"; // Replaced by JavaScript version

// Mock function to replace agent functionality
async function* mockAgentStreaming() {
  yield { type: "text", content: "Agent mode has been disabled. This functionality is no longer available." };
}

// OpenAI client for fallback
let openaiClient: OpenAI | null = null;
try {
  openaiClient = new OpenAI();
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

type PlanStep = {
  id: number;
  title: string;
  action: 'open_app' | 'navigate_url' | 'agent';
  params?: Record<string, any>;
  check?: { type: 'app_frontmost' | 'url_contains'; value: string };
};

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
    console.log('[MainHandlers] 🎤 Received live-audio-chunk, size:', chunk.byteLength);
    
    try {
      // Convert to base64 and send to Glass JavaScript STT
      if (glassJSListenService && glassJSListenService.isSessionActive()) {
        const buffer = Buffer.from(chunk);
        
        // The audio is interleaved stereo PCM16 at 16kHz
              // Channel 0 (left) = Microphone (user speaking)
      // Channel 1 (right) = System audio (other person speaking)
      
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
        
        // Send left channel to mic STT (Me)
        const micBase64 = leftChannel.toString('base64');
        await glassJSListenService.sendMicAudioContent(micBase64);
        
        // Send right channel to system STT (Them)
        const systemBase64 = rightChannel.toString('base64');
        await glassJSListenService.sendSystemAudioContent(systemBase64);
        
        console.log('[MainHandlers] 🎤 Sent left channel to Mic STT, right channel to System STT');
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
      } else {
        console.log('[MainHandlers] No search items to send');
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
            
            const prompt = `You suggest exactly what someone should say next in a meeting. 

Provide 3-4 sentences that the person can actually say.
Be specific and directly related to the last few exchanges.
Use natural conversational language.
Move the conversation forward productively.

Do NOT say things like "Consider asking..." or "You might want to..." - just provide the actual words to say.

${seed}`;
            
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
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
        const fastModel = genAI.getGenerativeModel({ 
          model: "gemini-2.5-flash",
          generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
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
        const analysisPromise = fastModel.generateContent(analysisPrompt);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Analysis timeout')), 5000)
        );
        
        let needsScreenshot = false;
        try {
          const analysisResult = await Promise.race([analysisPromise, timeoutPromise]) as any;
          const analysisText = analysisResult.response.text();
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

        const chatSession = fastModel.startChat();
        const contentParts: any[] = [{ text: chatPrompt }];
        if (screenshotBase64) {
          contentParts.push({ inlineData: { mimeType: "image/png", data: screenshotBase64 } });
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
          }
        }, 10000); // 10 second timeout
        
        try {
          const result = await chatSession.sendMessageStream(contentParts);
          for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
              streamStarted = true;
              clearTimeout(streamTimeout); // Clear timeout once we get first chunk
              event.sender.send("stream", { type: "text", content: chunkText });
              fullAssistant += chunkText;
            }
          }
          event.sender.send("stream", { type: "stream_end" });
          if (fullAssistant.trim()) {
            appendToHistory(senderId, 'assistant', fullAssistant.trim());
          }
        } finally {
          clearTimeout(streamTimeout);
        }
      } catch (error: any) {
        console.error('[MainHandlers] ❌ Chat fast path error:', error);
        console.error('[MainHandlers] Error details:', {
          message: error?.message,
          stack: error?.stack,
          name: error?.name
        });
        
        // Send a more informative error message
        const errorMessage = error?.message?.includes('API key') 
          ? "API key issue. Please check your Gemini API key."
          : error?.message?.includes('quota')
          ? "API quota exceeded. Please try again later."
          : `Chat error: ${error?.message || 'Unknown error'}`;
        
        event.sender.send("reply", { 
          type: "error", 
          message: errorMessage 
        });
        
        // Also send stream_end to clean up UI state
        event.sender.send("stream", { type: "stream_end" });
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
            const browser = await resolvePreferredBrowser();
            console.log(`[MainHandlers] 🎯 Presentation task detected — routing via browser: ${browser}`);
            appName = browser;
            isOpenCommand = true;
          } else {
            // If the suggested app isn't installed, fallback to browser
            try { await getBundleId(appName); }
            catch {
              const browser = await resolvePreferredBrowser();
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
              const browser = await resolvePreferredBrowser();
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
            
            // Step 1: Quick Gemini 2.5 Flash check (no screenshot) - should be ~1-2 seconds
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
            const fastModel = genAI.getGenerativeModel({ 
              model: "gemini-2.5-flash",
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 800, // Reasonable response length for speed
              }
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
              appendToHistory(senderId, 'user', userPrompt);
              const analysisResult = await fastModel.generateContent(analysisPrompt);
              const analysisText = analysisResult.response.text();
              
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

                const chatSession = fastModel.startChat();
                const contentParts: any[] = [{ text: chatPrompt }];
                if (screenshotBase64) {
                  contentParts.push({
                    inlineData: {
                      mimeType: "image/png",
                      data: screenshotBase64
                    }
                  });
                }

                let fullAssistant = '';
                                 const result = await chatSession.sendMessageStream(contentParts);
                 
                 // Stream the response
                 for await (const chunk of result.stream) {
                   const chunkText = chunk.text();
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
                
                const chatPrompt = `You are in Chat mode. Have a natural conversation with the user. Be helpful and friendly. Be concise when appropriate, but provide detailed responses when they would be more helpful.

Recent conversation:
${recentHistory || '(none)'}

User: ${userPrompt}`;

                console.log('[MainHandlers] 💬 Streaming Gemini 2.5 Flash conversational response...');
                                 const result = await fastModel.generateContentStream(chatPrompt);

                 let fullAssistant = '';
                 for await (const chunk of result.stream) {
                   const chunkText = chunk.text();
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
        event.sender.send("reply", {
          type: "error",
          message: "I can't open apps in Chat mode. Switch to Agent mode if you want me to perform actions, or ask me about what's on your screen instead.",
        });
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

    // Planning path for multi-step tasks in agent mode
    if (isAgentMode) {
      const plan = buildPlanForTask(userPrompt);
      if (plan) {
        console.log(`[MainHandlers] Executing structured plan for: ${userPrompt}`);
        await executePlan(plan, event, history, isAgentMode);
        return;
      }
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
          body: "Opus's task is complete!",
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

    

    // Planning path for multi-step tasks in agent mode
    if (isAgentMode) {
      const plan = buildPlanForTask(userPrompt);
      if (plan) {
        console.log(`[MainHandlers] Executing structured plan for: ${userPrompt}`);
        await executePlan(plan, event, history, isAgentMode);
        return;
      }
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

  // Browser Agent Mode handlers
  ipcMain.on("start-browser-monitoring", async (_event) => {
    try {
      console.log('[MainHandlers] Starting NanoBrowser agent mode');
      
      // For NanoBrowser, we just need to verify Chrome is active
      // We don't need the overlay or continuous monitoring
      const activeBrowser = await browserDetection.getActiveBrowser();
      if (activeBrowser?.name === 'Google Chrome') {
        console.log('[MainHandlers] Chrome is active, NanoBrowser agent ready');
        mainWindow?.webContents.send('nanobrowser-ready', true);
      } else {
        console.log('[MainHandlers] Chrome not active');
        mainWindow?.webContents.send('nanobrowser-ready', false);
      }
    } catch (error) {
      console.error('[MainHandlers] Error starting NanoBrowser agent:', error);
    }
  });

  ipcMain.on("stop-browser-monitoring", async (_event) => {
    try {
      console.log('[MainHandlers] Stopping browser monitoring for agent mode');
      browserDetection.stopMonitoring();
      browserDetection.removeAllListeners('browser-detected');
      console.log('[MainHandlers] Browser monitoring stopped successfully');
    } catch (error) {
      console.error('[MainHandlers] Error stopping browser monitoring:', error);
    }
  });

  // Emergency stop handler
  ipcMain.on("emergency-stop-monitoring", async (_event) => {
    try {
      console.log('[MainHandlers] Emergency stop - Closing NanoBrowser agent');
      // For NanoBrowser, just close the sidebar
      mainWindow?.webContents.send('nanobrowser-closed', true);
    } catch (error) {
      console.error('[MainHandlers] Error in emergency stop:', error);
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

  // Handle Chrome agent activation (for continuing tasks)
  ipcMain.on("chrome-agent-activated", async (_event) => {
    try {
      console.log('[MainHandlers] Chrome agent activated - ready to continue tasks');
      // The task will automatically continue in Chrome agent since it's now active
    } catch (error) {
      console.error('[MainHandlers] Error handling Chrome agent activation:', error);
    }
  });

  // Handle NanoBrowser commands
  ipcMain.on("nanobrowser-command", async (event, command: string) => {
    try {
      console.log('[MainHandlers] NanoBrowser command received:', command);

      // Gently bring Chrome to foreground if needed
      try {
        await execPromise(`osascript -e 'tell application "Google Chrome" to activate'`);
        await new Promise(r => setTimeout(r, 200));
      } catch {}

      // Prefer structured execution via executor
      console.log('[MainHandlers] Importing executor...');
      const { buildActionPlanFromCommand, executeActionPlan } = await import('./services/chrome/executor.ts');
      console.log('[MainHandlers] Building action plan for command:', command);
      const plan = buildActionPlanFromCommand(command);
      console.log('[MainHandlers] Action plan:', plan);
      console.log('[MainHandlers] Executing action plan...');
      await executeActionPlan(plan, event, 'nanobrowser-response');
      console.log('[MainHandlers] Action plan completed');

    } catch (error) {
      console.error('[MainHandlers] Error processing NanoBrowser command:', error);
      event.reply('nanobrowser-response', `Error: ${error}`);
    }
  });

  // Handle NanoBrowser stop
  ipcMain.on("nanobrowser-stop", async (event) => {
    try {
      console.log('[MainHandlers] 🛑 NanoBrowser stop requested');
      
      // Stop any ongoing Chrome automation
      const chrome = await import('./services/chrome/ChromeDevtoolsService');
      const chromeService = chrome.default; // Already an instance
      
      // Try to close the browser instance if it exists
      try {
        if (chromeService && (chromeService as any).browser) {
          console.log('[MainHandlers] Closing Chrome browser instance...');
          await (chromeService as any).browser.close();
          (chromeService as any).browser = null;
          (chromeService as any).page = null;
        }
      } catch (closeError) {
        console.warn('[MainHandlers] Error closing Chrome:', closeError);
      }
      
      // Send confirmation back to UI
      event.reply('nanobrowser-response', '🛑 Agent stopped successfully');
      console.log('[MainHandlers] ✅ NanoBrowser stopped successfully');
      
    } catch (error) {
      console.error('[MainHandlers] ❌ Error stopping NanoBrowser:', error);
      event.reply('nanobrowser-response', `❌ Error stopping: ${error}`);
    }
  });

  // Intelligent Gemini-powered macOS command handler
  ipcMain.on("gemini-macos-command", async (event, userInput: string) => {
    try {
      console.log('[MainHandlers] Processing Gemini macOS command:', userInput);
      
      // Quick check for obvious conversational inputs - skip Gemini for speed
      const lowerInput = userInput.toLowerCase().trim();
      const conversationalWords = ['hi', 'hello', 'hey', 'how are you', 'what\'s up', 'sup', 'howdy', 'greetings'];
      
      if (conversationalWords.some(word => lowerInput === word || lowerInput.startsWith(word))) {
        console.log('[MainHandlers] Detected conversational input, using quick response');
        event.reply('gemini-macos-response', {
          type: 'conversation',
          content: 'Hey there! 👋 Head over to Chat mode for conversations. I\'m your browser automation buddy - try "open google" or "new tab"!'
        });
        return;
      }
      
      // Check for complex browser tasks that require Chrome + nanobrowser
      const complexBrowserTasks = [
        'flight', 'book', 'hotel', 'reservation', 'buy', 'purchase', 'shop', 'order',
        'form', 'signup', 'login', 'account', 'checkout', 'cart', 'search for',
        'find me', 'look for', 'browse', 'website', 'site'
      ];
      
      const isComplexTask = complexBrowserTasks.some(task => lowerInput.includes(task)) || 
                           (lowerInput.includes('open') && lowerInput.includes('chrome')) ||
                           lowerInput.length > 50; // Long requests likely need browser automation
      
      if (isComplexTask) {
        console.log('[MainHandlers] Detected complex browser task, checking Chrome status...');
        
        // First check if Chrome is actually visible and in fullscreen
        let chromeIsVisible = false;
        try {
          const result = await execPromise(`osascript -e '
            tell application "System Events"
              set chromeVisible to false
              set chromeFullscreen to false
              try
                tell process "Google Chrome"
                  set chromeVisible to frontmost
                  if chromeVisible then
                    try
                      set windowCount to count of windows
                      if windowCount > 0 then
                        tell window 1
                          set chromeFullscreen to (get value of attribute "AXFullScreen")
                        end tell
                      end if
                    end try
                  end if
                end tell
              end try
              return (chromeVisible as string) & "," & (chromeFullscreen as string)
            end tell'`);
          
          const [visible, fullscreen] = result.stdout.trim().split(',');
          chromeIsVisible = visible === 'true' && fullscreen === 'true';
          console.log('[MainHandlers] Chrome visible and fullscreen:', chromeIsVisible);
        } catch (checkError) {
          console.log('[MainHandlers] Chrome status check failed:', checkError);
        }
        
        // If Chrome is not visible and fullscreen, use AppleScript to open/activate it
        if (!chromeIsVisible) {
          console.log('[MainHandlers] Chrome not visible/fullscreen, using AppleScript to activate...');
          
          event.reply('gemini-macos-response', {
            type: 'browser_action',
            content: 'I can help with that! Let me open Chrome in fullscreen and then handle your request...'
          });
          
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Chrome opening timeout')), 10000);
              
              const openChrome = async () => {
                try {
                  console.log('[MainHandlers] Opening Chrome and setting fullscreen...');
                  
                  // First activate Chrome
                  await execPromise(`osascript -e 'tell application "Google Chrome" to activate'`);
                  
                  // Wait for Chrome to activate
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // Just activate Chrome (ChromeDevtoolsService will handle fullscreen properly)
                  try {
                    await execPromise(`osascript -e '
                      tell application "Google Chrome"
                        if (count of windows) is 0 then
                          make new window
                        end if
                        activate
                      end tell'`);
                    console.log('[MainHandlers] Chrome activated - ChromeDevtoolsService will handle fullscreen');
                  } catch (windowError) {
                    console.log('[MainHandlers] Chrome activation setup failed:', windowError);
                  }
                  
                  // Wait for Chrome to be fully ready
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  
                  console.log('[MainHandlers] Chrome opened and ready');
                  clearTimeout(timeout);
                  resolve();
                } catch (error) {
                  clearTimeout(timeout);
                  reject(error);
                }
              };
              
              openChrome();
            });
            
            // Now store the task for the Chrome agent to pick up
            process.env.PENDING_AGENT_TASK = userInput;
            
          } catch (error) {
            console.error('[MainHandlers] Error opening Chrome:', error);
            event.reply('gemini-macos-response', {
              type: 'conversation',
              content: 'I had trouble opening Chrome in fullscreen. Please try opening it manually and then ask me again.'
            });
          }
          return;
        } else {
          console.log('[MainHandlers] Chrome is already visible and fullscreen, proceeding with browser automation...');
          // Chrome is already visible and fullscreen, proceed with nanobrowser
          event.reply('gemini-macos-response', {
            type: 'browser_action',
            content: 'I can help with that! Chrome is ready - I\'ll use browser automation to handle your request...'
          });
          
          // Store the task for the Chrome agent
          process.env.PENDING_AGENT_TASK = userInput;
          return;
        }
      }
      
      // Use Gemini to determine intent and generate response for simple tasks
      const prompt = `You are a browser automation assistant for macOS. Your main job is to help with browser commands, not general conversation.

User input: "${userInput}"

Analyze this input and respond with JSON in this format:
{
  "type": "conversation" | "browser_action",
  "response": "Your response to the user",
  "applescript": "AppleScript commands if this is a browser action (optional)"
}

If it's casual conversation (like "hi", "hello", "how are you"), respond briefly but redirect them to Ask mode for chatting.
If it's a browser command, provide both a response and the AppleScript commands.

Browser actions you can handle:
- "open google" -> Opens Google.com
- "search for X" -> Searches Google for X  
- "go back" -> Browser back button
- "go forward" -> Browser forward button
- "refresh" -> Refresh page
- "new tab" -> Open new tab
- "close tab" -> Close current tab

Examples:
- "hi" -> {"type": "conversation", "response": "Hi! I'm your browser automation assistant. For general chatting, please use Ask mode. I'm here to help with browser commands like 'open google' or 'search for something'."}
- "how are you" -> {"type": "conversation", "response": "I'm doing well, thanks! For conversations, try Ask mode. I specialize in browser automation - try commands like 'new tab' or 'go back'."}
- "open google" -> {"type": "browser_action", "response": "Opening Google for you!", "applescript": "tell application \\"System Events\\" to keystroke \\"l\\" using command down; delay 0.5; tell application \\"System Events\\" to keystroke \\"google.com\\"; delay 0.5; tell application \\"System Events\\" to key code 36"}`;

      try {
        console.log('[MainHandlers] Starting Gemini API call...');
        
        // Check if API key exists
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not found in environment variables');
        }
        console.log('[MainHandlers] API key found, length:', apiKey.length);
        
        // Use Gemini directly for text generation
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        console.log('[MainHandlers] Sending prompt to Gemini...');
        
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Gemini API timeout after 3 seconds')), 3000)
        );
        
        const result = await Promise.race([
          model.generateContent(prompt),
          timeoutPromise
        ]) as any;
        
        const response = result.response.text();
        console.log('[MainHandlers] Gemini response received:', response.substring(0, 100) + '...');
        
        try {
          // Clean up response - remove markdown code blocks if present
          let cleanResponse = response.trim();
          if (cleanResponse.startsWith('```json')) {
            cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          } else if (cleanResponse.startsWith('```')) {
            cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
          }
          
          const parsedResponse = JSON.parse(cleanResponse);
          
          // If it's a browser action with AppleScript, execute it
          if (parsedResponse.type === 'browser_action' && parsedResponse.applescript) {
            try {
              // Split multiple commands and execute them
              const commands = parsedResponse.applescript.split(';');
              for (const cmd of commands) {
                const trimmedCmd = cmd.trim();
                if (trimmedCmd) {
                  await execPromise(`osascript -e '${trimmedCmd}'`);
                }
              }
              console.log('[MainHandlers] AppleScript executed successfully');
            } catch (error) {
              console.error('[MainHandlers] AppleScript execution failed:', error);
              parsedResponse.response = `I tried to ${userInput.toLowerCase()}, but encountered an error: ${error}`;
            }
          }
          
          event.reply('gemini-macos-response', {
            type: parsedResponse.type,
            content: parsedResponse.response
          });
          
        } catch (parseError) {
          console.error('[MainHandlers] Failed to parse Gemini response:', parseError);
          // Fallback: treat as conversation
          event.reply('gemini-macos-response', {
            type: 'conversation',
            content: response || "I heard you, but I'm having trouble processing that request right now."
          });
        }
             } catch (geminiError) {
         console.error('[MainHandlers] Gemini API error:', geminiError);
         console.log('[MainHandlers] Attempting OpenAI fallback...');
         
         // Try OpenAI as fallback
         if (openaiClient) {
           try {
             const completion = await openaiClient.chat.completions.create({
               model: 'gpt-4o-mini',
               messages: [
                 { 
                   role: 'system', 
                   content: `You are a browser automation assistant for macOS. Your main job is to help with browser commands, not general conversation.

If it's casual conversation (like "hi", "hello", "how are you"), respond briefly but redirect them to Ask mode for chatting.
If it's a browser command, provide both a response and the AppleScript commands.

Browser actions you can handle:
- "open google" -> Opens Google.com
- "search for X" -> Searches Google for X  
- "go back" -> Browser back button
- "go forward" -> Browser forward button
- "refresh" -> Refresh page
- "new tab" -> Open new tab
- "close tab" -> Close current tab

Respond with JSON in this format:
{
  "type": "conversation" | "browser_action",
  "response": "Your response to the user",
  "applescript": "AppleScript commands if this is a browser action (optional)"
}`
                 },
                 { role: 'user', content: userInput }
               ],
               max_tokens: 300,
               temperature: 0.3
             });
             
             const response = completion.choices[0]?.message?.content?.trim() || '';
             console.log('[MainHandlers] OpenAI fallback response received');
             
             // Same JSON parsing logic as Gemini
             let cleanResponse = response.trim();
             if (cleanResponse.startsWith('```json')) {
               cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
             } else if (cleanResponse.startsWith('```')) {
               cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
             }
             
             const parsedResponse = JSON.parse(cleanResponse);
             
             // If it's a browser action with AppleScript, execute it
             if (parsedResponse.type === 'browser_action' && parsedResponse.applescript) {
               try {
                 // Split multiple commands and execute them
                 const commands = parsedResponse.applescript.split(';');
                 for (const cmd of commands) {
                   const trimmedCmd = cmd.trim();
                   if (trimmedCmd) {
                     await execPromise(`osascript -e '${trimmedCmd}'`);
                   }
                 }
                 console.log('[MainHandlers] AppleScript executed successfully (OpenAI)');
               } catch (error) {
                 console.error('[MainHandlers] AppleScript execution failed:', error);
                 parsedResponse.response = `I tried to ${userInput.toLowerCase()}, but encountered an error: ${error}`;
               }
             }
             
             event.reply('gemini-macos-response', {
               type: parsedResponse.type,
               content: parsedResponse.response
             });
             
           } catch (openaiError) {
             console.error('[MainHandlers] OpenAI fallback also failed:', openaiError);
             
             // Final fallback to static responses
             const lowerInput = userInput.toLowerCase();
             let fallbackResponse = '';
             
             if (lowerInput.includes('google')) {
               fallbackResponse = 'I can help with that! Try: "open google" or "search for something"';
             } else if (lowerInput.includes('search')) {
               fallbackResponse = 'Try: "search for [your query]" and I\'ll open Google search for you.';
             } else if (lowerInput.includes('tab')) {
               fallbackResponse = 'I can help with tabs! Try: "new tab" or "close tab"';
             } else {
               fallbackResponse = 'I help with browser commands like "open google", "new tab", or "go back". For chatting, use Ask mode.';
             }
             
             event.reply('gemini-macos-response', {
               type: 'conversation',
               content: fallbackResponse
             });
           }
         } else {
           // No OpenAI available, use static fallback
           const lowerInput = userInput.toLowerCase();
           let fallbackResponse = '';
           
           if (lowerInput.includes('google')) {
             fallbackResponse = 'I can help with that! Try: "open google" or "search for something"';
           } else if (lowerInput.includes('search')) {
             fallbackResponse = 'Try: "search for [your query]" and I\'ll open Google search for you.';
           } else if (lowerInput.includes('tab')) {
             fallbackResponse = 'I can help with tabs! Try: "new tab" or "close tab"';
           } else {
             fallbackResponse = 'I help with browser commands like "open google", "new tab", or "go back". For chatting, use Ask mode.';
           }
           
           event.reply('gemini-macos-response', {
             type: 'conversation',
             content: fallbackResponse
           });
         }
       }
      
    } catch (error) {
      console.error('[MainHandlers] Gemini macOS command failed:', error);
      event.reply('gemini-macos-response', {
        type: 'conversation', 
        content: "Sorry, I'm having trouble processing your request right now. Please try again."
      });
    }
  });

  // AppleScript command handler (for when Chrome isn't active)
  ipcMain.on("applescript-command", async (event, command: string) => {
    try {
      console.log('[MainHandlers] AppleScript command received:', command);
      
      // Parse the command and execute appropriate AppleScript
      let response = '';
      
      if (command.toLowerCase().includes('open') && command.toLowerCase().includes('google')) {
        // Open Google
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "l" using command down'`);
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "google.com"'`);
        await execPromise(`osascript -e 'tell application "System Events" to key code 36'`); // Enter key
        response = 'Opening Google.com';
      } else if (command.toLowerCase().includes('search')) {
        // Extract search query
        const searchMatch = command.match(/search(?:\s+for)?\s+(.+)/i);
        if (searchMatch) {
          const query = searchMatch[1];
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "l" using command down'`);
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "https://google.com/search?q=${encodeURIComponent(query)}"'`);
          await execPromise(`osascript -e 'tell application "System Events" to key code 36'`); // Enter key
          response = `Searching for: ${query}`;
        } else {
          response = 'Please specify what to search for';
        }
      } else if (command.toLowerCase().includes('new tab')) {
        // Open new tab
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "t" using command down'`);
        response = 'Opened new tab';
      } else if (command.toLowerCase().includes('close tab')) {
        // Close current tab
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "w" using command down'`);
        response = 'Closed current tab';
      } else if (command.toLowerCase().includes('back')) {
        // Go back
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "[" using command down'`);
        response = 'Navigated back';
      } else if (command.toLowerCase().includes('forward')) {
        // Go forward
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "]" using command down'`);
        response = 'Navigated forward';
      } else if (command.toLowerCase().includes('refresh') || command.toLowerCase().includes('reload')) {
        // Refresh page
        await execPromise(`osascript -e 'tell application "System Events" to keystroke "r" using command down'`);
        response = 'Page refreshed';
      } else if (command.toLowerCase().includes('scroll')) {
        // Scroll actions
        if (command.toLowerCase().includes('down')) {
          await execPromise(`osascript -e 'tell application "System Events" to key code 125'`); // Down arrow
          response = 'Scrolled down';
        } else if (command.toLowerCase().includes('up')) {
          await execPromise(`osascript -e 'tell application "System Events" to key code 126'`); // Up arrow
          response = 'Scrolled up';
        } else {
          response = 'Please specify scroll direction (up/down)';
        }
      } else {
        // Default response for unrecognized commands
        response = `I can help you with browser navigation using system commands. Try:
- "Open Google"
- "Search for [query]"
- "New tab"
- "Close tab"
- "Go back/forward"
- "Refresh page"
- "Scroll up/down"`;
      }
      
      event.reply("applescript-response", response);
    } catch (error) {
      console.error('[MainHandlers] Error executing AppleScript command:', error);
      event.reply("applescript-response", `Error: ${error}`);
    }
  });

  // Handle sidebar state changes
  ipcMain.on("sidebar-state-changed", async (_event, data: { isOpen: boolean, width: number }) => {
    try {
      console.log('[MainHandlers] Sidebar state changed:', data);
      // Browser resizing temporarily disabled to prevent crashes
      // TODO: Re-enable with proper error handling and throttling
    } catch (error) {
      console.error('[MainHandlers] Error handling sidebar state change:', error);
    }
  });

     // Enhanced browser automation function
  // Commented out - not currently used
  /*
  async function executeComplexBrowserCommand(command: string, activeBrowser: any): Promise<{success: boolean, message: string}> {
    const lowerCommand = command.toLowerCase();
    
    try {
      // Complex multi-step automation like BrowserOS
      
      // Flight booking automation with smart parsing and real browser automation
      if (lowerCommand.includes('book') && (lowerCommand.includes('flight') || lowerCommand.includes('plane') || lowerCommand.includes('trip'))) {
        console.log('[BrowserOS Agent] Starting flight booking automation');
        
        // Extract details from the command
        const destinationMatch = command.match(/to\s+([A-Za-z\s]+?)(?:\s+from|\s+on|\s+for|$)/i);
        const originMatch = command.match(/from\s+([A-Za-z\s]+?)(?:\s+to|\s+on|\s+for|$)/i);
        const dateMatch = command.match(/(tomorrow|next\s+\w+|today|\d{1,2}\/\d{1,2})/i);
        
        console.log('[BrowserOS Agent] Extracted details:', {
          origin: originMatch?.[1],
          destination: destinationMatch?.[1], 
          date: dateMatch?.[1]
        });
        
        let url = "https://www.google.com/travel/flights";
        if (destinationMatch) {
          const destination = destinationMatch[1].trim();
          url += `?q=flights+to+${encodeURIComponent(destination)}`;
        }
        
        console.log('[BrowserOS Agent] Opening Google Flights:', url);
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "${url}"'`);
        
        // Real browser automation - wait for page load then interact with elements
        setTimeout(async () => {
          try {
            console.log('[BrowserOS Agent] Starting flight booking automation...');
            
            // Simulate clicking and typing using AppleScript (basic automation)
            if (originMatch) {
              console.log(`[BrowserOS Agent] Setting departure: ${originMatch[1]}`);
              // Focus on departure input and type
              await execPromise(`osascript -e '
                tell application "System Events"
                  tell process "${activeBrowser.name}"
                    click (text field 1 of group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of tab group 1 of splitter group 1 of window 1)
                    delay 0.5
                    set the clipboard to "${originMatch[1]}"
                    keystroke "v" using command down
                    delay 1
                    key code 36
                  end tell
                end tell'`);
            }
            
            if (destinationMatch) {
              console.log(`[BrowserOS Agent] Setting destination: ${destinationMatch[1]}`);
              // Focus on destination input and type
              await execPromise(`osascript -e '
                tell application "System Events"
                  tell process "${activeBrowser.name}"
                    click (text field 2 of group 1 of UI element 1 of scroll area 1 of group 1 of group 1 of tab group 1 of splitter group 1 of window 1)
                    delay 0.5
                    set the clipboard to "${destinationMatch[1]}"
                    keystroke "v" using command down
                    delay 1
                    key code 36
                  end tell
                end tell'`);
            }
            
            if (dateMatch) {
              console.log(`[BrowserOS Agent] Setting date: ${dateMatch[1]}`);
              // This would interact with date picker
            }
            
            console.log('[BrowserOS Agent] Flight booking form populated');
          } catch (automationError) {
            console.error('[BrowserOS Agent] Automation error:', automationError);
            console.log('[BrowserOS Agent] Falling back to manual interaction');
          }
        }, 3000); // Wait 3 seconds for page to load
        
        return { success: true, message: `Opening Google Flights and automating booking${destinationMatch ? ` to ${destinationMatch[1]}` : ''}...` };
      }
      
      // Hotel booking automation
      if (lowerCommand.includes('book') && (lowerCommand.includes('hotel') || lowerCommand.includes('room') || lowerCommand.includes('stay'))) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.booking.com"'`);
        return { success: true, message: 'Opening Booking.com for hotel reservations...' };
      }
      
      // Restaurant booking automation
      if (lowerCommand.includes('book') && (lowerCommand.includes('restaurant') || lowerCommand.includes('table') || lowerCommand.includes('dinner'))) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.opentable.com"'`);
        return { success: true, message: 'Opening OpenTable for restaurant reservations...' };
      }
      
      // Shopping automation - BrowserOS-style with history awareness
      if (lowerCommand.includes('buy') || lowerCommand.includes('shop') || lowerCommand.includes('order')) {
        const shoppingQuery = command.replace(/buy|shop|order/gi, '').trim();
        
        // Check for specific requests like "from my order history"
        if (lowerCommand.includes('history') || lowerCommand.includes('again') || lowerCommand.includes('reorder')) {
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.amazon.com/gp/your-account/order-history"'`);
          
          // Simulate agent searching in order history
          setTimeout(async () => {
            console.log('[BrowserOS Agent] Searching order history for:', shoppingQuery);
            // In a real BrowserOS implementation, this would use page automation
          }, 2000);
          
          return { success: true, message: `Searching your order history for: ${shoppingQuery}` };
        } else {
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.amazon.com/s?k=${encodeURIComponent(shoppingQuery)}"'`);
          return { success: true, message: `Searching Amazon for: ${shoppingQuery}` };
        }
      }
      
      // Email automation
      if (lowerCommand.includes('email') || lowerCommand.includes('send') || lowerCommand.includes('compose')) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://mail.google.com/mail/u/0/#compose"'`);
        return { success: true, message: 'Opening Gmail compose...' };
      }
      
      // Social media automation
      if (lowerCommand.includes('post') || lowerCommand.includes('tweet') || lowerCommand.includes('share')) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://twitter.com/compose/tweet"'`);
        return { success: true, message: 'Opening Twitter compose...' };
      }
      
      // YouTube automation
      if (lowerCommand.includes('watch') || lowerCommand.includes('video') || lowerCommand.includes('youtube')) {
        const videoQuery = command.replace(/watch|video|youtube/gi, '').trim();
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.youtube.com/results?search_query=${encodeURIComponent(videoQuery)}"'`);
        return { success: true, message: `Searching YouTube for: ${videoQuery}` };
      }
      
      // Calendar/schedule automation
      if (lowerCommand.includes('schedule') || lowerCommand.includes('calendar') || lowerCommand.includes('meeting')) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://calendar.google.com"'`);
        return { success: true, message: 'Opening Google Calendar...' };
      }
      
      // Document automation
      if (lowerCommand.includes('document') || lowerCommand.includes('write') || lowerCommand.includes('doc')) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://docs.google.com/document/create"'`);
        return { success: true, message: 'Creating new Google Doc...' };
      }
      
      // Weather automation
      if (lowerCommand.includes('weather') || lowerCommand.includes('forecast')) {
        const location = command.replace(/weather|forecast/gi, '').trim() || 'current location';
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://www.google.com/search?q=weather+${encodeURIComponent(location)}"'`);
        return { success: true, message: `Getting weather for: ${location}` };
      }
      
      // News automation
      if (lowerCommand.includes('news') || lowerCommand.includes('headlines')) {
        await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "https://news.google.com"'`);
        return { success: true, message: 'Opening Google News...' };
      }
      
      // Advanced BrowserOS-style multi-step tasks
      
      // Fill forms automation
      if (lowerCommand.includes('fill') && (lowerCommand.includes('form') || lowerCommand.includes('application'))) {
        console.log('[BrowserOS Agent] Form filling request detected');
        return { success: true, message: 'Ready to help fill forms. Click on the form field you want to start with.' };
      }
      
      // Research automation - open multiple tabs
      if (lowerCommand.includes('research') || lowerCommand.includes('compare')) {
        const topic = command.replace(/research|compare/gi, '').trim();
        
        // Open multiple research sources
        const sources = [
          `https://www.google.com/search?q=${encodeURIComponent(topic)}`,
          `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`,
          `https://scholar.google.com/scholar?q=${encodeURIComponent(topic)}`
        ];
        
        for (const source of sources) {
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "${source}"'`);
          await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between tabs
        }
        
        return { success: true, message: `Opening research tabs for: ${topic}` };
      }
      
      // Tab management automation
      if (lowerCommand.includes('close') && lowerCommand.includes('tab')) {
        if (lowerCommand.includes('all')) {
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to close every window'`);
          return { success: true, message: 'Closed all tabs' };
        } else {
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to close current tab of window 1'`);
          return { success: true, message: 'Closed current tab' };
        }
      }
      
      // Download automation
      if (lowerCommand.includes('download') || lowerCommand.includes('save')) {
        const item = command.replace(/download|save/gi, '').trim();
        console.log('[BrowserOS Agent] Download request for:', item);
        // In BrowserOS, this would trigger download detection
        return { success: true, message: `Ready to download: ${item}. Click on the download link when you find it.` };
      }
      
      // Login automation
      if (lowerCommand.includes('login') || lowerCommand.includes('sign in')) {
        const service = command.match(/(google|github|facebook|twitter|linkedin|amazon)/i)?.[1] || 'website';
        console.log('[BrowserOS Agent] Login assistance for:', service);
        return { success: true, message: `Ready to help you login to ${service}. Navigate to the login page.` };
      }
      
      // Extract/scrape data
      if (lowerCommand.includes('extract') || lowerCommand.includes('scrape') || lowerCommand.includes('copy all')) {
        console.log('[BrowserOS Agent] Data extraction request');
        // In BrowserOS, this would trigger content extraction
        return { success: true, message: 'Ready to extract data. Highlight the content you want to extract.' };
      }
      
      // Summarize page content
      if (lowerCommand.includes('summarize') || lowerCommand.includes('tldr')) {
        console.log('[BrowserOS Agent] Page summarization request');
        
        // Get page content using AppleScript and analyze it
        setTimeout(async () => {
          try {
            // Get page text content
            const pageContentScript = `
              tell application "${activeBrowser.name}"
                tell active tab of window 1
                  execute javascript "document.body.innerText"
                end tell
              end tell
            `;
            
            const { stdout: pageText } = await execPromise(`osascript -e '${pageContentScript}'`);
            
            // In a real implementation, this would be sent to AI for summarization
            console.log('[BrowserOS Agent] Page content extracted for summarization');
            console.log('[BrowserOS Agent] Content length:', pageText.length);
            
            // Send page content to AI (placeholder - would use OpenAI API)
            // const summary = await generateSummary(pageText);
            
          } catch (error) {
            console.error('[BrowserOS Agent] Failed to extract page content:', error);
          }
        }, 1000);
        
        return { success: true, message: 'Analyzing page content for summary...' };
      }
      
      // General task automation - catch-all for complex tasks
      if (lowerCommand.includes('help me') || lowerCommand.includes('automate') || 
          lowerCommand.includes('do this') || lowerCommand.includes('complete this')) {
        console.log('[BrowserOS Agent] General automation request');
        
        // Real browser automation using AppleScript to interact with current page
        setTimeout(async () => {
          try {
                      console.log('[BrowserOS Agent] Starting general page automation...');
          
          // Example: Take screenshot and analyze what's on screen
          // Removed unused screenshotScript variable
          
          console.log('[BrowserOS Agent] Analyzing current page for automation opportunities...');
            
            // In a real BrowserOS implementation, this would:
            // 1. Take screenshot of current page
            // 2. Use AI vision to understand what's on screen
            // 3. Plan and execute actions (clicking, typing, scrolling)
            // 4. Provide feedback on progress
            
          } catch (error) {
            console.error('[BrowserOS Agent] General automation error:', error);
          }
        }, 1000);
        
        return { success: true, message: 'Analyzing current page and planning automation...' };
      }
      
          return { success: false, message: 'Unknown command' };
    
  } catch (error) {
    console.error('[BrowserAutomation] Error executing complex command:', error);
    return { success: false, message: `Error: ${error}` };
  }
}
*/

  ipcMain.on("browser-command", async (_event, command: string) => {
    try {
      console.log('[MainHandlers] Received browser command:', command);
      
      // Send immediate feedback to UI
      mainWindow?.webContents.send('browser-command-result', {
        success: true,
        message: 'Processing command...'
      });
      
      // First, check if user is asking to open a specific browser
      const commandLower = command.toLowerCase();
      const browserMap = {
        'chrome': 'Google Chrome',
        'google chrome': 'Google Chrome', 
        'safari': 'Safari',
        'firefox': 'Firefox',
        'edge': 'Microsoft Edge',
        'microsoft edge': 'Microsoft Edge',
        'brave': 'Brave Browser',
        'brave browser': 'Brave Browser',
        'arc': 'Arc'
      };
      
      let requestedBrowser = null;
      if (commandLower.includes('open ')) {
        for (const [key, fullName] of Object.entries(browserMap)) {
          if (commandLower.includes(`open ${key}`)) {
            requestedBrowser = fullName;
            break;
          }
        }
      }
      
      // Get active browser
      let activeBrowser = await browserDetection.getActiveBrowser();
      
      // If user requested a specific browser, try to open it
      if (requestedBrowser) {
        try {
          // First, activate the requested browser
          await execPromise(`osascript -e 'tell application "${requestedBrowser}" to activate'`);
          
          // Then, try to create a new window if needed (simple approach)
          try {
            await execPromise(`osascript -e 'tell application "${requestedBrowser}" to make new window'`);
          } catch (windowError) {
            // If window creation fails, the browser is still activated - that's fine
            console.log(`[MainHandlers] New window creation not needed/failed for ${requestedBrowser}, browser is activated`);
          }
          console.log(`[MainHandlers] Successfully activated and brought ${requestedBrowser} to foreground`);
          
          // Wait for browser to fully open and become active
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Update active browser
          activeBrowser = await browserDetection.getActiveBrowser();
          
          mainWindow?.webContents.send('browser-command-result', {
            success: true,
            message: `Opened ${requestedBrowser}, executing command...`
          });
          // Continue to execute the original command instead of returning
        } catch (error) {
          mainWindow?.webContents.send('browser-command-result', {
            success: false,
            message: `Could not open ${requestedBrowser}. Please make sure it's installed.`
          });
          return;
        }
      }
      
      // If no specific browser requested and no browser is active, open default
      if (!activeBrowser) {
        console.log('[MainHandlers] No browser detected, opening default browser...');
        
        // Try to open browsers in order of preference (Chrome first as default)
        const browsersToTry = [
          'Google Chrome',  // DEFAULT: Always try Chrome first unless user specifies otherwise
          'Safari', 
          'Firefox',
          'Microsoft Edge',
          'Brave Browser',
          'Arc'
        ];
        
        let browserOpened = false;
        for (const browserName of browsersToTry) {
          try {
            // First, activate the browser
            await execPromise(`osascript -e 'tell application "${browserName}" to activate'`);
            
            // Then, try to create a new window if needed (simple approach)
            try {
              await execPromise(`osascript -e 'tell application "${browserName}" to make new window'`);
            } catch (windowError) {
              // If window creation fails, the browser is still activated - that's fine
              console.log(`[MainHandlers] New window creation not needed/failed for ${browserName}, browser is activated`);
            }
            console.log(`[MainHandlers] Successfully activated and brought ${browserName} to foreground`);
            browserOpened = true;
            
            // Wait for browser to fully open and become active
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if browser is now active
            activeBrowser = await browserDetection.getActiveBrowser();
            if (activeBrowser) {
              mainWindow?.webContents.send('browser-command-result', {
                success: true,
                message: `Opened ${browserName}, executing command...`
              });
              break;
            }
          } catch (error) {
            console.log(`[MainHandlers] ${browserName} not available, trying next...`);
            continue;
          }
        }
        
        if (!browserOpened || !activeBrowser) {
          mainWindow?.webContents.send('browser-command-result', {
            success: false,
            message: 'Could not open any browser. Please install Chrome, Safari, or another supported browser.'
          });
          return;
        }
      }
      
      // Use simple browser commands
      console.log('[MainHandlers] Processing browser command');
      
             // Fallback: Parse and execute simple browser commands
       const lowerCommand = command.toLowerCase();
       let result = { success: false, message: 'Unknown command' };
       
       // Execute simple commands as fallback
       {
        if (lowerCommand.includes('search for') || lowerCommand.includes('google')) {
          // Extract search query
          const searchQuery = command.replace(/search for|google/gi, '').trim();
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
          
          // Open search in browser
          await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "${searchUrl}"'`);
          result = { success: true, message: `Searching for: ${searchQuery}` };
          
        } else if (lowerCommand.includes('new tab')) {
          await browserDetection.executeInBrowser(activeBrowser.name, 'new-tab');
          result = { success: true, message: 'Opened new tab' };
          
        } else if (lowerCommand.includes('refresh') || lowerCommand.includes('reload')) {
          await browserDetection.executeInBrowser(activeBrowser.name, 'refresh');
          result = { success: true, message: 'Page refreshed' };
          
        } else if (lowerCommand.includes('back')) {
          await browserDetection.executeInBrowser(activeBrowser.name, 'back');
          result = { success: true, message: 'Navigated back' };
          
        } else if (lowerCommand.includes('forward')) {
          await browserDetection.executeInBrowser(activeBrowser.name, 'forward');
          result = { success: true, message: 'Navigated forward' };
          
        } else if (lowerCommand.includes('go to') || lowerCommand.includes('open')) {
          // Extract URL (only for non-browser apps since browsers are handled above)
          const urlMatch = command.match(/(?:go to|open)\s+(.+)/i);
          if (urlMatch) {
            let url = urlMatch[1].trim();
            // Add https:// if not present
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
              url = 'https://' + url;
            }
            await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "${url}"'`);
            result = { success: true, message: `Navigating to: ${url}` };
          }
          
        } else if (lowerCommand.includes('click')) {
          // Extract what to click and attempt real clicking automation
          const clickTarget = command.replace(/click/gi, '').trim();
          console.log(`[MainHandlers] Attempting to click: ${clickTarget}`);
          
          // Real click automation using AppleScript
          setTimeout(async () => {
            try {
              console.log(`[BrowserOS Agent] Searching for clickable element: ${clickTarget}`);
              
              // Attempt to find and click elements by various methods
              const clickScript = `
                tell application "System Events"
                  tell process "${activeBrowser.name}"
                    try
                      -- Try to find button with text
                      click (button whose title contains "${clickTarget}" or description contains "${clickTarget}")
                    on error
                      try
                        -- Try to find link with text  
                        click (UI element whose title contains "${clickTarget}" or description contains "${clickTarget}")
                      on error
                        -- Try to find any UI element with the text
                        click (first UI element whose value contains "${clickTarget}")
                      end try
                    end try
                  end tell
                end tell
              `;
              
              await execPromise(`osascript -e '${clickScript}'`);
              console.log(`[BrowserOS Agent] Successfully clicked: ${clickTarget}`);
              
            } catch (error) {
              console.error(`[BrowserOS Agent] Failed to click ${clickTarget}:`, error);
              console.log('[BrowserOS Agent] You may need to click manually or be more specific');
            }
          }, 1000);
          
          result = { success: true, message: `Searching for and clicking: ${clickTarget}` };
          
        } else if (lowerCommand.includes('type') || lowerCommand.includes('enter') || lowerCommand.includes('fill')) {
          // Extract what to type
          const typeMatch = command.match(/(?:type|enter|fill)\s+(.+)/i);
          if (typeMatch) {
            const textToType = typeMatch[1].trim();
            console.log(`[MainHandlers] Typing: ${textToType}`);
            
            // Real typing automation
            setTimeout(async () => {
              try {
                const typeScript = `
                  tell application "System Events"
                    tell process "${activeBrowser.name}"
                      keystroke "${textToType}"
                    end tell
                  end tell
                `;
                
                await execPromise(`osascript -e '${typeScript}'`);
                console.log(`[BrowserOS Agent] Typed: ${textToType}`);
                
              } catch (error) {
                console.error('[BrowserOS Agent] Failed to type:', error);
              }
            }, 500);
            
            result = { success: true, message: `Typing: ${textToType}` };
          } else {
            result = { success: false, message: 'Please specify what to type' };
          }
          
        } else {
          // Try to interpret as a direct URL
          if (command.includes('.')) {
            let url = command.trim();
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
              url = 'https://' + url;
            }
            await execPromise(`osascript -e 'tell application "${activeBrowser.name}" to open location "${url}"'`);
            result = { success: true, message: `Navigating to: ${url}` };
          }
        }
      }
      
      mainWindow?.webContents.send('browser-command-result', result);
      
    } catch (error) {
      console.error('[MainHandlers] Error executing browser command:', error);
      mainWindow?.webContents.send('browser-command-result', {
        success: false,
        message: 'Failed to execute command: ' + error
      });
    }
  });

  // NEW: Screen Highlighting handlers
  ipcMain.on("start-screen-highlight", async (_event) => {
    try {
      console.log('[MainHandlers] Starting screen highlight mode');
      const highlightService = getScreenHighlightService();
      if (highlightService) {
        await highlightService.startScreenHighlight();
      } else {
        console.error('[MainHandlers] Screen highlight service not initialized');
      }
    } catch (error) {
      console.error('[MainHandlers] Error starting screen highlight:', error);
    }
  });

  ipcMain.on("cancel-screen-highlight", async (_event) => {
    try {
      console.log('[MainHandlers] Canceling screen highlight');
      const highlightService = getScreenHighlightService();
      if (highlightService) {
        highlightService.cleanup();
      }
      // Forward cancel event to renderer
      mainWindow?.webContents.send("screen-highlight-cancelled");
    } catch (error) {
      console.error('[MainHandlers] Error canceling screen highlight:', error);
    }
  });
  
  // Forward cancel event from highlight window to main window
  ipcMain.on("screen-highlight-cancelled", (_event) => {
    console.log('[MainHandlers] Forwarding screen-highlight-cancelled to renderer');
    mainWindow?.webContents.send("screen-highlight-cancelled");
  });

  ipcMain.on("capture-screen-area-for-prompt", async (_event, selection: { x: number, y: number, width: number, height: number }) => {
    try {
      console.log('[MainHandlers] Capturing screen area for prompt:', selection);
      
      // Validate selection dimensions
      if (selection.width < 10 || selection.height < 10) {
        console.error('[MainHandlers] Selection too small:', selection);
        return;
      }
      
      // Get display info for debugging
      const primaryDisplay = screen.getPrimaryDisplay();
      const { scaleFactor, bounds } = primaryDisplay;
      
      console.log('[MainHandlers] Display info - Scale factor:', scaleFactor, 'Bounds:', bounds);
      console.log('[MainHandlers] Original selection:', selection);
      
      // Add Y offset to compensate for menubar/titlebar
      const menuBarOffset = 37; // macOS menubar height + window chrome
      const adjustedSelection = {
        x: selection.x,
        y: selection.y + menuBarOffset,
        width: selection.width,
        height: selection.height
      };
      console.log('[MainHandlers] Adjusted coordinates with menubar offset:', adjustedSelection);
      
      // Use macOS screencapture to capture just the selected area
      const tempDir = path.join(app.getPath('temp'), 'opus-highlights');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const capturePath = path.join(tempDir, `capture-${timestamp}.png`);
      
      // Use screencapture with -R flag for rectangle selection
      // Add -x flag to disable shadows and other effects for more accurate capture
      const captureCommand = `screencapture -x -R${adjustedSelection.x},${adjustedSelection.y},${adjustedSelection.width},${adjustedSelection.height} "${capturePath}"`;
      console.log('[MainHandlers] Running command:', captureCommand);
      await execPromise(captureCommand);
      
      if (fs.existsSync(capturePath)) {
        // Convert to base64
        const imageBuffer = fs.readFileSync(capturePath);
        const base64Image = imageBuffer.toString('base64');
        
        // Clean up temp file
        fs.unlinkSync(capturePath);
        
        // Send the captured image back to renderer for prompt input
        if (mainWindow) {
          mainWindow.webContents.send("screen-captured-for-prompt", {
            imageBase64: base64Image
          });
        }
        
        console.log('[MainHandlers] Screen area captured, ready for prompt');
      } else {
        console.error('[MainHandlers] Failed to capture screen area');
      }
      
    } catch (error) {
      console.error('[MainHandlers] Error capturing screen area:', error);
    }
  });

  // NEW: Resume upload handler
  ipcMain.on("resume-uploaded", (_event, data: { fileName: string, content: string }) => {
    console.log('[MainHandlers] Resume uploaded:', data.fileName);
    // Store resume context for use in live audio sessions
    console.log('[MainHandlers] Resume context stored for interview assistance');
  });

  // Perform a web search in the user's default browser for an action item
  ipcMain.on('perform-search', async (_evt, query: string) => {
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query || '')}`;
      // @ts-ignore
      const { shell } = await import('electron');
      shell.openExternal(url);
    } catch (err) {
      console.error('[MainHandlers] perform-search error:', err);
    }
  });

// Removed: collaborativeScreenshotInterval and isCollaborativeModeActive - no longer needed

// Monitoring functions removed - screenshots now taken on-demand only

  // Visual navigation and dock click functions removed - agent mode disabled

// runAgentInApp function removed - agent mode disabled

async function isAppFrontmost(appName: string): Promise<boolean> {
  try {
    const { stdout } = await execPromise(`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`);
    return stdout.trim() === appName;
  } catch {
    return false;
  }
}

async function isAppVisible(appName: string): Promise<boolean> {
  try {
    const bundleId = await getBundleId(appName);
    const { stdout } = await execPromise(`swift swift/windows.swift ${bundleId}`);
    const arr = JSON.parse(stdout || '[]') as Array<any>;
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

async function resolvePreferredBrowser(): Promise<string> {
  const candidates = ["Google Chrome", "Safari", "Arc", "Firefox", "Microsoft Edge", "Brave Browser"];
  for (const app of candidates) {
    try { await getBundleId(app); return app; } catch { continue; }
  }
  return "Safari";
}

function extractTopicFromPrompt(prompt: string): string {
  const m = prompt.match(/about\s+(.+?)(?:\.|$)/i);
  return (m ? m[1] : prompt).trim();
}

async function getActiveBrowserUrl(): Promise<string> {
  try {
    const { stdout } = await execPromise(`osascript -e 'tell application "Google Chrome" to return URL of active tab of front window'`);
    return stdout.trim();
  } catch {}
  try {
    const { stdout } = await execPromise(`osascript -e 'tell application "Safari" to return URL of front document'`);
    return stdout.trim();
  } catch {}
  return '';
}

async function browserUrlContains(substr: string): Promise<boolean> {
  try {
    const url = await getActiveBrowserUrl();
    return url.toLowerCase().includes(substr.toLowerCase());
  } catch { return false; }
}

function buildPlanForTask(prompt: string): PlanStep[] | null {
  // Simple planner for common task categories
  if (/\b(presentation|slides|slide deck|deck|ppt|keynote)\b/i.test(prompt)) {
    const browser = 'Google Chrome';
    const topic = extractTopicFromPrompt(prompt);
    return [
      { id: 1, title: 'Open browser', action: 'open_app', params: { appName: browser }, check: { type: 'app_frontmost', value: browser } },
      { id: 2, title: 'Navigate to Google Slides', action: 'navigate_url', params: { url: 'https://slides.google.com' }, check: { type: 'url_contains', value: 'slides.google.com' } },
      { id: 3, title: `Create presentation about "${topic}"`, action: 'agent', params: { appName: browser, prompt: `On Google Slides, create a new blank presentation titled "${topic}" and add initial slides.` } }
    ];
  }
  return null;
}

async function executePlan(
  plan: PlanStep[],
  event: any,
  _history: any[],
  _isAgentMode: boolean
) {
  // Virtual cursor functionality removed
  for (const step of plan) {
    console.log(`[Plan] Executing step ${step.id}: ${step.title}`);
    if (step.check?.type === 'app_frontmost') {
      if (await isAppFrontmost(step.check.value)) { console.log(`[Plan] Step ${step.id} skipped - already frontmost`); continue; }
    }
    if (step.check?.type === 'url_contains') {
      if (await browserUrlContains(step.check.value)) { console.log(`[Plan] Step ${step.id} skipped - URL already present`); continue; }
    }
    if (step.action === 'open_app') {
      let appName = (step.params?.appName as string) || 'Safari';
      if (appName === 'Google Chrome') { appName = await resolvePreferredBrowser(); }
      await performAction(`=OpenApp\n${appName}`, "com.apple.desktop", [], event);
      let ok = false; for (let i = 0; i < 6; i++) { if (await isAppFrontmost(appName) || await isAppVisible(appName)) { ok = true; break; } await new Promise(r => setTimeout(r, 300)); }
      console.log(`[Plan] Step ${step.id} ${ok ? 'completed' : 'pending'}`);
    } else if (step.action === 'navigate_url') {
      const url = step.params?.url as string;
      const browser = (await isAppFrontmost('Google Chrome')) ? 'Google Chrome' : (await isAppFrontmost('Safari') ? 'Safari' : await resolvePreferredBrowser());
      try { await performAction('=Key\n^cmd+l', browser, [], event); await performAction(`=Key\n${url} ^enter`, browser, [], event); } catch {}
      let ok = false; for (let i = 0; i < 8; i++) { if (await browserUrlContains(step.check?.value || '')) { ok = true; break; } await new Promise(r => setTimeout(r, 400)); }
      console.log(`[Plan] Step ${step.id} ${ok ? 'completed' : 'pending'}`);
    } else if (step.action === 'agent') {
      console.log(`[Plan] Step ${step.id} skipped - agent functionality disabled`);
    }
  }
  }

  // Handle pending agent task retrieval
  ipcMain.handle("get-pending-agent-task", async () => {
    return process.env.PENDING_AGENT_TASK || null;
  });

  // Handle pending agent task clearing
  ipcMain.on("clear-pending-agent-task", async () => {
    delete process.env.PENDING_AGENT_TASK;
  });
}