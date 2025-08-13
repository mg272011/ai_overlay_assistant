// @ts-ignore
import { app, BrowserWindow, ipcMain, Notification, screen } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAppName, getBundleId } from "./utils/getAppInfo";
import { getClickableElements } from "./utils/getClickableElements";
import { runActionAgentStreaming } from "./ai/runAgents";
import { takeAndSaveScreenshots } from "./utils/screenshots";
import { execPromise, logWithElapsed } from "./utils/utils";
import { performAction } from "./performAction";
import { getVirtualCursor } from "./performAction";
import runAppleScript from "./tools/appleScript";
import { AgentInputItem } from "@openai/agents";
import { Element } from "./types";
import { ConversationMonitor } from "./ai/conversationMonitor";
import { LiveAudioService } from "./services/LiveAudioService";
import { geminiVision } from "./services/GeminiVisionService";
import { initScreenHighlightService, getScreenHighlightService } from "./services/ScreenHighlightService";
import { ContextualActionsService } from "./services/ContextualActionsService";
// import { ListenService } from "./services/glass/ListenService"; // Replaced by JavaScript version

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
  let conversationMonitor: ConversationMonitor | null = null;
    let liveAudioService: LiveAudioService | null = null;
  // let glassListenService: ListenService | null = null; // Replaced by JavaScript version
  let glassJSListenService: any = null; // Glass JavaScript implementation for meeting/live
  let isGlassServiceInitializing = false; // Prevent concurrent initialization
  let contextualActionsSvc: ContextualActionsService | null = null;
  
 
   
  // Helper function to get or create conversation monitor
  const getConversationMonitor = () => {
    if (!conversationMonitor) {
      conversationMonitor = new ConversationMonitor();
      // Set up event forwarding only once when created
      conversationMonitor.on("suggestion", ({ text, context }: { text: string; context?: any }) => {
        win?.webContents.send("conversation-suggestion", { text, context });
      });
    }
    return conversationMonitor;
  };
  
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
        const samples = buffer.length / 2; // 16-bit = 2 bytes per sample
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
      // If ConversationMonitor exists, let it handle and emit
      if (conversationMonitor) {
        conversationMonitor.updateAudioTranscript(payload.text, payload.speaker);
        return;
      }
      // Fallback: use a lightweight service instance and emit directly
      if (!contextualActionsSvc) contextualActionsSvc = new ContextualActionsService();
      contextualActionsSvc.addConversationTurn(payload.speaker, payload.text);
      const results = await contextualActionsSvc.generateContextualActions(payload.text, payload.speaker);
      if (results.searchItems?.length) {
        win?.webContents.send('contextual-search', results.searchItems);
      }
      if (results.suggestions?.length) {
        win?.webContents.send('contextual-suggestions', results.suggestions);
      }
    } catch (err) {
      console.warn('[MainHandlers] generate-contextual-actions failed:', err);
    }
  });

  // NEW: Handle contextual actions from Glass meeting service (for ALL speakers)
  ipcMain.on('generate-contextual-actions-request', async (_evt, payload: { text: string; speaker: string }) => {
    try {
      console.log('[MainHandlers] ✅ Received generate-contextual-actions-request');
      console.log('[MainHandlers] Generating contextual actions for:', payload.speaker, '-', payload.text?.substring(0, 80));
      
      if (!contextualActionsSvc) {
        console.log('[MainHandlers] Creating new ContextualActionsService instance');
        contextualActionsSvc = new ContextualActionsService();
      }
      
      contextualActionsSvc.addConversationTurn(payload.speaker, payload.text);
      const results = await contextualActionsSvc.generateContextualActions(payload.text, payload.speaker);
      
      console.log('[MainHandlers] ✅ Generated results:', {
        searchItems: results.searchItems?.length || 0,
        suggestions: results.suggestions?.length || 0,
        items: results.searchItems?.map(item => item.text)
      });
      
      if (results.searchItems?.length) {
        console.log('[MainHandlers] Sending contextual-search event with', results.searchItems.length, 'items');
        win?.webContents.send('contextual-search', results.searchItems);
      }
      if (results.suggestions?.length) {
        console.log('[MainHandlers] Sending contextual-suggestions event with', results.suggestions.length, 'items');
        win?.webContents.send('contextual-suggestions', results.suggestions);
      }
    } catch (err) {
      console.error('[MainHandlers] ❌ generate-contextual-actions-request failed:', err);
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
    const monitor = getConversationMonitor();
    monitor.updateAudioTranscript(transcript, speaker);
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
  
  // Add handler for mode toggling
  ipcMain.on("toggle-collab-mode", async (_, isEnabled: boolean) => {
    try {
      const cursor = getVirtualCursor();
      
      if (isEnabled) {
        // Show the virtual cursor for agent mode
        console.log('[MainHandlers] Enabling collaborative mode - showing virtual cursor...');
        await cursor.show();
        console.log('[MainHandlers] ✅ Collaborative mode enabled - virtual cursor shown');
      } else {
        // Hide the virtual cursor when leaving agent mode
        console.log('[MainHandlers] Disabling collaborative mode - hiding virtual cursor...');
        cursor.hide();
        console.log('[MainHandlers] ✅ Collaborative mode disabled - virtual cursor hidden');
      }
    } catch (error) {
      console.error('[MainHandlers] ❌ Error toggling collab mode:', error);
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
        
        // Use GPT-5 to analyze the highlighted image with the user's prompt
        const streamGenerator = runActionAgentStreaming(
          "Desktop", 
          `You are analyzing a highlighted/selected portion of a user's screen. The user asks: "${userPrompt}"

Please analyze the highlighted content and provide a helpful response. Consider:
- What type of content this appears to be (code, text, UI, error message, documentation, etc.)
- Answer the user's specific question about this content
- Provide clear, actionable information
- If it's code, explain what it does
- If it's an error, suggest how to fix it
- If it's documentation, summarize the key points

Keep your response under 7 sentences maximum. Be conversational and helpful.`, 
          [], // No clickable elements needed
          [], // No history needed
          options.highlightedImage, // Pass the image
          timestampFolder,
          async (_toolName: string, _args: string) => {
            return "Analysis complete";
          },
          false // Not collaborative mode
        );
        
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
            event.sender.send("stream", { type: "tool_start", toolName: chunk.toolName });
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
    const isAgentMode = options?.mode === "agent";
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

        const analysisResult = await fastModel.generateContent(analysisPrompt);
        const analysisText = analysisResult.response.text();
        const needsScreenshot = analysisText.includes('SCREENSHOT_NEEDED: YES');
        console.log(`[MainHandlers] 💬 Chat fast path: Screenshot needed = ${needsScreenshot}`);

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
        const result = await chatSession.sendMessageStream(contentParts);
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
      } catch (error) {
        console.error('[MainHandlers] Chat fast path error:', error);
        event.sender.send("reply", { type: "error", message: "Chat temporarily unavailable. Please try again." });
      }
      return;
    }
    
    // Virtual cursor management is now handled entirely by toggle-collab-mode
    // to prevent conflicts and mouse blocking issues
    
    // SILENT PRE-ASSESSMENT for agent mode (collaborative mode)
    let preAssessment = null;
    // Heuristic: simple open-only prompt (no chained actions)
    const isOpenOnlyPrompt = /^(\s*)?(open|launch|start)\s+[^\s].*$/i.test(userPrompt) &&
      !/(\band\b|\bthen\b|\bto\b|\bfor\b|\bwith\b|\bgo to\b|\bmake\b|\bcreate\b|\bcompose\b|\bbook\b|\babout\b|\bon\b|\bin\b)/i.test(userPrompt);
    if (isAgentMode && !isOpenOnlyPrompt) {
      try {
        console.log(`[MainHandlers] 🔍 Running silent pre-assessment for: "${userPrompt}"`);
        // Take a quick screenshot for assessment
        const logFolder = createLogFolder('pre-assessment');
        const timestampFolder = path.join(logFolder, `${Date.now()}`);
        if (!fs.existsSync(timestampFolder)) {
          fs.mkdirSync(timestampFolder, { recursive: true });
        }
        const screenshotBase64 = await takeAndSaveScreenshots("Desktop", timestampFolder);
        if (screenshotBase64) {
          preAssessment = await geminiVision.silentScreenAssessment(screenshotBase64, userPrompt);
          console.log(`[MainHandlers] 🔍 Assessment complete:`, {
            currentApps: preAssessment.currentApps,
            needsNavigation: preAssessment.needsNavigation,
            targetApp: preAssessment.targetApp,
            context: preAssessment.context
          });
        }
      } catch (assessmentError) {
        console.warn(`[MainHandlers] Pre-assessment failed, continuing normally:`, assessmentError);
      }
    }
    
    const history: AgentInputItem[] = [];
    let appName: string = "";
    let isOpenCommand = false;
    
    try {
      // In chat mode, skip app detection entirely and go straight to conversational analysis
      if (isChatMode) {
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
            // Take screenshot for analysis
            const screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
            console.log('[MainHandlers] Screenshot captured, base64 length:', screenshotBase64?.length || 0);
            
            // Use the action agent to analyze the screen
            const streamGenerator = runActionAgentStreaming(
              "Desktop",
              userPrompt,
              [], // No clickable elements needed for analysis
              history,
              screenshotBase64,
              stepFolder,
              async (_toolName: string, _args: string) => {
                // For screen analysis, we don't need to execute tools
                return "Analysis complete";
              },
              isAgentMode
            );

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
            // Take screenshot for context
            const screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
            console.log('[MainHandlers] Screenshot captured for current app work, base64 length:', screenshotBase64?.length || 0);
            
            // Get clickable elements for the target app (requires bundle id)
            let clickableElements: Element[] = [];
            if (bundleIdForMainApp) {
              try {
                const result = await getClickableElements(bundleIdForMainApp, stepFolder);
                clickableElements = result.clickableElements;
                console.log(`[MainHandlers] Found ${clickableElements.length} clickable elements in ${mainApp}`);
              } catch (error) {
                console.warn(`[MainHandlers] Could not get clickable elements for ${mainApp}:`, error);
              }
            }
            
            // Use the action agent with full context
            const contextApp = mainApp;
            const streamGenerator = runActionAgentStreaming(
              contextApp,
              userPrompt,
              clickableElements,
              history,
              screenshotBase64,
              stepFolder,
              async (toolName: string, args: string) => {
                // Execute tool call with proper arguments
                const actionResult = await performAction(
                  `=${toolName}\n${args}`,
                  bundleIdForMainApp || contextApp,
                  clickableElements,
                  event,
                  isAgentMode
                );
                
                let resultText = "";
                if (Array.isArray(actionResult)) {
                  const firstResult = actionResult[0];
                  if (firstResult && "type" in firstResult && (firstResult as any).type === "unknown tool") {
                    resultText = "Error: unknown tool";
                  } else if (firstResult && "error" in (firstResult as any) && (firstResult as any).error) {
                    resultText = `Error: ${(firstResult as any).error}`;
                  } else {
                    resultText = "Action completed";
                  }
                } else if (actionResult && (actionResult as any).error) {
                  resultText = `Error: ${(actionResult as any).error}`;
                } else {
                  resultText = "Action completed";
                }
                
                return resultText;
              },
              isAgentMode
            );

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
          // Show virtual cursor for the session
          const cursor = getVirtualCursor();
          await cursor.create();
          await cursor.show();
          
                // Start visual navigation loop (uses Dock AX + Spotlight fallback)
      await performVisualNavigation(appName, cursor, event);
      // For a simple open-only prompt, stop here — do not run the action agent
      if (isOpenOnlyPrompt) {
        return;
      }
      // Otherwise, continue the original task with the agent inside the opened app
          try {
            await runAgentInApp(appName, userPrompt, history, event, isAgentMode);
          } catch (e) {
            console.warn('[MainHandlers] Post-open agent run failed:', e);
          }
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
      
      const streamGenerator = runActionAgentStreaming(
        contextApp,
        agentPrompt,
        clickableElements,
        history,
        screenshotBase64,
        stepFolder,
                      async (toolName: string, args: string) => {
          // Execute tool call
          const actionResult = await performAction(
            `=${toolName}\n${args}`,
            bundleId,
            clickableElements,
            event,
            isAgentMode
          );
          
          let resultText = "";
          if (Array.isArray(actionResult)) {
            // Handle array of results
            const firstResult = actionResult[0];
            if (firstResult && "type" in firstResult && firstResult.type === "unknown tool") {
              resultText = "Error: unknown tool. Is the tool name separated from the arguments with a new line?";
            } else if (firstResult && "error" in firstResult && firstResult.error) {
              resultText = `Error:\n${firstResult.error}`;
            } else if (firstResult && "stdout" in firstResult && firstResult.stdout) {
              resultText = `Success. Stdout:\n${firstResult.stdout}`;
            } else {
              resultText = "Success";
            }
          } else {
            // Handle single result
            if ("type" in actionResult && actionResult.type === "unknown tool") {
              resultText = "Error: unknown tool. Is the tool name separated from the arguments with a new line?";
            } else if ("error" in actionResult && actionResult.error) {
              resultText = `Error:\n${actionResult.error}`;
            } else if ("stdout" in actionResult && actionResult.stdout) {
              resultText = `Success. Stdout:\n${actionResult.stdout}`;
            } else {
              resultText = "Success";
            }
          }
          
          return resultText;
        },
        isAgentMode  // Only enable tools in agent mode, not in chat mode
      );

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
            event.sender.send("stream", {
              type: "tool_start",
              toolName: chunk.toolName
            });
            hasToolCall = true;
            break;
          case "tool_args":
            event.sender.send("stream", {
              type: "tool_args",
              content: chunk.content
            });
            break;
          case "tool_execute":
            event.sender.send("stream", {
              type: "tool_execute",
              toolName: chunk.toolName
            });
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

  // Visual navigation function for collaborative mode - NEW SPOTLIGHT-BASED APPROACH
async function performVisualNavigation(appName: string, cursor: ReturnType<typeof getVirtualCursor>, event: any) {
  console.log(`[VisualNav] Starting Spotlight-based navigation to open ${appName}`);

  // Early exit: if app already frontmost, treat as success
  if (await isAppFrontmost(appName)) {
    console.log(`[VisualNav] ${appName} already frontmost — goal achieved`);
    return;
  }

    // STREAMLINED SPOTLIGHT NAVIGATION WITH RAPID JSON RESPONSES
  try {
    console.log(`[VisualNav] 🚀 Using streamlined Spotlight approach for ${appName}`);
    
    // Step 1: Ensure cursor is visible
    await cursor.show();
    
    // Step 2: Open Spotlight with AppleScript
    console.log(`[VisualNav] Opening Spotlight with Cmd+Space...`);
    await runAppleScript(`tell application "System Events" to keystroke space using command down`);
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Step 3: Take quick screenshot and get JSON response for input bar coordinates
    console.log(`[VisualNav] 📸 Taking rapid screenshot to find Spotlight input bar...`);
    const { GeminiVisionService } = await import("./services/GeminiVisionService");
    const visionService = new GeminiVisionService();
    const timestampFolder = createLogFolder(`spotlight-${Date.now()}`);
    
    const screenshot = await takeAndSaveScreenshots("Desktop", timestampFolder);
    
    if (screenshot) {
              // Rapid JSON response for input bar coordinates - find the "S" in "Spotlight Search"
        const inputResult = await visionService.analyzeScreenForElement(
          screenshot,
          "Find the text 'Spotlight Search' in the macOS Spotlight overlay at the top center of the screen. Return coordinates for the letter 'S' at the very beginning of 'Spotlight Search' - this is where the input field starts and where typing begins."
        );
      
      if (inputResult.found && inputResult.x && inputResult.y) {
        console.log(`[VisualNav] 👁️ Vision found Spotlight input at (${inputResult.x}, ${inputResult.y})`);
        await cursor.moveCursor({ x: inputResult.x, y: inputResult.y });
        await new Promise(resolve => setTimeout(resolve, 200));
        await cursor.performClick({ x: inputResult.x, y: inputResult.y });
      } else {
        // Fallback to typical Spotlight position
        const display = screen.getPrimaryDisplay();
        const inputX = Math.floor(display.bounds.width / 2);
        const inputY = Math.floor(display.bounds.height * 0.15);
        console.log(`[VisualNav] Using fallback Spotlight input position at (${inputX}, ${inputY})`);
        await cursor.moveCursor({ x: inputX, y: inputY });
        await new Promise(resolve => setTimeout(resolve, 200));
        await cursor.performClick({ x: inputX, y: inputY });
      }
    }
    
    // Step 4: Type the app name
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(`[VisualNav] Typing "${appName}" into Spotlight...`);
    await runAppleScript(`tell application "System Events" to keystroke "${appName}"`);
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Step 5: Take rapid screenshot and get JSON response for app icon coordinates
    console.log(`[VisualNav] 📸 Taking rapid screenshot to find ${appName} icon...`);
    const screenshot2 = await takeAndSaveScreenshots("Desktop", timestampFolder);
    
    if (screenshot2) {
      const appResult = await visionService.analyzeScreenForElement(
        screenshot2,
        `Find the "${appName}" application in the Spotlight search results. Look for the app name "${appName}" with its icon in the search results list below the input field. Return coordinates to click on this specific app result.`
      );
      
      if (appResult.found && appResult.x && appResult.y) {
        console.log(`[VisualNav] 👁️ Vision found ${appName} at (${appResult.x}, ${appResult.y})`);
        await cursor.moveCursor({ x: appResult.x, y: appResult.y });
        await new Promise(resolve => setTimeout(resolve, 200));
        await cursor.performClick({ x: appResult.x, y: appResult.y });
      } else {
        // Fallback to first result
              const display = screen.getPrimaryDisplay();
        const resultX = Math.floor(display.bounds.width / 2);
        const resultY = Math.floor(display.bounds.height * 0.25);
        console.log(`[VisualNav] Using fallback first result position at (${resultX}, ${resultY})`);
        await cursor.moveCursor({ x: resultX, y: resultY });
            await new Promise(resolve => setTimeout(resolve, 200));
        await cursor.performClick({ x: resultX, y: resultY });
      }
    }
    
    // Step 6: Wait for app to launch
              await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Step 5: Verify the app opened successfully
    let opened = false;
    for (let i = 0; i < 6; i++) {
              if (await isAppFrontmost(appName) || await isAppVisible(appName)) {
        console.log(`[VisualNav] ✅ ${appName} opened successfully via Spotlight!`);
        opened = true;
                break;
              }
      console.log(`[VisualNav] Waiting for ${appName} to fully load... (${i + 1}/6)`);
      await new Promise(r => setTimeout(r, 500));
    }
    
    if (opened) {
      event.sender.send("reply", {
        type: "success",
        message: `${appName} opened successfully via Spotlight search!`,
      });
      return;
        } else {
      console.log(`[VisualNav] ⚠️ ${appName} may have opened but not detected as frontmost`);
      // Continue to fallback methods
    }
    
  } catch (error) {
    console.error(`[VisualNav] ❌ Spotlight approach failed:`, error);
    // Continue to fallback methods
  }

  // FALLBACK: Try dock method if Spotlight fails
  console.log(`[VisualNav] Trying fallback Dock approach for ${appName}...`);
  const directDockClicked = await clickDockItemIfAvailable(appName, cursor);
  if (directDockClicked) {
    // Verify app opened
        for (let i = 0; i < 5; i++) {
          if (await isAppFrontmost(appName) || await isAppVisible(appName)) {
        console.log(`[VisualNav] ${appName} opened via fallback Dock click!`);
        return;
          }
          await new Promise(r => setTimeout(r, 300));
        }
  }

  // Final fallback: Native app opening if both Spotlight and Dock fail
  console.log(`[VisualNav] All visual methods failed, trying native 'open' command...`);
  try {
    await runAppleScript(`tell application "${appName}" to activate`);
    
    // Wait and verify the app opened
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (let i = 0; i < 5; i++) {
      if (await isAppFrontmost(appName) || await isAppVisible(appName)) {
        console.log(`[VisualNav] ✅ ${appName} opened successfully via native fallback!`);
    event.sender.send("reply", {
      type: "success",
          message: `${appName} opened successfully!`,
        });
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`[VisualNav] ❌ Failed to open ${appName} with all methods`);
    event.sender.send("reply", {
      type: "error",
      message: `Could not open ${appName}. Please ensure the app is installed.`,
    });
    } catch (nativeErr) {
    console.error(`[VisualNav] Native fallback failed:`, nativeErr);
      event.sender.send("reply", {
        type: "error",
      message: `Could not open ${appName}. Please ensure the app is installed.`,
      });
  }

  console.log(`[VisualNav] 🎯 Spotlight-based navigation session ended`);
}

// Helper: Try to click Dock item via Accessibility (no hardcoded coords)
async function clickDockItemIfAvailable(appName: string, cursor: ReturnType<typeof getVirtualCursor>): Promise<boolean> {
  try {
    console.log(`[AX] Attempting to resolve Dock item for ${appName}`);
    const resolved = await geminiVision.getDockItemFrame(appName);
    console.log(`[AX] Resolved Dock item result:`, resolved);
    if (resolved.error === 'AccessibilityNotTrusted') {
      // Notify renderer to show a permission prompt
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('permission-warning', {
          type: 'accessibility',
          message: 'Enable Accessibility permissions for Opus to click the Dock reliably. Open System Settings → Privacy & Security → Accessibility, then add and enable Opus.'
        });
      }
    }
    if (resolved.found && typeof resolved.centerX === 'number' && typeof resolved.centerY === 'number') {
      const x = resolved.centerX!;
      const y = resolved.centerY!;
      console.log(`[VisualNav] [AX] Dock item resolved for ${appName} at (${x}, ${y}) — clicking`);
      await cursor.moveCursor({ x, y });
      await new Promise(r => setTimeout(r, 200));
      await cursor.performClick({ x, y });
      await new Promise(r => setTimeout(r, 300));
      // Only activate if not already frontmost to avoid minimize flicker
      if (!(await isAppFrontmost(appName))) {
        await runAppleScript(`tell application "${appName}" to activate`);
        await new Promise(r => setTimeout(r, 700));
      }
      return true;
    }
  } catch (e) {
    console.warn(`[VisualNav] [AX] Dock item resolve failed for ${appName}:`, e);
  }
  return false;
}

// Run the general action agent inside a target app
async function runAgentInApp(
  appName: string,
  userPrompt: string,
  history: AgentInputItem[],
  event: any,
  isAgentMode: boolean
): Promise<void> {
  let bundleIdForMainApp = "";
  try {
    bundleIdForMainApp = await getBundleId(appName);
    console.log(`[MainHandlers] 🔗 Resolved bundle id for ${appName}: ${bundleIdForMainApp}`);
  } catch (e) {
    console.warn(`[MainHandlers] ⚠️ Could not resolve bundle id for ${appName}:`, e);
  }

  const mainLogFolder = createLogFolder(userPrompt);
  const stepTimestamp = Date.now().toString();
  const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
  if (!fs.existsSync(stepFolder)) {
    fs.mkdirSync(stepFolder, { recursive: true });
  }

  try {
    const screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
    console.log('[MainHandlers] Screenshot captured for agent task, base64 length:', screenshotBase64?.length || 0);

    let clickableElements: Element[] = [];
    if (bundleIdForMainApp) {
      try {
        const result = await getClickableElements(bundleIdForMainApp, stepFolder);
        clickableElements = result.clickableElements;
        console.log(`[MainHandlers] Found ${clickableElements.length} clickable elements in ${appName}`);
      } catch (error) {
        console.warn(`[MainHandlers] Could not get clickable elements for ${appName}:`, error);
      }
    }

    const streamGenerator = runActionAgentStreaming(
      appName,
      userPrompt,
      clickableElements,
      history,
      screenshotBase64,
      stepFolder,
      async (toolName: string, args: string) => {
        const actionResult = await performAction(
          `=${toolName}\n${args}`,
          bundleIdForMainApp || appName,
          clickableElements,
          event,
          isAgentMode
        );
        let resultText = "";
        if (Array.isArray(actionResult)) {
          const first = actionResult[0] as any;
          if (first?.error) resultText = `Error: ${first.error}`; else resultText = "Action completed";
        } else if ((actionResult as any)?.error) {
          resultText = `Error: ${(actionResult as any).error}`;
        } else {
          resultText = "Action completed";
        }
        return resultText;
      },
      isAgentMode
    );

    console.log('[MainHandlers] Starting to stream agent task...');
    for await (const chunk of streamGenerator) {
      if (chunk.type === "text") {
        event.sender.send("stream", { type: "text", content: chunk.content });
      } else if ((chunk as any).type === "done") {
        event.sender.send("stream", { type: "stream_end", content: (chunk as any).content });
        return;
      }
    }
    console.log('[MainHandlers] Agent task stream complete');
  } catch (error) {
    console.error('[MainHandlers] Error during agent task in app:', error);
    event.sender.send("reply", {
      type: "error",
      message: "Failed to complete task: " + error
    });
  }
}

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
  history: AgentInputItem[],
  isAgentMode: boolean
) {
  const cursor = getVirtualCursor();
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
      await cursor.show();
      await performVisualNavigation(appName, cursor, event);
      let ok = false; for (let i = 0; i < 6; i++) { if (await isAppFrontmost(appName) || await isAppVisible(appName)) { ok = true; break; } await new Promise(r => setTimeout(r, 300)); }
      console.log(`[Plan] Step ${step.id} ${ok ? 'completed' : 'pending'}`);
    } else if (step.action === 'navigate_url') {
      const url = step.params?.url as string;
      const browser = (await isAppFrontmost('Google Chrome')) ? 'Google Chrome' : (await isAppFrontmost('Safari') ? 'Safari' : await resolvePreferredBrowser());
      try { await runAgentInApp(browser, `Focus the address bar then navigate to ${url}`, history, event, isAgentMode); } catch {}
      try { await performAction('=Key\n^cmd+l', browser, [], event, isAgentMode); await performAction(`=Key\n${url} ^enter`, browser, [], event, isAgentMode); } catch {}
      let ok = false; for (let i = 0; i < 8; i++) { if (await browserUrlContains(step.check?.value || '')) { ok = true; break; } await new Promise(r => setTimeout(r, 400)); }
      console.log(`[Plan] Step ${step.id} ${ok ? 'completed' : 'pending'}`);
    } else if (step.action === 'agent') {
      const appName = (step.params?.appName as string) || 'Desktop';
      const prompt = (step.params?.prompt as string) || '';
      try { await runAgentInApp(appName, prompt, history, event, isAgentMode); console.log(`[Plan] Step ${step.id} completed`); } catch (e) { console.log(`[Plan] Step ${step.id} error:`, e); }
    }
  }
}
}