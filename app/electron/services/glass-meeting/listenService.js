import GlassSttService from './sttService.js';
import GlassSummaryService from './summaryService.js';
import { v4 as uuidv4 } from 'uuid';
import { ContextualActionsService } from '../ContextualActionsService';

class GlassListenService {
    constructor() {
        this.sttService = new GlassSttService();
        this.summaryService = new GlassSummaryService();
        this.contextualActionsService = new ContextualActionsService();
        this.currentSessionId = null;
        this.isInitializingSession = false;
        this.conversationHistory = [];

        this.setupServiceCallbacks();
        console.log('[Glass-Meeting ListenService] Service instance created.');
    }

    setupServiceCallbacks() {
        // STT service callbacks
        this.sttService.setCallbacks({
            onTranscriptionComplete: (speaker, text) => {
                this.handleTranscriptionComplete(speaker, text);
            },
            onStatusUpdate: (status) => {
                this.sendToRenderer('update-status', status);
            },
            onPartial: (speaker, text) => {
                // Debounced refresh of contextual actions for more responsiveness
                if (!this._partialTimer) this._partialTimer = null;
                if (this._partialTimer) clearTimeout(this._partialTimer);
                this._partialTimer = setTimeout(async () => {
                    try {
                        this.contextualActionsService.addConversationTurn(speaker, text);
                        const results = await this.contextualActionsService.generateContextualActions(text, speaker);
                        if (results?.searchItems?.length) {
                            this.sendToRenderer('contextual-search', results.searchItems);
                        }
                    } catch {}
                }, 350);
            }
        });

        // Summary service callbacks
        this.summaryService.setCallbacks({
            onAnalysisComplete: (data) => {
                console.log('📊 Glass-Meeting: Analysis completed:', data);
                this.sendToRenderer('analysis-update', data);
            },
            onStatusUpdate: (status) => {
                this.sendToRenderer('update-status', status);
            }
        });
    }

    sendToRenderer(channel, data) {
        import('electron').then(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                windows[0].webContents.send(channel, data);
            }
        }).catch(error => {
            console.error('[Glass-Meeting] Error importing electron:', error);
        });
    }

    async handleTranscriptionComplete(speaker, text) {
        console.log(`[Glass-Meeting] Transcription complete: ${speaker} - ${text}`);
        
        // Add to conversation history
        const turn = {
            id: uuidv4(),
            speaker,
            text,
            timestamp: new Date()
        };
        this.conversationHistory.push(turn);
        
        // Add to summary service for analysis
        this.summaryService.addConversationTurn(speaker, text);
        
        // Send to renderer for display
        this.sendToRenderer('transcription-complete', turn);
        
        // REMOVED: No longer generate contextual actions on every transcription
        // This was causing the garbage "what is search" type actions
        // Contextual actions are now only triggered when analysis/summary is ready
    }

    async initializeSession(language = 'en') {
        if (this.isInitializingSession) {
            console.log('[Glass-Meeting] Session initialization already in progress.');
            return false;
        }

        this.isInitializingSession = true;
        this.sendToRenderer('session-initializing', true);
        this.sendToRenderer('update-status', 'Initializing meeting session...');

        try {
            // Generate new session ID
            this.currentSessionId = uuidv4();
            console.log(`[Glass-Meeting] New session ID: ${this.currentSessionId}`);
            
            // Set session ID for summary service
            this.summaryService.setSessionId(this.currentSessionId);
            
            // Reset conversation history
            this.conversationHistory = [];
            this.summaryService.resetConversationHistory();

            // Initialize STT sessions with retry logic
            const MAX_RETRY = 10;
            const RETRY_DELAY_MS = 300;

            let sttReady = false;
            for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
                try {
                    await this.sttService.initializeSttSessions(language);
                    sttReady = true;
                    break;
                } catch (err) {
                    console.warn(
                        `[Glass-Meeting] STT init attempt ${attempt} failed: ${err.message}`
                    );
                    if (attempt < MAX_RETRY) {
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    }
                }
            }
            if (!sttReady) throw new Error('STT init failed after retries');

            console.log('✅ Glass-Meeting: Listen service initialized successfully.');
            
            this.sendToRenderer('update-status', 'Connected. Ready to listen.');
            this.sendToRenderer('session-initialized', {
                sessionId: this.currentSessionId,
                timestamp: new Date()
            });
            
            return true;
        } catch (error) {
            console.error('❌ Glass-Meeting: Failed to initialize listen service:', error);
            this.sendToRenderer('update-status', 'Initialization failed.');
            return false;
        } finally {
            this.isInitializingSession = false;
            this.sendToRenderer('session-initializing', false);
        }
    }

    async sendMicAudioContent(data) {
        return await this.sttService.sendMicAudioContent(data);
    }

    async sendSystemAudioContent(data) {
        return await this.sttService.sendSystemAudioContent(data);
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin') {
            throw new Error('macOS audio capture only available on macOS');
        }
        return await this.sttService.startMacOSAudioCapture();
    }

    async stopMacOSAudioCapture() {
        this.sttService.stopMacOSAudioCapture();
    }

    isSessionActive() {
        return this.sttService.isSessionActive();
    }

    async closeSession() {
        try {
            // Close STT sessions
            await this.sttService.closeSessions();

            // Stop macOS audio capture if running
            await this.stopMacOSAudioCapture();

            // Generate final summary if there's conversation history
            if (this.conversationHistory.length > 0) {
                console.log('[Glass-Meeting] Generating final summary...');
                const finalSummary = await this.summaryService.generateFinalSummary(this.conversationHistory);
                if (finalSummary) {
                    this.sendToRenderer('final-summary-generated', finalSummary);
                }
            }

            // Reset state
            this.currentSessionId = null;
            this.conversationHistory = [];
            this.summaryService.resetConversationHistory();

            console.log('[Glass-Meeting] Session closed.');
            this.sendToRenderer('session-closed', true);
            
            return { success: true };
        } catch (error) {
            console.error('[Glass-Meeting] Error closing session:', error);
            return { success: false, error: error.message };
        }
    }

    getCurrentSessionData() {
        return {
            sessionId: this.currentSessionId,
            conversationHistory: this.conversationHistory,
            totalTexts: this.conversationHistory.length,
            analysisData: this.summaryService.getCurrentAnalysisData(),
            analysisHistory: this.summaryService.getAnalysisHistory()
        };
    }

    getConversationHistory() {
        return this.conversationHistory;
    }
    
    getRecentTranscripts(limit = 6) {
        // Return the most recent conversation turns for context
        const recent = this.conversationHistory.slice(-limit);
        console.log(`[Glass-Meeting] Getting ${recent.length} recent transcripts for context`);
        return recent.map(turn => ({
            speaker: turn.speaker || 'unknown',
            text: turn.text || ''
        }));
    }

    getSummaryHistory() {
        return this.summaryService.getAnalysisHistory();
    }
}

// Export the class so we can create instances as needed
export default GlassListenService; 