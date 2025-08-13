import OpenAI from 'openai';

class GlassSummaryService {
    constructor() {
        this.conversationHistory = [];
        this.analysisHistory = [];
        this.currentSessionId = null;
        this.callbacks = {};
        this.analysisCounter = 0;
        this.lastAnalysisTimestamp = 0;
        this.MIN_ANALYSIS_INTERVAL = 3000; // 3 seconds between analyses for fresh questions (faster)
        this.lastQuestionRefreshTimestamp = 0;
        this.QUESTION_REFRESH_INTERVAL = 5000; // Refresh "what should I say next" every 5 seconds (faster)

        // Initialize OpenAI client directly
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openaiClient = new OpenAI({ apiKey });
            console.log('[Glass-Meeting Summary] OpenAI client initialized');
        } else {
            console.warn('[Glass-Meeting Summary] No OpenAI API key found - summary service disabled');
        }
    }

    setCallbacks(callbacks) {
        this.callbacks = callbacks;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
        console.log(`[Glass-Meeting Summary] Session ID set: ${sessionId}`);
    }

    addConversationTurn(speaker, text) {
        const turn = {
            speaker,
            text,
            timestamp: new Date()
        };
        this.conversationHistory.push(turn);
        console.log(`[Glass-Meeting Summary] Added turn: ${speaker} - ${text.substring(0, 100)}...`);
        
        // Trigger analysis if conditions are met
        this.triggerAnalysisIfNeeded();
    }

    formatConversationForPrompt(conversationHistory, maxTurns = 30) {
        const recentHistory = conversationHistory.slice(-maxTurns);
        return recentHistory.map(turn => `${turn.speaker}: ${turn.text}`).join('\n');
    }

    triggerAnalysisIfNeeded() {
        const now = Date.now();
        const timeSinceLastAnalysis = now - this.lastAnalysisTimestamp;
        const timeSinceLastQuestionRefresh = now - this.lastQuestionRefreshTimestamp;
        
        // Analyze for fresh "what should I say next" suggestions more frequently
        const shouldRefreshQuestions = timeSinceLastQuestionRefresh >= this.QUESTION_REFRESH_INTERVAL && 
                                      this.conversationHistory.length >= 2;
        
        // Full analysis less frequently
        const shouldFullAnalyze = timeSinceLastAnalysis >= this.MIN_ANALYSIS_INTERVAL && 
                                 this.conversationHistory.length >= 2;
        
        if (shouldRefreshQuestions || shouldFullAnalyze) {
            if (shouldFullAnalyze) {
                this.lastAnalysisTimestamp = now;
            }
            this.lastQuestionRefreshTimestamp = now;
            this.makeOutlineAndRequests(this.conversationHistory, shouldFullAnalyze);
        }
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

    async makeOutlineAndRequests(conversationTexts, fullAnalysis = true, maxTurns = 30) {
        if (!this.openaiClient) {
            console.warn('[Glass-Meeting Summary] No OpenAI client - skipping analysis');
            return null;
        }

        try {
            console.log('[Glass-Meeting Summary] Starting conversation analysis...');
            
            const conversationText = this.formatConversationForPrompt(conversationTexts, maxTurns);
            
            const systemPrompt = `You are an AI assistant that analyzes conversations and provides structured insights. 

Your task is to analyze the conversation and return a JSON object with the following structure:
{
  "topic": {
    "header": "Brief topic title (e.g., 'Product Strategy Discussion', 'Project Status Update')",
    "description": "1-2 sentence description of what's being discussed"
  },
  "summary": ["Key point 1", "Key point 2", "Key point 3"],
  "actions": ["Suggestion for what to say/do next"],
  "questions": ["Specific thing to say next in the meeting"],
  "keyPoints": ["Important insight or decision made"]
}

Guidelines for the "questions" field (MOST IMPORTANT):
- These should be ACTUAL SENTENCES or questions the user can say right now
- Must be specific to the current conversation context
- Should move the discussion forward productively
- Use natural, conversational language
- Examples:
  - "What's the timeline for implementing this feature?"
  - "I agree with that approach. Should we assign someone to lead this?"
  - "That makes sense. How will this impact our Q1 goals?"
  - "Can you clarify the budget constraints for this project?"

Other guidelines:
- Topic header should be specific and meaningful, not generic
- Actions are suggestions for the user, not clickable items
- Be concise and focus on substance
- Include 2-4 questions that would be most helpful right now
- Return only valid JSON, no additional text`;

            const userPrompt = `Please analyze this conversation and provide structured insights:

${conversationText}`;

            // Use faster model for question refreshes, full model for complete analysis
            const response = await this.openaiClient.chat.completions.create({
                model: fullAnalysis ? 'gpt-4' : 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: fullAnalysis ? 1000 : 500,
                temperature: 0.3
            });

            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error('No response content from OpenAI');
            }

            // Parse JSON response
            let analysis;
            try {
                analysis = JSON.parse(content);
            } catch (parseError) {
                console.error('[Glass-Meeting Summary] Failed to parse JSON response:', parseError);
                console.error('[Glass-Meeting Summary] Raw response:', content);
                return null;
            }

            // Add metadata
            analysis.timestamp = new Date();
            analysis.sessionId = this.currentSessionId;
            analysis.analysisId = ++this.analysisCounter;

            // Store in history
            this.analysisHistory.push(analysis);

            console.log(`[Glass-Meeting Summary] ✅ ${fullAnalysis ? 'Full analysis' : 'Questions refresh'} complete:`, analysis.topic?.header);
            console.log('[Glass-Meeting Summary] New questions:', analysis.questions);

            // Send to renderer for UI updates
            this.sendToRenderer('analysis-complete', analysis);

            // Notify callback
            if (this.callbacks.onAnalysisComplete) {
                this.callbacks.onAnalysisComplete(analysis);
            }

            return analysis;

        } catch (error) {
            console.error('[Glass-Meeting Summary] ❌ Analysis failed:', error);
            if (this.callbacks.onStatusUpdate) {
                this.callbacks.onStatusUpdate('Analysis failed');
            }
            return null;
        }
    }

    async generateFinalSummary(conversationHistory) {
        if (!this.openaiClient || conversationHistory.length === 0) {
            return null;
        }

        try {
            console.log('[Glass-Meeting Summary] Generating final meeting summary...');
            
            const conversationText = this.formatConversationForPrompt(conversationHistory, 100); // More context for final summary
            
            const systemPrompt = `You are an AI assistant that creates comprehensive meeting summaries. 

Analyze the entire conversation and create a detailed final summary with this structure:
{
  "meetingSummary": {
    "title": "Meeting topic/title",
    "duration": "Estimated duration",
    "participants": ["Participant names if identifiable"],
    "keyDiscussions": ["Main discussion point 1", "Main discussion point 2"],
    "decisions": ["Decision 1", "Decision 2"],
    "actionItems": ["Action 1", "Action 2"],
    "followUpNeeded": ["Follow-up 1", "Follow-up 2"],
    "nextSteps": ["Next step 1", "Next step 2"]
  }
}

Return only valid JSON, no additional text.`;

            const userPrompt = `Please create a comprehensive final summary for this meeting conversation:

${conversationText}`;

            const response = await this.openaiClient.chat.completions.create({
                model: 'gpt-4',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 1500,
                temperature: 0.2
            });

            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error('No response content from OpenAI');
            }

            let finalSummary;
            try {
                finalSummary = JSON.parse(content);
            } catch (parseError) {
                console.error('[Glass-Meeting Summary] Failed to parse final summary JSON:', parseError);
                return null;
            }

            finalSummary.timestamp = new Date();
            finalSummary.sessionId = this.currentSessionId;

            console.log('[Glass-Meeting Summary] ✅ Final summary generated');
            return finalSummary;

        } catch (error) {
            console.error('[Glass-Meeting Summary] ❌ Failed to generate final summary:', error);
            return null;
        }
    }

    getCurrentAnalysisData() {
        return {
            currentSessionId: this.currentSessionId,
            conversationTurns: this.conversationHistory.length,
            analysisCount: this.analysisHistory.length,
            lastAnalysis: this.analysisHistory[this.analysisHistory.length - 1] || null
        };
    }

    getAnalysisHistory() {
        return this.analysisHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.analysisHistory = [];
        this.analysisCounter = 0;
        this.lastAnalysisTimestamp = 0;
        console.log('[Glass-Meeting Summary] Conversation history reset');
    }
}

export default GlassSummaryService; 