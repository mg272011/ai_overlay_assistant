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
import { spawn } from "node:child_process";
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
          try { (win as any).moveTop(); } catch {}
          try { (win as any).setFullScreenable?.(false); } catch {}
          
          // Reinforce frameless UI
          win.setWindowButtonVisibility?.(false);
          
          // Inject CSS to remove any residual titlebar gaps and disable pointer-events by default
          const css = `
            html, body { background: transparent !important; }
            body { pointer-events: none; }
            .assistant-container, .content-area, .transcription-container, .insights-container,
            .contextual-actions-container, button, input, [role="button"], .glass-chat-input-area { pointer-events: auto !important; }
          `;
          meetingCssKey = await win.webContents.insertCSS(css);
        } catch {}
      }

      // Use Glass JavaScript implementation for meeting/live feedback
      const glassService = await getGlassListenService();
      
      if (!glassService) {
        throw new Error('Failed to initialize Glass service');
      }

      console.log('[MainHandlers] Starting Glass JavaScript ListenService...');
      await glassService.initializeSession('en');
      await glassService.startMacOSAudioCapture(); // Start system audio capture
      console.log('[MainHandlers] ✅ Glass JavaScript ListenService started successfully!');
      
      // Notify renderer that Glass is ready
      if (win && !win.isDestroyed()) {
        win.webContents.send("glass-ready");
        win.webContents.send("live-audio-ready"); // Keep compatibility
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[MainHandlers] ❌ Failed to start Glass JavaScript ListenService:', errorMessage);
      if (win && !win.isDestroyed()) {
        win.webContents.send("live-audio-error", errorMessage);
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
        // Reset window stacking and mouse behavior
                  try {
            win.setAlwaysOnTop(false);
            // Turn off visible on all workspaces but keep window available
            try { (win as any).setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: false }); } catch {}
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
        const base64Data = Buffer.from(chunk).toString('base64');
        await glassJSListenService.sendMicAudioContent(base64Data);
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
  ipcMain.on('start-meeting-chat', async (event, data: { chatId: string, action: any }) => {
    try {
      const chatId = data.chatId;
      const action = data.action || {};
      // Build a focused prompt using the latest analysis and recent transcript if available
      let recentContext = '';
      try {
        if (glassJSListenService) {
          const session = glassJSListenService.getCurrentSessionData?.();
          const turns = session?.conversationHistory || [];
          const lastTurns = turns.slice(-12).map((t: any) => `${t.speaker}: ${t.text}`).join('\n');
          recentContext = lastTurns;
        }
      } catch {}

      // Say-next action prompt vs generic action
      const sayNext = action?.type === 'say-next';
      const baseContext = `You are helping me respond in real time to what OTHERS are saying in a meeting. The conversation lines labeled 'Them' are the computer/system audio (other participants). Always answer in first-person as what I should say out loud next. Be direct; do not explain your reasoning.`;
      const userPrompt = sayNext
        ? `${baseContext}\n\nConversation so far:\n${recentContext}\n\nWrite exactly one short sentence I should say next. No preface, no quotes.`
        : `${baseContext}\n\nMy action request: ${action?.query || action?.text || 'Question'}\n\nConversation so far:\n${recentContext}\n\nReply concisely in first-person.`;

      const stream = runActionAgentStreaming(
        'Desktop',
        userPrompt,
        [],
        [],
        undefined,
        createLogFolder(`meeting-chat-${action?.text || action?.query || 'action'}`),
        async () => 'ok',
        false
      );

      (async () => {
        let streamed = '';
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            streamed += chunk.content;
            event.sender.send('meeting-chat-stream', { chatId, type: 'text', content: chunk.content });
          }
        }
        event.sender.send('meeting-chat-stream', { chatId, type: 'stream_end' });
      })();
    } catch (err) {
      console.error('[MainHandlers] start-meeting-chat error:', err);
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
    
    // AGENT MODE: delegate fully to Agent-S runner (no AppleScript, no visual-nav)
    if (isAgentMode) {
      try {
        const cursor = getVirtualCursor();
        await cursor.create();
        await cursor.show();
        await runAgentS(userPrompt, event);
        cursor.hide();
        return;
      } catch (assessmentError) {
        console.error('[MainHandlers] Agent-S failed:', assessmentError);
        try { getVirtualCursor().hide(); } catch {}
        event.sender.send('reply', { type: 'error', message: 'Agent mode failed to start' });
        return;
      }
    }

    // (Chat mode continues below)
    
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
        // Fallback to normal app detection
        appName = await getAppName(userPrompt) || "NONE";
      }
      
      // Check if no app is needed (conversational/screen analysis message)
      if (appName === "NONE") {
        // In chat mode, use the smart fast assessment instead of hardcoded keywords
        if (isChatMode) {
          // Skip all agent mode logic and go directly to chat mode handling below
          console.log('[MainHandlers] 💬 Chat mode with NONE app - skipping to fast assessment...');
          // Do nothing here - let it fall through to the chat mode logic below
        } else {
          // Agent mode: Perform generic screen analysis via runActionAgentStreaming as before
          const isScreenAnalysis = userPrompt.toLowerCase().includes("screen") || 
                                   userPrompt.toLowerCase().includes("see") ||
                                   userPrompt.toLowerCase().includes("what") ||
                                   userPrompt.toLowerCase().includes("describe") ||
                                   userPrompt.toLowerCase().includes("analyze") ||
                                   userPrompt.toLowerCase().includes("looking");
          if (isScreenAnalysis) {
            const mainLogFolder = createLogFolder(userPrompt);
            const stepTimestamp = Date.now().toString();
            const stepFolder = path.join(mainLogFolder, `${stepTimestamp}`);
            if (!fs.existsSync(stepFolder)) {
              fs.mkdirSync(stepFolder, { recursive: true });
            }
            try {
              const screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
              const streamGenerator = runActionAgentStreaming(
                "Desktop",
                userPrompt,
                [],
                history,
                screenshotBase64,
                stepFolder,
                async () => "Analysis complete",
                isAgentMode
              );
              for await (const chunk of streamGenerator) {
                if (chunk.type === "text") {
                  event.sender.send("stream", { type: "text", content: chunk.content });
                } else if (chunk.type === "done") {
                  event.sender.send("stream", { type: "stream_end" });
                  return;
                }
              }
              event.sender.send("reply", { type: "success", message: "Screen analysis complete" });
              event.sender.send("stream", { type: "stream_end" });
              return;
            } catch (error) {
              event.sender.send("reply", { type: "error", message: "Failed to analyze screen: " + error });
              return;
            }
          }
        }
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
      
      // In agent mode for "open" commands, route entirely through Agent-S runner (no AppleScript, no visual-nav)
      if (isAgentMode && isOpenCommand) {
        console.log(`[MainHandlers] Collaborative mode: Routing to Agent-S for: ${userPrompt}`);
        try {
          const cursor = getVirtualCursor();
          await cursor.create();
          await cursor.show();
          await runAgentS(userPrompt, event);
          cursor.hide();
          return;
        } catch (error) {
          console.error(`[MainHandlers] Agent-S error:`, error);
          try { getVirtualCursor().hide(); } catch {}
          event.sender.send("reply", { type: "error", message: `Agent-S failed: ${error}` });
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
  ipcMain.on('perform-search', (_evt, rawQuery: string) => {
    try {
      const query = (rawQuery || '').toString().trim();
      if (!query) return;
      const encoded = encodeURIComponent(query);
      const url = `https://www.google.com/search?q=${encoded}`;
      // @ts-ignore
      import('electron').then(({ shell }) => shell.openExternal(url));
    } catch (err) {
      console.error('[MainHandlers] Failed to perform search:', err);
    }
  });

// Removed: collaborativeScreenshotInterval and isCollaborativeModeActive - no longer needed

// Monitoring functions removed - screenshots now taken on-demand only

  // Visual navigation function for collaborative mode
async function performVisualNavigation(appName: string, cursor: ReturnType<typeof getVirtualCursor>, event: any) {
  let goalAchieved = false;
  const maxAttempts = 5;
  let attempt = 0;

  console.log(`[VisualNav] Starting visual navigation to open ${appName}`);

  while (attempt < maxAttempts && !goalAchieved) {
    attempt++;
    console.log(`[VisualNav] Attempt ${attempt}/${maxAttempts}`);

    // First, try to click the Dock item deterministically via Accessibility
    const axClicked = await clickDockItemIfAvailable(appName, cursor);
    if (axClicked) {
      console.log(`[VisualNav] [AX] ${appName} clicked via Dock successfully`);
      goalAchieved = true;
      break;
    }

    // Take current screenshot
    const logFolder = createLogFolder(`visual-nav-${appName}`);
    const stepFolder = path.join(logFolder, `step-${attempt}`);
    if (!fs.existsSync(stepFolder)) {
      fs.mkdirSync(stepFolder, { recursive: true });
    }
    
    try {
      const screenshotBase64 = await takeAndSaveScreenshots("Desktop", stepFolder);
      if (!screenshotBase64) {
        console.error(`[VisualNav] Failed to take screenshot`);
        break;
      }
      
      // Try Gemini first, fallback to GPT-4o if it fails
      console.log(`[VisualNav] Attempt ${attempt}: Taking single screenshot for ${appName} analysis`);
      
      let aiResponse = "";
      let analysisMethod = "";
      
      try {
        // Try Gemini 2.5 Flash first for speed
        console.log(`[VisualNav] Using Gemini 2.5 Flash for fast analysis`);
        aiResponse = await geminiVision.analyzeScreenForNavigation(screenshotBase64, appName, attempt);
        analysisMethod = "Gemini";
        
        // Validate the response format
        if (!aiResponse || !aiResponse.includes(":")) {
          throw new Error("Invalid Gemini response format");
        }
        
      } catch (geminiError) {
        console.warn(`[VisualNav] Gemini failed, falling back to GPT-4o:`, geminiError);
        analysisMethod = "GPT-4o (fallback)";
        
        // Fallback to GPT-4o with detailed prompt
        const navigationPrompt = `Here is my current screen. I want to open ${appName}.

ANALYZE the screen and tell me exactly where to click to achieve this goal.

If you can see the ${appName} icon in the dock (bottom of screen), respond with:
CLICK_DOCK: {x,y}

If you cannot see ${appName} in the dock, but can see other interface elements, respond with:
CLICK_SPOTLIGHT: {x,y} - to open Spotlight search
or
CLICK_LAUNCHPAD: {x,y} - to open Launchpad
or  
TYPE_SEARCH: {text} - if Spotlight is already open

If ${appName} is already open/visible, respond with:
GOAL_ACHIEVED

Provide ONLY the action and coordinates. Be precise.`;
        
        const streamGenerator = runActionAgentStreaming(
          "Desktop", navigationPrompt, [], [], screenshotBase64, stepFolder,
          async (_toolName: string, _args: string) => { return "Visual analysis complete"; }, false
        );
        
        for await (const chunk of streamGenerator) {
          if (chunk.type === "text") { aiResponse += chunk.content; }
        }
      }

      console.log(`[VisualNav] ${analysisMethod} response: ${aiResponse}`);

      // Parse AI response and execute action
      if (aiResponse.includes("GOAL_ACHIEVED")) {
        console.log(`[VisualNav] Goal achieved - ${appName} is open`);
        goalAchieved = true;
        
      } else if (aiResponse.includes("CLICK_DOCK:")) {
        // Ignore AI's dock coords and use Accessibility to resolve Dock item frame reliably
        const resolved = await geminiVision.getDockItemFrame(appName);
        if (resolved.found && typeof resolved.centerX === 'number' && typeof resolved.centerY === 'number') {
          const x = resolved.centerX!;
          const y = resolved.centerY!;
          console.log(`[VisualNav] Clicking dock item for ${appName} at resolved center (${x}, ${y})`);
          await cursor.moveCursor({ x, y });
          await new Promise(resolve => setTimeout(resolve, 250));
          await cursor.performClick({ x, y });
          await new Promise(resolve => setTimeout(resolve, 1200));
        } else {
          // Fallback to Spotlight path
          const screenWidth = screen.getPrimaryDisplay().bounds.width;
          const spotlightX = Math.min(screenWidth - 50, 1280);
          const spotlightY = 25;
          console.warn(`[VisualNav] Dock item not found via AX; falling back to Spotlight at (${spotlightX}, ${spotlightY})`);
          await cursor.moveCursor({ x: spotlightX, y: spotlightY });
          await new Promise(resolve => setTimeout(resolve, 150));
          await cursor.performClick({ x: spotlightX, y: spotlightY });
          await new Promise(resolve => setTimeout(resolve, 200));
          await runAppleScript(`tell application \"System Events\" to keystroke space using command down`);
          await new Promise(resolve => setTimeout(resolve, 600));
          await runAppleScript(`tell application \"System Events\" to keystroke \"${appName}\"`);
          await new Promise(resolve => setTimeout(resolve, 300));
          await runAppleScript(`tell application \"System Events\" to keystroke return`);
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      } else if (aiResponse.includes("CLICK_SPOTLIGHT:")) {
        // Use dynamic Spotlight position (top-right corner)
        const screenWidth = screen.getPrimaryDisplay().bounds.width;
        const spotlightX = Math.min(screenWidth - 50, 1280); // Adapt to screen size
        const spotlightY = 25;
        
        // Before opening Spotlight, try AX-based Dock click again in case Dock is visible but model missed it
        const axClicked = await clickDockItemIfAvailable(appName, cursor);
        if (axClicked) {
          goalAchieved = true;
          continue;
        }
        
        console.log(`[VisualNav] Opening Spotlight at dynamic position (${spotlightX}, ${spotlightY})`);
        
        await cursor.moveCursor({ x: spotlightX, y: spotlightY });
        await new Promise(resolve => setTimeout(resolve, 150));
        // Perform an actual click where Spotlight icon is, to focus menu bar area
        await cursor.performClick({ x: spotlightX, y: spotlightY });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Execute Spotlight shortcut
        await runAppleScript(`tell application \"System Events\" to keystroke space using command down`);
        await new Promise(resolve => setTimeout(resolve, 600)); // let Spotlight animate in
        // Type the target app and press Return
        await runAppleScript(`tell application \"System Events\" to keystroke \"${appName}\"`);
        await new Promise(resolve => setTimeout(resolve, 300));
        await runAppleScript(`tell application \"System Events\" to keystroke return`);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      
    } catch (error) {
      console.error(`[VisualNav] Error in attempt ${attempt}:`, error);
    }
    
    // Brief pause between attempts
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (goalAchieved) {
    console.log(`[VisualNav] Successfully opened ${appName} using visual navigation`);
    event.sender.send("reply", {
      type: "success",
      message: `${appName} opened successfully using visual navigation!`,
    });
  } else {
    console.log(`[VisualNav] Failed to open ${appName} after ${maxAttempts} attempts`);
    
    // Final native fallback: try to open the app directly
    try {
      const child_process = await import("child_process");
      const { exec: cpExec } = child_process;
      const execPromise = (cmd: string) => new Promise((resolve, reject) => cpExec(cmd, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr })));
      await execPromise(`open -a "${appName}"` as any);
      console.log(`[VisualNav] Native open fallback succeeded for ${appName}`);
      event.sender.send("reply", { type: "success", message: `${appName} opened (fallback).` });
    } catch (nativeErr) {
      console.error(`[VisualNav] Native open fallback failed:`, nativeErr);
      event.sender.send("reply", {
        type: "error", 
        message: `Could not visually navigate to open ${appName}`,
      });
    }
  }
   
   // Hide cursor
   cursor.hide();
   
   // Note: No continuous monitoring - screenshots taken only when needed
   
   console.log(`[VisualNav] Visual navigation session ended`);
 }
 
 }

// Helper: Try to click Dock item via Accessibility (no hardcoded coords)
async function clickDockItemIfAvailable(appName: string, cursor: ReturnType<typeof getVirtualCursor>): Promise<boolean> {
  try {
    const resolved = await geminiVision.getDockItemFrame(appName);
    if (resolved.found && typeof resolved.centerX === 'number' && typeof resolved.centerY === 'number') {
      const x = resolved.centerX!;
      const y = resolved.centerY!;
      console.log(`[VisualNav] [AX] Dock item resolved for ${appName} at (${x}, ${y}) — clicking`);
      await cursor.moveCursor({ x, y });
      await new Promise(r => setTimeout(r, 200));
      await cursor.performClick({ x, y });
      await new Promise(r => setTimeout(r, 300));
      // Basic AppleScript to activate app (user preference)
      await runAppleScript(`tell application "${appName}" to activate`);
      await new Promise(r => setTimeout(r, 900));
      return true;
    }
  } catch (e) {
    console.warn(`[VisualNav] [AX] Dock item resolve failed for ${appName}:`, e);
  }
  return false;
}

async function runAgentS(query: string, event: any) {
  // Spawn the Agent-S bridge
  const pyPath = path.join(process.cwd(), "python", "agent_s_bridge.py");
  const child = spawn("python3", [pyPath], { cwd: process.cwd() });

  // Stream lines
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stderr.on("data", (d) => {
    console.log(`[AgentS][stderr] ${d.toString()}`);
  });

  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        // Forward minimal status to UI
        event.sender.send("stream", { type: "text", content: JSON.stringify(msg) + "\n" });
      } catch {
        console.log(`[AgentS] ${line}`);
      }
    }
  });

  // Initialize
  const initMsg = {
    type: "init",
    provider: process.env.AGENT_S_PROVIDER || "openai",
    model: process.env.AGENT_S_MODEL || "gpt-4o",
    model_url: process.env.AGENT_S_MODEL_URL || "",
    model_api_key: process.env.OPENAI_API_KEY || "",
    // Grounding model (self-hosted) config — must be set by user env
    ground_provider: process.env.AGENT_S_GROUND_PROVIDER || "openai",
    ground_url: process.env.AGENT_S_GROUND_URL || "",
    ground_api_key: process.env.AGENT_S_GROUND_API_KEY || "",
    ground_model: process.env.AGENT_S_GROUND_MODEL || "gpt-4o-mini",
    grounding_width: Number(process.env.AGENT_S_GROUND_W || 1920),
    grounding_height: Number(process.env.AGENT_S_GROUND_H || 1080),
    max_trajectory_length: 8,
    enable_reflection: true,
  };
  child.stdin.write(JSON.stringify(initMsg) + "\n");

  // Run query
  const runMsg = { type: "run", query };
  child.stdin.write(JSON.stringify(runMsg) + "\n");

  return new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
}

