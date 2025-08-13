import { GoogleGenerativeAI } from "@google/generative-ai";
import { execPromise } from "../utils/utils";

// Helper for retrying API calls with backoff
async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error.status === 503 || error.status === 500 || error.status === 429)) {
      console.warn(`[GeminiVision] API call failed with status ${error.status}. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(res => setTimeout(res, delay));
      return retry(fn, retries - 1, delay * 2); // Exponential backoff
    } else {
      throw error;
    }
  }
}

export class GeminiVisionService {
  private genAI: GoogleGenerativeAI;
  private geminiPro: any;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    this.geminiPro = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  }

  async analyzeScreenForNavigation(screenshotBase64: string, appName: string, attempt: number): Promise<string> {
    console.log(`[GeminiVision] Analyzing screen for ${appName} (attempt ${attempt})`);

    // Get dynamic screen dimensions
    const { screen } = await import('electron');
    const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;
    const spotlightX = Math.round(screenWidth - 50); // Dynamic Spotlight position
    
    const prompt = `You are analyzing a macOS desktop screenshot. Your task is to help navigate to open the app "${appName}".

ANALYZE the screenshot and provide ONLY ONE of these responses:

1. If you can see the ${appName} icon in the dock (bottom of screen):
   Response: CLICK_DOCK: {x,y}
   Where x,y are the EXACT pixel coordinates of the center of the ${appName} icon.

2. If ${appName} is NOT visible in the dock but you can see the dock:
   Response: CLICK_SPOTLIGHT: {${spotlightX},25}
   (This opens Spotlight search in top-right corner)

3. If you see a Launchpad icon in the dock and ${appName} is not visible:
   Response: CLICK_LAUNCHPAD: {x,y}
   Where x,y are the coordinates of the Launchpad icon.

4. If Spotlight search box is already open:
   Response: TYPE_SEARCH: {${appName}}

5. If ${appName} window is already open and visible:
   Response: GOAL_ACHIEVED

IMPORTANT for accurate coordinate detection:
- Be VERY precise with coordinates - look at the exact center of icons
- Look carefully at app icons AND their labels/tooltips
- The dock is usually at the bottom of the screen
- Spotlight is typically in the top-right corner (around x:${spotlightX}, y:25)
- Provide ONLY the action and coordinates, nothing else
- Coordinates must be integers (no decimals)
- Double-check icon positions before responding`;

    const imagePart = {
      inlineData: {
        data: screenshotBase64,
        mimeType: "image/png",
      },
    };

    const promptWithImage: any[] = [prompt, imagePart];

    return retry(async () => {
      try {
        const result = await this.geminiPro.generateContent(promptWithImage);
        const responseText = result.response.text().trim();
        console.log(`[GeminiVision] Raw response from Gemini 2.0 Flash: ${responseText}`);
        if (!responseText) {
          // Fallback if Gemini returns an empty response
          return `CLICK_SPOTLIGHT: {${spotlightX},25}`;
        }
        return responseText;
      } catch (error) {
        console.error(`[GeminiVision] Error analyzing screenshot:`, error);
        // On error, default to a safe fallback action
        return `CLICK_SPOTLIGHT: {${spotlightX},25}`;
      }
    });
  }

  async silentScreenAssessment(screenshotBase64: string, userPrompt: string): Promise<{ currentApps: string[], needsNavigation: boolean, targetApp: string, context: string }> {
    console.log(`[GeminiVision] 🔍 Silent assessment of current screen context`);

    const assessmentPrompt = `Analyze the provided screenshot and user prompt to determine the necessary next steps.

User Prompt: "${userPrompt}"

Based on the screen, identify:
1.  What applications are currently open and visible?
2.  Does the user's request require opening a new application or navigating away from the current view? (needsNavigation: true/false)
3.  If navigation is needed, what is the primary target application? (targetApp: "AppName" or "Unknown")
4.  Provide a brief summary of the current context.

Format your response as a single JSON object:
\`\`\`json
{
  "currentApps": ["App1", "App2"],
  "needsNavigation": boolean,
  "targetApp": "AppName",
  "context": "A brief description of the current screen and user's likely intent."
}
\`\`\`
Be concise and accurate.`;

    const imagePart = {
      inlineData: {
        data: screenshotBase64,
        mimeType: "image/png",
      },
    };
    
    const promptWithImage: any[] = [assessmentPrompt, imagePart];
          const model = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    return retry(async () => {
      try {
        const result = await model.generateContent(promptWithImage);
        const text = result.response.text();
        console.log(`[GeminiVision] 🔍 Silent assessment result:`, text);
        
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonString = jsonMatch ? jsonMatch[1] : text;

        return JSON.parse(jsonString);
      } catch (error) {
        console.error(`[GeminiVision] 🔍 Error during silent assessment:`, error);
        throw error;
      }
    });
  }

  async getDockItemFrame(appName: string): Promise<{ found: boolean; centerX?: number; centerY?: number; error?: string }> {
    try {
      const { stdout } = await execPromise(`swift swift/dockFind.swift "${appName}"`);
      const data = JSON.parse(stdout.trim());
      if (data && data.found && typeof data.x === 'number' && typeof data.y === 'number' && typeof data.w === 'number' && typeof data.h === 'number') {
        return { found: true, centerX: Math.round(data.x + data.w / 2), centerY: Math.round(data.y + data.h / 2) };
      }
      if (data && data.error) {
        return { found: false, error: String(data.error) };
      }
      return { found: false };
    } catch (e: any) {
      // Try to extract structured error from stdout if available
      try {
        const stdout = e?.stdout || e?.message || '';
        if (typeof stdout === 'string' && stdout.includes('{')) {
          const jsonStart = stdout.indexOf('{');
          const jsonEnd = stdout.lastIndexOf('}') + 1;
          const jsonStr = stdout.slice(jsonStart, jsonEnd);
          const data = JSON.parse(jsonStr);
          if (data && data.error) {
            return { found: false, error: String(data.error) };
          }
        }
      } catch {}
      console.warn(`[GeminiVision] Error getting dock item frame for ${appName}:`, e);
      return { found: false };
    }
  }

  async analyzeScreenForElement(
    screenshotBase64: string,
    elementDescription: string
  ): Promise<{ found: boolean; x?: number; y?: number }> {
    try {
      const imagePart = {
        inlineData: {
          data: screenshotBase64,
          mimeType: "image/png",
        },
      };

      const prompt = `Find the UI element: "${elementDescription}" in this screenshot.
If found, respond with: FOUND: {x,y}
If not found, respond with: NOT_FOUND
Be precise with pixel coordinates.`;

      const result = await this.geminiPro.generateContent([prompt, imagePart]);
      const text = result.response.text();
      
      const foundMatch = text.match(/FOUND:\s*\{(\d+),(\d+)\}/);
      if (foundMatch) {
        return {
          found: true,
          x: parseInt(foundMatch[1]),
          y: parseInt(foundMatch[2])
        };
      }
      
      return { found: false };
    } catch (error) {
      console.error("[GeminiVision] Error finding element:", error);
      return { found: false };
    }
  }

  async analyzeHighlightedContent(
    highlightedImageBase64: string,
    userQuestion: string
  ): Promise<string> {
    try {
      const imagePart = { inlineData: { data: highlightedImageBase64, mimeType: "image/png" } };
      const prompt = `You are analyzing a highlighted/selected portion of a user's screen. The user asks: "${userQuestion}"

Please analyze the highlighted content and provide a helpful response. Consider:
- What type of content this appears to be (code, text, UI, error message, documentation, etc.)
- Answer the user's specific question about this content
- Provide clear, actionable information
- If it's code, explain what it does
- If it's an error, suggest how to fix it
- If it's documentation, summarize the key points

Be conversational and helpful in your response.`;

      const result = await this.geminiPro.generateContent([prompt, imagePart]);
      const response = result.response.text();
      console.log(`[GeminiVision] Highlight analysis complete`);
      return response;
    } catch (error) {
      console.error("[GeminiVision] Error analyzing highlighted content:", error);
      throw error;
    }
  }
}

export const geminiVision = new GeminiVisionService(); 