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
    if (now - this.lastActionTime < 300) { // more frequent updates
      console.log('[ContextualActions] Throttled - too soon since last request');
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
      
      // Cache the result
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
      console.error('[ContextualActions] Error generating actions:', error);
      return { searchItems: [], suggestions: [] };
    }
  }

  private async generateActionsWithAI(currentText: string): Promise<ContextualResults> {
    const recentContext = this.recentTurns
      .slice(-5) // Last 5 turns for more context
      .map(turn => `${turn.speaker}: ${turn.text}`)
      .join('\n');

    const systemPrompt = `You generate SMART contextual search suggestions for professional meetings.

GOOD search suggestions are:
- Technical/Professional: "React hooks best practices", "Python async/await guide", "Project management methodologies"
- Business/Market: "Q3 earnings report [company]", "Market analysis [industry] 2024", "Competitor pricing strategies"
- Educational/Academic: "MIT OpenCourseWare calculus", "Research papers on [topic]", "How to cite APA format"
- Location/Travel: "Flight deals to [city]", "Conference venues in [location]", "Business hotels near [airport]"
- Tools/Software: "Figma vs Sketch comparison", "Best IDE for Python development", "Slack alternatives for teams"
- Industry/Standards: "ISO 9001 certification process", "GDPR compliance checklist", "Healthcare regulations 2024"

BAD search suggestions to NEVER generate:
- Personal appearance: "latest on [person's name]", "photos of [person]", "[person] personal life"
- Generic/useless: "information about [vague topic]", "stuff about [thing]", "latest on [random word]"
- Inappropriate: Anything about someone's appearance, personal life, or private matters
- Too broad: "everything about [topic]", "all [category] info", "general [subject] knowledge"

Examples of SMART contextual searches:

If discussing a technical problem:
✓ "Stack Overflow [specific error message]"
✓ "[Technology] troubleshooting guide"
✓ "[Framework] version compatibility issues"

If discussing business strategy:
✓ "[Industry] market trends 2024"
✓ "Case studies [business model] success"
✓ "[Competitor] annual report analysis"

If someone mentions a person in a professional context:
✓ "[Person's company] recent news" (NOT about the person personally)
✓ "[Their product/service] reviews" (focus on their work, not them)
✓ NEVER search for personal information about individuals

Return JSON with this exact structure:
{
  "searchItems": [
    {
      "text": "Human-readable search action", 
      "type": "search",
      "query": "professional, specific search query",
      "confidence": 0.8
    }
  ],
  "suggestions": []
}

STRICT RULES:
1. Only suggest searches that would be appropriate in a professional workplace
2. Focus on actionable, specific information (not vague "latest on X")  
3. If a person is mentioned, only search for their professional work/company, NEVER personal info
4. Skip generating suggestions if the topic is too personal or casual
5. Maximum 2-3 high-quality suggestions, better to have none than bad ones
6. Each search must be specific enough to return useful results
7. Valid JSON only`;

    const userPrompt = `Recent conversation context:
${recentContext}

Current statement by ${this.recentTurns[this.recentTurns.length - 1]?.speaker || 'someone'}: "${currentText}"

Generate contextual SEARCH ACTIONS for topics mentioned.`;

    try {
      let response;
      
      // Try Gemini first if available
      if (this.gemini) {
        const model = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
          max_tokens: 300,
          temperature: 0.3
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
        // Try one more time by extracting JSON object pattern
        try {
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedResponse = JSON.parse(jsonMatch[0]);
            console.log('[ContextualActions] Successfully extracted JSON from response');
          } else {
            return { searchItems: [], suggestions: [] };
          }
        } catch (secondError) {
          console.error('[ContextualActions] Could not extract valid JSON:', secondError);
          return { searchItems: [], suggestions: [] };
        }
      }

      // Validate and format search items
      const searchItems: ContextualAction[] = (parsedResponse.searchItems || [])
        .filter((item: any) => item.text && item.type && item.confidence > 0.4)
        .slice(0, 3) // Max 3 search items
        .map((item: any, index: number) => ({
          id: `search-${Date.now()}-${index}`,
          text: item.text,
          type: item.type as 'search' | 'define' | 'research',
          query: item.query || item.text,
          confidence: Math.min(item.confidence || 0.5, 1.0)
        }));

      // Fallback: ensure at least 2 searches always
      if (searchItems.length < 2) {
        const fallback = this.buildFallbackSearches(currentText, 3 - searchItems.length);
        searchItems.push(...fallback);
      }

      // Suggestions are disabled here (handled by say-next)
      const suggestions: MeetingSuggestion[] = [];

      return { searchItems, suggestions };

    } catch (error) {
      console.error('[ContextualActions] AI generation error:', error);
      return { searchItems: [], suggestions: [] };
    }
  }

  private getCacheKey(text: string): string {
    // Create a simple cache key from the text
    return text.toLowerCase().slice(0, 50).replace(/\s+/g, ' ').trim();
  }

  private buildFallbackSearches(text: string, needed: number): ContextualAction[] {
    const cleaned = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const stop = new Set(['the','a','an','and','or','but','if','then','to','of','in','on','for','with','is','are','was','were','be','being','been','it','this','that','these','those','i','you','he','she','we','they']);
    const keywords = Array.from(new Set(tokens.filter(w => !stop.has(w) && w.length >= 4)))
      .sort((a, b) => b.length - a.length)
      .slice(0, Math.max(2, needed));
    const make = (text: string, query: string, idx: number): ContextualAction => ({
      id: `fallback-${Date.now()}-${idx}`,
      text,
      type: 'search',
      query,
      confidence: 0.55,
    });
    const out: ContextualAction[] = [];
    if (keywords.length >= 1) {
      const k = keywords[0];
      out.push(make(`What is ${k}?`, `${k} meaning`, 0));
    }
    if (keywords.length >= 2) {
      const k = keywords[1];
      out.push(make(`Latest on ${k}`, `${k} latest`, 1));
    }
    // Removed "Define key terms from the conversation" action as requested
    return out.slice(0, needed);
  }

  public clearCache(): void {
    this.actionCache.clear();
  }

  public clearHistory(): void {
    this.recentTurns = [];
  }
}