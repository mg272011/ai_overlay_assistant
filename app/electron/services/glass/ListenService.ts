import { BrowserWindow } from 'electron';
import { SttService } from './SttService';
import { SummaryService } from './SummaryService';
import { v4 as uuidv4 } from 'uuid';

interface ConversationTurn {
  speaker: string;
  text: string;
  timestamp: Date;
}

interface SessionData {
  id: string;
  startTime: Date;
  conversationHistory: ConversationTurn[];
  summaries: any[];
  isActive: boolean;
}

export class ListenService {
  private sttService: SttService;
  private summaryService: SummaryService;
  private currentSession: SessionData | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    this.sttService = new SttService();
    this.summaryService = new SummaryService();
    this.setupServiceCallbacks();
    console.log('[Glass-ListenService] Service instance created.');
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
    // Removed setMainWindow calls since methods no longer exist
  }

  private setupServiceCallbacks() {
    // STT service callbacks
    this.sttService.setCallbacks({
      onTranscriptionComplete: (speaker: string, text: string) => {
        this.handleTranscriptionComplete(speaker, text);
      },
      onStatusUpdate: (status: string) => {
        this.sendToRenderer('glass-update-status', status);
      }
    });

    // Summary service callbacks
    this.summaryService.setCallbacks({
      onAnalysisComplete: (data: any) => {
        console.log('📊 Glass Analysis completed:', data);
        this.sendToRenderer('glass-analysis-complete', data);
      },
      onStatusUpdate: (status: string) => {
        this.sendToRenderer('glass-update-status', status);
      }
    });
  }

  private sendToRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  async startListening(): Promise<void> {
    try {
      console.log('[Glass-ListenService] Starting listening session...');
      
      // Initialize new session
      await this.initializeNewSession();
      
      // Start STT service
      await this.sttService.startListening();
      
      // Notify renderer
      this.sendToRenderer('glass-session-state-changed', { isActive: true });
      
      console.log('[Glass-ListenService] Listening session started successfully');
    } catch (error) {
      console.error('[Glass-ListenService] Error starting listening:', error);
      throw error;
    }
  }

  async stopListening(): Promise<void> {
    try {
      console.log('[Glass-ListenService] Stopping listening session...');
      
      // Stop STT service
      await this.sttService.stopListening();
      
      // Generate final summary if needed
      if (this.currentSession && this.currentSession.conversationHistory.length > 0) {
        await this.summaryService.generateFinalSummary(
          this.currentSession.conversationHistory
        );
      }
      
      // Mark session as inactive
      if (this.currentSession) {
        this.currentSession.isActive = false;
      }
      
      // Notify renderer
      this.sendToRenderer('glass-session-state-changed', { isActive: false });
      
      console.log('[Glass-ListenService] Listening session stopped');
    } catch (error) {
      console.error('[Glass-ListenService] Error stopping listening:', error);
      throw error;
    }
  }

  private async handleTranscriptionComplete(speaker: string, text: string) {
    console.log(`[Glass-ListenService] Transcription: ${speaker} - ${text}`);
    
    // Save to session
    if (this.currentSession) {
      const turn: ConversationTurn = {
        speaker,
        text,
        timestamp: new Date()
      };
      
      this.currentSession.conversationHistory.push(turn);
      
      // Send to renderer
      this.sendToRenderer('glass-new-transcription', turn);
      
      // Add to summary service for analysis
      this.summaryService.addConversationTurn(speaker, text);
    }
  }

  private async initializeNewSession() {
    this.currentSession = {
      id: uuidv4(),
      startTime: new Date(),
      conversationHistory: [],
      summaries: [],
      isActive: true
    };
    
    // Reset summary service
    this.summaryService.resetConversation();
    
    console.log('[Glass-ListenService] New session initialized:', this.currentSession.id);
  }

  getSessionData(): SessionData | null {
    return this.currentSession;
  }

  getConversationHistory(): ConversationTurn[] {
    return this.currentSession?.conversationHistory || [];
  }
} 