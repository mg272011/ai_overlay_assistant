import OpenAI from 'openai';

interface SummaryCallbacks {
  onAnalysisComplete: (data: any) => void;
  onStatusUpdate: (status: string) => void;
}

interface ConversationTurn {
  speaker: string;
  text: string;
  timestamp: Date;
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

export class SummaryService {
  private callbacks: SummaryCallbacks | null = null;
  private conversationHistory: string[] = [];
  private previousAnalysis: AnalysisResult | null = null;
  private analysisHistory: AnalysisResult[] = [];
  private openaiClient: OpenAI | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private lastAnalysisTime: number = 0;
  private ANALYSIS_INTERVAL = 30000; // Analyze every 30 seconds
  private MIN_TURNS_FOR_ANALYSIS = 3; // Need at least 3 turns for analysis

  constructor() {
    this.initializeClient();
    console.log('[Glass-SummaryService] Service initialized');
  }

  private initializeClient() {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.openaiClient = new OpenAI({ apiKey: openaiKey });
      console.log('[Glass-SummaryService] OpenAI client initialized');
    } else {
      console.warn('[Glass-SummaryService] No OpenAI API key configured');
    }
  }

  setCallbacks(callbacks: SummaryCallbacks) {
    this.callbacks = callbacks;
  }

  addConversationTurn(speaker: string, text: string) {
    const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
    this.conversationHistory.push(conversationText);
    
    console.log(`💬 Glass: Added conversation text: ${conversationText}`);
    console.log(`📈 Glass: Total conversation history: ${this.conversationHistory.length} texts`);

    // Trigger analysis if needed
    this.triggerAnalysisIfNeeded();
  }

  private triggerAnalysisIfNeeded() {
    const now = Date.now();
    const timeSinceLastAnalysis = now - this.lastAnalysisTime;
    
    // Check if we should analyze
    if (
      this.conversationHistory.length >= this.MIN_TURNS_FOR_ANALYSIS &&
      timeSinceLastAnalysis >= this.ANALYSIS_INTERVAL
    ) {
      this.performAnalysis();
    }
  }

  private async performAnalysis() {
    if (!this.openaiClient) {
      console.warn('[Glass-SummaryService] Cannot perform analysis without OpenAI client');
      return;
    }

    this.lastAnalysisTime = Date.now();
    this.callbacks?.onStatusUpdate('Analyzing conversation...');

    try {
      const recentConversation = this.formatConversationForPrompt(this.conversationHistory, 30);
      
      // Build context from previous analysis
      let contextualPrompt = '';
      if (this.previousAnalysis) {
        contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${this.previousAnalysis.topic.header}
- Key Points: ${this.previousAnalysis.summary.slice(0, 3).join(', ')}
- Last Actions: ${this.previousAnalysis.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
      }

      const systemPrompt = this.buildSystemPrompt(recentConversation);
      
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `${contextualPrompt}

Analyze the conversation and provide a structured summary. Format your response as JSON with the following structure:
{
  "topic": {
    "header": "Main topic of discussion",
    "description": "Brief description of what's being discussed"
  },
  "summary": ["Key point 1", "Key point 2", "Key point 3"],
  "actions": ["Action item 1", "Action item 2"],
  "questions": ["Follow-up question 1", "Follow-up question 2"],
  "keyPoints": ["Important insight 1", "Important insight 2"]
}

Keep all points concise and build upon previous analysis if provided.`
        }
      ];

      console.log('🤖 Glass: Sending analysis request to OpenAI...');

      const completion = await this.openaiClient.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const analysis = JSON.parse(responseText) as AnalysisResult;
        analysis.timestamp = new Date();
        
        this.previousAnalysis = analysis;
        this.analysisHistory.push(analysis);
        
        console.log('📊 Glass: Analysis complete:', analysis);
        this.callbacks?.onAnalysisComplete(analysis);
        this.callbacks?.onStatusUpdate('Analysis complete');
      }
    } catch (error) {
      console.error('[Glass-SummaryService] Analysis error:', error);
      this.callbacks?.onStatusUpdate('Analysis failed');
    }
  }

  async generateFinalSummary(conversationHistory: ConversationTurn[]): Promise<AnalysisResult | null> {
    if (!this.openaiClient || conversationHistory.length === 0) {
      return null;
    }

    try {
      const fullConversation = conversationHistory
        .map(turn => `${turn.speaker}: ${turn.text}`)
        .join('\n');

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: this.buildSystemPrompt(fullConversation)
        },
        {
          role: 'user',
          content: `Generate a comprehensive final summary of this entire meeting/conversation. Format your response as JSON with the following structure:
{
  "topic": {
    "header": "Overall meeting topic",
    "description": "Comprehensive description of what was discussed"
  },
  "summary": ["Main outcome 1", "Main outcome 2", "Main outcome 3"],
  "actions": ["All action items from the meeting"],
  "questions": ["Unresolved questions or follow-ups needed"],
  "keyPoints": ["Most important insights and decisions made"]
}

Be thorough but concise. Include all important information from the entire conversation.`
        }
      ];

      const completion = await this.openaiClient.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages,
        temperature: 0.7,
        max_tokens: 2048,
        response_format: { type: 'json_object' }
      });

      const responseText = completion.choices[0]?.message?.content;
      if (responseText) {
        const finalSummary = JSON.parse(responseText) as AnalysisResult;
        finalSummary.timestamp = new Date();
        
        console.log('📊 Glass: Final summary generated:', finalSummary);
        this.callbacks?.onAnalysisComplete(finalSummary);
        
        return finalSummary;
      }
    } catch (error) {
      console.error('[Glass-SummaryService] Final summary error:', error);
    }
    
    return null;
  }

  private formatConversationForPrompt(conversationTexts: string[], maxTurns: number = 30): string {
    if (conversationTexts.length === 0) return '';
    return conversationTexts.slice(-maxTurns).join('\n');
  }

  private buildSystemPrompt(conversation: string): string {
    return `You are an AI meeting assistant analyzing a live conversation. Your role is to:
1. Identify the main topics being discussed
2. Extract key points and decisions
3. Identify action items and who is responsible
4. Suggest follow-up questions that could be helpful
5. Highlight important insights

The conversation so far:
${conversation}

Provide clear, concise, and actionable insights that help participants stay focused and productive.`;
  }

  resetConversation() {
    this.conversationHistory = [];
    this.previousAnalysis = null;
    this.analysisHistory = [];
    this.lastAnalysisTime = 0;
    
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    
    console.log('🔄 Glass: Conversation history and analysis state reset');
  }

  getConversationHistory(): string[] {
    return this.conversationHistory;
  }

  getAnalysisHistory(): AnalysisResult[] {
    return this.analysisHistory;
  }
} 