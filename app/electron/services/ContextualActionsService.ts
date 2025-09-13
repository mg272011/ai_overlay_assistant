import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ContextualAction {
  id: string;
  text: string;
  type: 'search' | 'define' | 'research' | 'question' | 'suggestion';
  query?: string; // For search/define actions
  confidence: number; // 0-1 confidence score
}

export interface MeetingSuggestion {
  id: string;
  text: string;
  type: 'question' | 'follow-up' | 'clarify' | 'response';
  confidence: number; // 0-1 confidence score
}

export interface ContextualResults {
  searchItems: ContextualAction[];
  suggestions: MeetingSuggestion[];
}

export interface ConversationTurn {
  speaker: string;
  text: string;
  timestamp: Date;
}

export class ContextualActionsService {
  private openai: OpenAI;
  private gemini: GoogleGenerativeAI | null = null;
  private recentTurns: ConversationTurn[] = [];
  private lastActionTime: number = 0;
  private actionCache = new Map<string, ContextualResults>();

  constructor() {
    this.openai = new OpenAI();
    
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiApiKey) {
      try {
        this.gemini = new GoogleGenerativeAI(geminiApiKey);
        console.log('[ContextualActions] Gemini client initialized');
      } catch (err) {
        console.warn('[ContextualActions] Failed to init Gemini client, will fallback to OpenAI:', err);
        this.gemini = null;
      }
    }
  }

  public addConversationTurn(speaker: string, text: string): void {
    this.recentTurns.push({
      speaker,
      text,
      timestamp: new Date()
    });

    // Keep only last 5 turns for performance
    if (this.recentTurns.length > 5) {
      this.recentTurns.shift();
    }
  }

  public async generateContextualActions(currentText: string, speaker: string): Promise<ContextualResults> {
    // Much more aggressive throttling reduction for real-time generation
    const now = Date.now();
    if (now - this.lastActionTime < 1000) { // Reduced from 2000 to 1000ms for faster generation
      console.log('[ContextualActions] ⏰ Throttled - too soon since last request');
      return { searchItems: [], suggestions: [] };
    }

    // VERY RELAXED: Allow generation with minimal context
    if (this.recentTurns.length < 1) { // Reduced from 2 to 1 - generate on first turn
      console.log('[ContextualActions] ⚠️ Not enough conversation context yet, waiting... (have', this.recentTurns.length, 'turns)');
      return { searchItems: [], suggestions: [] };
    }

    // VERY RELAXED: Only skip extremely short messages
    if (currentText.length < 8) { // Reduced from 15 to 8 chars
      console.log('[ContextualActions] ⚠️ Skipping very short message:', currentText.length, 'chars');
      return { searchItems: [], suggestions: [] };
    }

    // Check cache first
    const cacheKey = this.getCacheKey(currentText);
    if (this.actionCache.has(cacheKey)) {
      console.log('[ContextualActions] 📋 Returning cached result for:', cacheKey);
      return this.actionCache.get(cacheKey) || { searchItems: [], suggestions: [] };
    }

    this.lastActionTime = now;
    console.log('[ContextualActions] 🚀 GENERATING actions for:', speaker, '-', currentText.substring(0, 50));
    console.log('[ContextualActions] 🚀 Recent turns context:', this.recentTurns.length, 'turns');
    console.log('[ContextualActions] 🚀 Recent turns:', this.recentTurns.map(t => `${t.speaker}: ${t.text.substring(0, 30)}...`));

    try {
      const results = await this.generateActionsWithAI(currentText || '');
      
      // Suppress noisy generation logs in production use
      // console.log('[ContextualActions] ✅ Generated:', results.searchItems.length, 'search items,', results.suggestions.length, 'suggestions');
      
      // Cache the result even if empty to avoid re-generating
      this.actionCache.set(cacheKey, results);
      
      // Clean old cache entries
      if (this.actionCache.size > 50) {
        const firstKey = this.actionCache.keys().next().value;
        if (firstKey) {
          this.actionCache.delete(firstKey);
        }
      }

      return results;
    } catch (error) {
      console.error('[ContextualActions] ❌ Error generating actions:', error);
      return { searchItems: [], suggestions: [] };
    }
  }

  private async generateActionsWithAI(currentText: string): Promise<ContextualResults> {
    const recentContext = this.recentTurns
      .slice(-3) // Only last 3 turns to keep it focused
      .map(turn => `${turn.speaker}: ${turn.text}`)
      .join('\n');

    const systemPrompt = `You are Neatly, an on-device assistant that generates useful, clickable actions for live conversations. Be liberal.

Neatly can: run web searches, define terms, suggest follow-ups, analyze screens/recordings, summarize meetings, and help craft replies. Your items should reflect these capabilities without executing them yet.

Return 4-5 total items mixing:
- search: web searches or lookups (people, places, terms)
- define: brief definition queries
- research: quick research queries
- question: clarifying questions the user could ask
- suggestion: actionable steps the user could do next

Rules:
- Keep each item's text short and specific.
- Do not answer now. Items just describe the action/query. The app will run it when clicked.
- Prefer concrete phrasing: e.g. "Search Japantown restaurants", "Define software engineering", "Ask about project timeline".
- Include a "query" only for types that require it (search/define/research). For question/suggestion leave query blank.

Return JSON like:
{
  "items": [
    { "text": "Search Japantown restaurants", "type": "search", "query": "Japantown SF best restaurants", "confidence": 0.7 },
    { "text": "Ask about project timeline", "type": "question", "confidence": 0.6 },
    { "text": "Define software engineering", "type": "define", "query": "software engineering definition", "confidence": 0.7 }
  ]
}`;

    const userPrompt = `Conversation context:\n${recentContext}\n\nLatest statement: "${currentText}"\n\nGenerate 4-5 mixed items that would be most helpful right now.`;

    try {
      let response;
      if (this.gemini) {
        const model = this.gemini.getGenerativeModel({ 
          model: 'gemini-2.5-flash',
          generationConfig: { temperature: 0.2, maxOutputTokens: 220 }
        });
        const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }] });
        response = result.response?.text()?.trim() || '';
      } else {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt } ],
          max_tokens: 220,
          temperature: 0.2
        });
        response = completion.choices[0]?.message?.content?.trim() || '';
      }
      if (!response) return { searchItems: [], suggestions: [] };

      let parsed: any;
      try {
        let clean = response;
        if (response.includes('```json')) clean = response.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        else if (response.includes('```')) clean = response.replace(/```\s*/, '').replace(/```\s*$/, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        return { searchItems: [], suggestions: [] };
      }

      const items: ContextualAction[] = (parsed.items || [])
        .filter((item: any) => {
          if (!item?.text || !item?.type) return false;
          const t = String(item.type).toLowerCase();
          if (!['search','define','research','question','suggestion'].includes(t)) return false;
          if ((item.confidence || 0) < 0.3) return false;
          if ((t === 'search' || t === 'define' || t === 'research') && !item.query) return false;
          return true;
        })
        .slice(0, 5)
        .map((item: any, idx: number) => ({
          id: `ctx-${Date.now()}-${idx}`,
          text: item.text,
          type: item.type as any,
          query: item.query,
          confidence: Math.min(item.confidence || 0.5, 1)
        }));

      // Put all items into searchItems to use a single rendering list in the UI
      return { searchItems: items, suggestions: [] };

    } catch (error) {
      console.error('[ContextualActions] AI generation error:', error);
      return { searchItems: [], suggestions: [] };
    }
  }

  private getCacheKey(text: string): string {
    // Create a simple cache key from the text
    return text.toLowerCase().slice(0, 50).replace(/\s+/g, ' ').trim();
  }

  // REMOVED buildFallbackSearches - no more garbage fallback searches!
  // REMOVED isCasualConversation - being more aggressive about generating searches

  public clearCache(): void {
    this.actionCache.clear();
  }

  public clearHistory(): void {
    this.recentTurns = [];
  }
}