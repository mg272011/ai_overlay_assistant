import { EventEmitter } from "events";
// @ts-ignore
import { BrowserWindow, desktopCapturer } from "electron";
import OpenAI from "openai";
import { LiveAudioService } from "../services/LiveAudioService";
import { TranscriptionResult } from "../services/TranscribeHelper";
import { ContextualActionsService } from "../services/ContextualActionsService";
import { logWithElapsed } from "../utils/utils";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ConversationContext {
  audioTranscript: { speaker: string; text: string; timestamp: number }[];
  screenContent: string;
  currentSpeaker: string;
  meetingType: "interview" | "meeting" | "sales" | "exam" | "general";
}

export class ConversationMonitor extends EventEmitter {
  private openai: OpenAI;
  private gemini: GoogleGenerativeAI | null = null;
  private liveAudioService: LiveAudioService;
  private contextualActionsService: ContextualActionsService;
  private isMonitoring: boolean = false;
  private context: ConversationContext;
  private screenMonitorInterval: NodeJS.Timeout | null = null;
  private currentWindow: BrowserWindow | null = null;
  
  constructor() {
    super();
    console.log('[ConversationMonitor] Initializing...');
    this.openai = new OpenAI();

    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiApiKey) {
      try {
        this.gemini = new GoogleGenerativeAI(geminiApiKey);
        console.log('[ConversationMonitor] Gemini client initialized');
      } catch (err) {
        console.warn('[ConversationMonitor] Failed to init Gemini client, will fallback to OpenAI:', err);
        this.gemini = null;
      }
    }

    this.liveAudioService = new LiveAudioService();
    this.contextualActionsService = new ContextualActionsService();
    this.context = {
      audioTranscript: [],
      screenContent: "",
      currentSpeaker: "user",
      meetingType: "general"
    };

    // Listen for transcripts from LiveAudioService
    this.liveAudioService.on('transcript', (transcript: TranscriptionResult & { speaker: string }) => {
      console.log('[ConversationMonitor] Received transcript:', transcript.transcript, 'Speaker:', transcript.speaker);
      this.updateAudioTranscript(transcript.transcript, transcript.speaker);
    });

