import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ContextualAction {
  id: string;
  text: string;
  type: 'search' | 'define' | 'research';
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
    // Throttle requests to avoid too many API calls
    const now = Date.now();
    if (now - this.lastActionTime < 3000) { // Much longer delay - only generate after meaningful conversation
      console.log('[ContextualActions] Throttled - too soon since last request');
      return { searchItems: [], suggestions: [] };
    }

    // IMPORTANT: Only generate actions if we have enough conversation context
    if (this.recentTurns.length < 3) {
      console.log('[ContextualActions] Not enough conversation context yet, waiting...');
      return { searchItems: [], suggestions: [] };
    }

    // Skip for very short messages or casual conversation
    if (currentText.length < 20 || this.isCasualConversation(currentText)) {
      console.log('[ContextualActions] Skipping casual/short conversation');
      return { searchItems: [], suggestions: [] };
    }

    // Check cache first
    const cacheKey = this.getCacheKey(currentText);
    if (this.actionCache.has(cacheKey)) {
      console.log('[ContextualActions] Returning cached result for:', cacheKey);
      return this.actionCache.get(cacheKey) || { searchItems: [], suggestions: [] };
    }

    this.lastActionTime = now;
    console.log('[ContextualActions] Generating actions for:', speaker, '-', currentText.substring(0, 50));

    try {
      const results = await this.generateActionsWithAI(currentText || '');
      
      console.log('[ContextualActions] Generated:', results.searchItems.length, 'search items');
      
      // Cache the result ONLY if we got quality results
      if (results.searchItems.length > 0) {
        this.actionCache.set(cacheKey, results);
      }
      
      // Clean old cache entries
      if (this.actionCache.size > 50) {
        const firstKey = this.actionCache.keys().next().value;
        if (firstKey) {
          this.actionCache.delete(firstKey);
        }
      }

      return results;
    } catch (error) {
      console.error('[ContextualActions] Error generating actions:', error);
      return { searchItems: [], suggestions: [] };
    }
  }

  private isCasualConversation(text: string): boolean {
    const casual = ['hi', 'hello', 'hey', 'thanks', 'okay', 'ok', 'yeah', 'yes', 'no', 'bye', 'goodbye', 'see you'];
    const lower = text.toLowerCase();
    return casual.some(word => lower.includes(word)) && text.length < 50;
  }

  private async generateActionsWithAI(currentText: string): Promise<ContextualResults> {
    const recentContext = this.recentTurns
      .slice(-3) // Only last 3 turns to keep it focused
      .map(turn => `${turn.speaker}: ${turn.text}`)
      .join('\n');

    const systemPrompt = `You are an expert at generating HIGHLY RELEVANT search suggestions for professional meetings and technical discussions.

ONLY generate searches that are:
✅ SPECIFIC technical topics, products, companies, or methodologies mentioned
✅ Industry standards, frameworks, or best practices discussed  
✅ Research papers, documentation, or specific tools mentioned
✅ Business strategies, market analysis, or competitive intelligence needs
✅ Educational resources for topics being discussed

❌ NEVER generate searches for:
❌ Common words or generic terms (what is "search", "girl", "man", etc.)
❌ Personal information about individuals
❌ Vague "latest on X" queries unless X is a specific product/company
❌ Questions that don't provide useful professional information
❌ Generic definitions that everyone would know

EXAMPLES OF GOOD SEARCHES:
- "React Server Components documentation"
- "OpenAI API pricing 2024"
- "Kubernetes deployment best practices"
- "TypeScript 5.0 new features"
- "PostgreSQL vs MongoDB performance comparison"
- "Product management OKR templates"

EXAMPLES OF BAD SEARCHES TO AVOID:
- "What is search" (too generic)
- "What is girl" (meaningless)
- "Latest on conversation" (too vague)
- "Information about meeting" (useless)

Return JSON with this EXACT structure:
{
  "searchItems": [
    {
      "text": "Search for [specific technical/professional topic]", 
      "type": "search",
      "query": "specific professional search query",
      "confidence": 0.8
    }
  ],
  "suggestions": []
}

STRICT QUALITY RULES:
1. Maximum 2 search items - quality over quantity
2. Only generate if there are genuinely useful technical/professional topics mentioned
3. Each search must be specific enough to return actionable information
4. If no good searches can be generated, return empty searchItems array
5. Confidence must be 0.7 or higher for all items
6. Every search must provide clear professional value`;

    const userPrompt = `Conversation context:
${recentContext}

Latest statement: "${currentText}"

Generate ONLY high-quality professional search suggestions for specific topics mentioned. If no specific technical/professional topics were discussed, return empty searchItems array.`;

    try {
      let response;
      
      // Try Gemini first if available
      if (this.gemini) {
        const model = this.gemini.getGenerativeModel({ 
          model: 'gemini-2.5-flash',
          generationConfig: {
            temperature: 0.1, // Very low temperature for consistent, focused results
            maxOutputTokens: 200
          }
        });
        const result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }]
        });
        response = result.response?.text()?.trim() || '';
      } else {
        // Fallback to OpenAI
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 200,
          temperature: 0.1 // Very low temperature for consistent results
        });
        response = completion.choices[0]?.message?.content?.trim() || '';
      }

      if (!response) {
        return { searchItems: [], suggestions: [] };
      }

      // Parse JSON response (handle markdown code block wrappers)
      let parsedResponse: any;
      try {
        // Remove markdown code block wrappers if present
        let cleanResponse = response;
        if (response.includes('```json')) {
          cleanResponse = response.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        } else if (response.includes('```')) {
          cleanResponse = response.replace(/```\s*/, '').replace(/```\s*$/, '').trim();
        }
        
        parsedResponse = JSON.parse(cleanResponse);
      } catch (parseError) {
        console.warn('[ContextualActions] Failed to parse JSON response:', response);
        return { searchItems: [], suggestions: [] };
      }

      // Validate and filter search items with STRICT quality criteria
      const searchItems: ContextualAction[] = (parsedResponse.searchItems || [])
        .filter((item: any) => {
          // Must have all required fields
          if (!item.text || !item.type || !item.query) return false;
          
          // Must have high confidence
          if ((item.confidence || 0) < 0.7) return false;
          
          // Filter out generic/meaningless searches
          const badPatterns = [
            /what is \w{1,6}$/i,  // "what is X" where X is very short
            /latest on \w{1,8}$/i, // "latest on X" where X is very short
            /information about/i,
            /stuff about/i,
            /everything about/i,
            /general \w+ knowledge/i
          ];
          
          if (badPatterns.some(pattern => pattern.test(item.text))) {
            console.log('[ContextualActions] Filtered out generic search:', item.text);
            return false;
          }
          
          // Filter out single word queries or very generic terms
          const words = item.query.toLowerCase().split(/\s+/);
          if (words.length === 1 && words[0].length < 6) {
            console.log('[ContextualActions] Filtered out single short word:', item.query);
            return false;
          }
          
          return true;
        })
        .slice(0, 2) // Max 2 search items
        .map((item: any, index: number) => ({
          id: `search-${Date.now()}-${index}`,
          text: item.text,
          type: item.type as 'search' | 'define' | 'research',
          query: item.query,
          confidence: Math.min(item.confidence || 0.7, 1.0)
        }));

      // NO FALLBACK SEARCHES - if AI didn't generate good ones, return empty
      console.log('[ContextualActions] Final filtered search items:', searchItems.length);
      
      return { searchItems, suggestions: [] };

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

  public clearCache(): void {
    this.actionCache.clear();
  }

  public clearHistory(): void {
    this.recentTurns = [];
  }
}