    this.liveAudioService.on('utterance-end', () => {
      console.log('[ConversationMonitor] Utterance ended, generating suggestions...');
      // Generate suggestions when there's a pause in speech
      this.generateSuggestions();
    });
    console.log('[ConversationMonitor] Initialization complete');
  }

  async startMonitoring(win: InstanceType<typeof BrowserWindow>, meetingType: ConversationContext["meetingType"] = "general") {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    this.currentWindow = win;
    this.context.meetingType = meetingType;
    
    logWithElapsed("ConversationMonitor", `Starting monitoring for ${meetingType}`);
    
    // Start live audio transcription
    try {
      console.log('[ConversationMonitor] Starting LiveAudioService...');
      await this.liveAudioService.start({
        onTranscript: (_: TranscriptionResult) => {
          // Transcript handling is done via event listener above
          console.log('[ConversationMonitor] Transcript callback invoked (should not see this)');
        },
        onUtteranceEnd: () => {
          // Utterance end handling is done via event listener above
          console.log('[ConversationMonitor] Utterance end callback invoked (should not see this)');
        }
      });
      console.log('[ConversationMonitor] LiveAudioService started successfully');
      
      // Notify renderer that audio monitoring has started
      win.webContents.send("start-audio-monitoring");
    } catch (error) {
      console.error('[ConversationMonitor] ❌ FAILED TO START AUDIO SERVICE:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'No stack trace';
      console.error('[ConversationMonitor] Error details:', errorMessage, errorStack);
      logWithElapsed("ConversationMonitor", `Failed to start audio service: ${error}`);
      console.log('[ConversationMonitor] AUTO-STOPPING due to audio service failure');
      this.stopMonitoring(win);
      throw error;
    }
    
    // Start screen monitoring
    this.startScreenMonitoring(win);
    
    this.emit("monitoring-started");
  }

  stopMonitoring(win: InstanceType<typeof BrowserWindow>) {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    
    // Stop audio service
    this.liveAudioService.stop();
    
    // Stop screen monitoring
    if (this.screenMonitorInterval) {
      clearInterval(this.screenMonitorInterval);
      this.screenMonitorInterval = null;
    }
    
    // Clear context
    this.context.audioTranscript = [];
    this.context.screenContent = "";
    
    // Notify renderer
    win.webContents.send("stop-audio-monitoring");
    
    this.emit("monitoring-stopped");
    logWithElapsed("ConversationMonitor", "Stopped monitoring");
  }

  private async startScreenMonitoring(win: InstanceType<typeof BrowserWindow>) {
    // Initial capture
    await this.captureScreen(win);
    
    // Update every 2 seconds
    this.screenMonitorInterval = setInterval(async () => {
      if (this.isMonitoring) {
        await this.captureScreen(win);
      }
    }, 2000);
  }

  private async captureScreen(_: InstanceType<typeof BrowserWindow>) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window", "screen"],
        fetchWindowIcons: false,
        thumbnailSize: { width: 1920, height: 1080 }
      });
      
      // Get the first source (active window/screen)
      const activeSource = sources[0];
      if (activeSource) {
        // For now, just track that we have screen content
        // In production, we'd use OCR or image analysis here
        this.context.screenContent = `Monitoring: ${activeSource.name}`;
        
        // Could also save the thumbnail if needed
        // const image = activeSource.thumbnail;
        // const base64 = image.toDataURL();
      }
    } catch (error) {
      logWithElapsed("ConversationMonitor", `Screen capture error: ${error}`);
    }
  }

  // Called when audio is received from the renderer process
  sendAudioChunk(audioData: Buffer) {
    console.log('[ConversationMonitor] sendAudioChunk called, data size:', audioData.length, 'isMonitoring:', this.isMonitoring, 'audioService active:', this.liveAudioService.isActive());
    if (this.isMonitoring && this.liveAudioService.isActive()) {
      this.liveAudioService.sendAudioChunk(audioData);
    } else {
      console.log('[ConversationMonitor] Skipping audio chunk - not monitoring or audio service not active');
    }
  }

  // Updated to handle transcripts from Deepgram
  updateAudioTranscript(transcript: string, speaker: string = "unknown") {
    this.context.audioTranscript.push({
      speaker,
      text: transcript,
      timestamp: Date.now()
    });
    
    this.context.currentSpeaker = speaker;
    
    // Keep last 50 lines of transcript
    if (this.context.audioTranscript.length > 50) {
      this.context.audioTranscript = this.context.audioTranscript.slice(-50);
    }
    
    this.emit("audio-update", { transcript, speaker });
    
    // Generate contextual actions based on what was just said
    this.generateContextualActions(transcript, speaker);
    
    logWithElapsed("ConversationMonitor", `[${speaker}]: ${transcript}`);
  }

  private async generateContextualActions(transcript: string, speaker: string) {
    if (!this.isMonitoring || !this.currentWindow || transcript.trim().length < 10) {
      return; // Skip very short transcripts
    }

    try {
      // Add conversation turn to contextual actions service
      this.contextualActionsService.addConversationTurn(speaker, transcript);
      
      // Generate contextual actions and suggestions
      const results = await this.contextualActionsService.generateContextualActions(transcript, speaker);
      
      if (results.searchItems.length > 0 || results.suggestions.length > 0) {
        console.log('[ConversationMonitor] Generated contextual results:', results);
        
        // Send separate events for search items and suggestions
        if (results.searchItems.length > 0) {
          this.currentWindow.webContents.send('contextual-search', results.searchItems);
        }
        if (results.suggestions.length > 0) {
          this.currentWindow.webContents.send('contextual-suggestions', results.suggestions);
        }
      }
    } catch (error) {
      console.error('[ConversationMonitor] Error generating contextual actions:', error);
    }
  }

  private async generateSuggestions() {
    if (!this.isMonitoring) return;
    const recentTranscript = this.context.audioTranscript
      .slice(-10)
      .map(t => `${t.speaker}: ${t.text}`)
      .join("\n");
    if (!recentTranscript.trim()) return;

    const systemPrompt = this.getSystemPromptForMeetingType();
    const userPrompt = `Recent conversation (last ~10 turns):\n${recentTranscript}\n\nScreen context: ${this.context.screenContent}\n\nReturn a single short actionable suggestion the user could say or do next. Reply with plain text only.`;

    try {
      // Prefer Gemini 2.5 Flash if available
      if (this.gemini) {
        const model = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }] });
        const suggestion = result.response?.text()?.trim();
        if (suggestion) {
          this.emit("suggestion", { text: suggestion });
          logWithElapsed("ConversationMonitor", `Generated suggestion (Gemini): ${suggestion}`);
          return;
        }
      }

      // Fallback to OpenAI if Gemini is not configured
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 120,
        temperature: 0.6
      });
      const suggestion = response.choices[0]?.message?.content?.trim();
      if (suggestion) {
        this.emit("suggestion", { text: suggestion });
        logWithElapsed("ConversationMonitor", `Generated suggestion (OpenAI): ${suggestion}`);
      }
    } catch (error) {
      logWithElapsed("ConversationMonitor", `Suggestion generation error: ${error}`);
    }
  }

  private getSystemPromptForMeetingType(): string {
    const prompts = {
      interview: "You are an AI assistant helping someone during a job interview. Provide professional suggestions that help them answer questions effectively and showcase their skills.",
      meeting: "You are an AI assistant helping someone during a business meeting. Provide helpful suggestions for contributing meaningfully to discussions and staying on track.",
      sales: "You are an AI assistant helping someone during a sales call. Provide strategic suggestions for addressing customer concerns and highlighting value propositions.",
      exam: "You are an AI assistant helping someone during an exam or test. Provide hints and guidance without giving direct answers, focusing on problem-solving approaches.",
      general: "You are an AI assistant helping someone during a conversation. Provide helpful, contextual suggestions to enhance communication."
    };
    return (prompts as any)[this.context.meetingType] || prompts.general;
  }
} 