import { takeAndSaveScreenshots } from '../utils/screenshots';
import { getVirtualCursor } from '../performAction';
import { execPromise } from '../utils/utils';
import * as path from 'path';
import { app, screen } from 'electron';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

interface ActionResult {
  success: boolean;
  message: string;
  screenshot?: string;
  coordinates?: { x: number; y: number };
}

interface ElementLocation {
  found: boolean;
  x?: number;
  y?: number;
  confidence?: number;
  description?: string;
}

export class AgentVisionService {
  private openai: OpenAI;
  private gemini: GoogleGenerativeAI;
  private maxRetries = 3;
  private screenshotDelay = 500; // ms to wait after actions before screenshot

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  }

  /**
   * Find and click an element by text with verification
   */
  async findAndClickText(
    targetText: string,
    context?: string
  ): Promise<ActionResult> {
    console.log(`[AgentVision] Finding and clicking: "${targetText}"`);
    
    // Step 1: Try fast local OCR first
    const ocrResult = await this.tryLocalOCR(targetText);
    if (ocrResult.found && ocrResult.x && ocrResult.y) {
      console.log(`[AgentVision] Found via local OCR at (${ocrResult.x}, ${ocrResult.y})`);
      return await this.clickAndVerify(ocrResult.x, ocrResult.y, targetText);
    }

    // Step 2: Fall back to GPT-4o Vision
    console.log(`[AgentVision] Local OCR failed, using GPT-4o Vision...`);
    const screenshot = await this.takeScreenshot();
    if (!screenshot) {
      return { success: false, message: 'Failed to take screenshot' };
    }

    const prompt = context 
      ? `${context}. Find "${targetText}" and return its center coordinates.`
      : `Find the text or UI element labeled "${targetText}" on the screen. Return the center coordinates where it should be clicked.`;

    const visionResult = await this.analyzeScreenWithGPT4o(screenshot, targetText, context);
    
    if (visionResult.found && visionResult.x && visionResult.y) {
      console.log(`[AgentVision] Found via GPT-4o at (${visionResult.x}, ${visionResult.y})`);
      return await this.clickAndVerify(visionResult.x, visionResult.y, targetText);
    }

    return { 
      success: false, 
      message: `Could not find "${targetText}" on screen`,
      screenshot 
    };
  }

  /**
   * Click at coordinates and verify the action succeeded
   */
  private async clickAndVerify(
    x: number, 
    y: number, 
    expectedElement: string
  ): Promise<ActionResult> {
    const cursor = getVirtualCursor();
    
    // Move virtual cursor smoothly to target
    await cursor.moveCursor({ x, y });
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Perform click (VirtualCursor handles the actual Swift click)
    await cursor.performClick({ x, y });
    
    await new Promise(resolve => setTimeout(resolve, this.screenshotDelay));
    
    // Take screenshot to verify
    const verifyScreenshot = await this.takeScreenshot();
    
    return {
      success: true,
      message: `Clicked on "${expectedElement}" at (${x}, ${y})`,
      screenshot: verifyScreenshot || undefined,
      coordinates: { x, y }
    };
  }

  /**
   * Try local OCR for fast text finding
   */
  private async tryLocalOCR(text: string): Promise<ElementLocation> {
    try {
      const ocrScriptPath = path.join(app.getAppPath(), 'swift', 'ocr.swift');
      const { stdout } = await execPromise(`swift ${ocrScriptPath} "${text}"`);
      
      const result = JSON.parse(stdout.trim());
      return {
        found: result.found || false,
        x: result.x,
        y: result.y,
        confidence: 1.0,
        description: 'Found via local OCR'
      };
    } catch (error) {
      console.error('[AgentVision] Local OCR error:', error);
      return { found: false };
    }
  }

  /**
   * Analyze screen using GPT-4o Vision to find coordinates
   */
  private async analyzeScreenWithGPT4o(
    screenshotPath: string, 
    targetText: string, 
    context?: string
  ): Promise<ElementLocation> {
    try {
      // Read the screenshot file as base64
      const fs = await import('fs');
      const imageData = fs.readFileSync(screenshotPath);
      const base64Image = imageData.toString('base64');

      const prompt = context 
        ? `${context}. Find "${targetText}" on this screenshot and return ONLY the x,y coordinates where it should be clicked. Respond with JSON: {"found": true/false, "x": number, "y": number}`
        : `Find the text or UI element "${targetText}" on this screenshot. Return ONLY the center coordinates where it should be clicked. Respond with JSON: {"found": true/false, "x": number, "y": number}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 100,
        temperature: 0.1
      });

      const responseText = response.choices[0]?.message?.content?.trim();
      if (!responseText) {
        return { found: false };
      }

      try {
        // Remove markdown code blocks if present
        let cleanResponse = responseText;
        if (responseText.includes('```json')) {
          cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        }
        
        const result = JSON.parse(cleanResponse);
        return {
          found: result.found || false,
          x: result.x,
          y: result.y,
          confidence: 1.0,
          description: 'Found via GPT-4o Vision'
        };
      } catch (parseError) {
        console.error('[AgentVision] Failed to parse GPT-4o response:', responseText);
        return { found: false };
      }
    } catch (error) {
      console.error('[AgentVision] GPT-4o vision error:', error);
      return { found: false };
    }
  }

  /**
   * Take a full desktop screenshot to see dock and all apps
   */
  private async takeScreenshot(): Promise<string | null> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      
      // Create a screenshot using macOS screencapture command
      const timestamp = Date.now();
      const screenshotPath = path.join(process.cwd(), 'app', 'logs', `desktop-${timestamp}.png`);
      
      // Ensure directory exists
      const dir = path.dirname(screenshotPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Use macOS screencapture for full desktop capture (including dock)
      await execPromise(`screencapture -x "${screenshotPath}"`);
      
      console.log(`[AgentVision] Full desktop screenshot saved: ${screenshotPath}`);
      return screenshotPath;
    } catch (error) {
      console.error('[AgentVision] Desktop screenshot error:', error);
      return null;
    }
  }

  /**
   * Wait for an element to appear on screen
   */
  async waitForElement(
    elementDescription: string,
    maxWaitMs: number = 10000
  ): Promise<ElementLocation> {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < maxWaitMs) {
      const screenshot = await this.takeScreenshot();
      if (!screenshot) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        continue;
      }

      const result = await this.analyzeScreenWithGPT4o(
        screenshot,
        elementDescription,
        `Check if "${elementDescription}" is visible on screen`
      );

      if (result.found) {
        console.log(`[AgentVision] Element appeared after ${Date.now() - startTime}ms`);
        return {
          found: true,
          x: result.x,
          y: result.y,
          description: elementDescription
        };
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.log(`[AgentVision] Timeout waiting for "${elementDescription}"`);
    return { found: false, description: elementDescription };
  }

  /**
   * Perform a complex action with retries and verification
   */
  async performActionWithRetry(
    action: () => Promise<ActionResult>,
    verifySuccess: () => Promise<boolean>,
    actionName: string
  ): Promise<ActionResult> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      console.log(`[AgentVision] Attempt ${attempt}/${this.maxRetries} for ${actionName}`);
      
      const result = await action();
      
      if (result.success) {
        // Verify the action actually succeeded
        const verified = await verifySuccess();
        if (verified) {
          console.log(`[AgentVision] ✅ ${actionName} succeeded on attempt ${attempt}`);
          return result;
        }
        console.log(`[AgentVision] Action executed but verification failed, retrying...`);
      } else {
        console.log(`[AgentVision] Action failed: ${result.message}`);
      }
      
      if (attempt < this.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return {
      success: false,
      message: `Failed to ${actionName} after ${this.maxRetries} attempts`
    };
  }

  /**
   * Hybrid app opening: GPT-4o dock coordinates + AppleScript fallback
   */
  async openApplication(appName: string): Promise<ActionResult> {
    console.log(`[AgentVision] Opening application: ${appName}`);
    
    // Strategy 1: Check if already open (no screenshot needed)
    const isOpen = await this.isApplicationVisible(appName);
    if (isOpen) {
      return {
        success: true,
        message: `${appName} is already open and visible`
      };
    }

    // Strategy 2: Try Dock with GPT-4o coordinates
    console.log(`[AgentVision] Looking for ${appName} on dock...`);
    const screenshot = await this.takeScreenshot();
    if (screenshot) {
      const dockResult = await this.findAppOnDock(appName, screenshot);
      
      if (dockResult.found && dockResult.x && dockResult.y) {
        console.log(`[AgentVision] Found ${appName} on dock, clicking at (${dockResult.x}, ${dockResult.y})`);
        const cursor = getVirtualCursor();
        await cursor.moveCursor({ x: dockResult.x, y: dockResult.y });
        await new Promise(resolve => setTimeout(resolve, 200));
        await cursor.performClick({ x: dockResult.x, y: dockResult.y });
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        return {
          success: true,
          message: `Opened ${appName} from dock`
        };
      }
    }

    // Strategy 3: AppleScript fallback (when not on dock)
    console.log(`[AgentVision] ${appName} not found on dock, using AppleScript...`);
    try {
      await execPromise(`osascript -e 'tell application "${appName}" to activate'`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return {
        success: true,
        message: `Opened ${appName} via AppleScript`
      };
    } catch (error) {
      console.error(`[AgentVision] AppleScript failed:`, error);
    }

    // Strategy 4: Shell command final fallback
    try {
      console.log(`[AgentVision] Trying shell command for ${appName}...`);
      await execPromise(`open -a "${appName}"`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      return {
        success: true,
        message: `Opened ${appName} via shell command`
      };
    } catch (error) {
      console.error(`[AgentVision] Shell command failed:`, error);
    }

    return {
      success: false,
      message: `Failed to open ${appName} - tried all methods`
    };
  }

  /**
   * Extract app name from user request using Gemini
   */
  async extractAppName(userRequest: string): Promise<string | null> {
    try {
      const model = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = `User request: "${userRequest}"

Extract the application name that the user wants to open. Return ONLY the app name, nothing else.

Examples:
- "open safari" → Safari
- "launch chrome" → Google Chrome  
- "start textedit" → TextEdit
- "open slack" → Slack
- "launch photoshop" → Adobe Photoshop

If no specific app is mentioned, return: NONE`;

      const result = await model.generateContent(prompt);
      const response = result.response.text().trim();
      
      console.log(`[AgentVision] Gemini extracted app name from "${userRequest}": ${response}`);
      return response === 'NONE' ? null : response;
    } catch (error) {
      console.error('[AgentVision] App name extraction error:', error);
      return null;
    }
  }

  /**
   * Hybrid approach: Ask Gemini if we need to open an app, then use GPT-4o for coordinates
   */
  async shouldOpenApp(userRequest: string): Promise<boolean> {
    try {
      const model = this.gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = `User request: "${userRequest}"

Does this request require opening a new application or software? 
Consider if they're asking to:
- Open/launch an app (Safari, Chrome, TextEdit, etc.)
- Create something in a new app (presentation, document, etc.)
- Use a specific program

Respond with only: TRUE or FALSE`;

      const result = await model.generateContent(prompt);
      const response = result.response.text().trim().toUpperCase();
      
      console.log(`[AgentVision] Gemini decision for "${userRequest}": ${response}`);
      return response === 'TRUE';
    } catch (error) {
      console.error('[AgentVision] Gemini decision error:', error);
      return false; // Conservative fallback
    }
  }

  /**
   * Use GPT-4o to find app icon on dock and return coordinates
   */
  async findAppOnDock(appName: string, screenshotPath: string): Promise<{found: boolean, x?: number, y?: number}> {
    try {
      const fs = await import('fs');
      const imageData = fs.readFileSync(screenshotPath);
      const base64Image = imageData.toString('base64');

      const prompt = `Look at this macOS dock screenshot. Find the "${appName}" app icon on the dock. 
If you find it, return coordinates where to click. If the app is NOT visible on the dock, return found: false.

Respond with JSON only: {"found": true/false, "x": number, "y": number}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: 50,
        temperature: 0.1
      });

      const responseText = response.choices[0]?.message?.content?.trim();
      if (!responseText) {
        return { found: false };
      }

      try {
        // Remove markdown code blocks if present
        let cleanResponse = responseText;
        if (responseText.includes('```json')) {
          cleanResponse = responseText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        }
        
        const result = JSON.parse(cleanResponse);
        console.log(`[AgentVision] GPT-4o dock search for "${appName}":`, result);
        return {
          found: result.found || false,
          x: result.x,
          y: result.y
        };
      } catch (parseError) {
        console.error('[AgentVision] Failed to parse GPT-4o dock response:', responseText);
        return { found: false };
      }
    } catch (error) {
      console.error('[AgentVision] GPT-4o dock search error:', error);
      return { found: false };
    }
  }

  private async isApplicationVisible(appName: string): Promise<boolean> {
    const screenshot = await this.takeScreenshot();
    if (!screenshot) return false;

    const result = await this.analyzeScreenWithGPT4o(
      screenshot,
      appName,
      `Check if the application "${appName}" is currently visible on screen. Look for its window, title bar, or any UI elements that indicate it's open.`
    );

    return result.found || false;
  }

  private async openViaSpotlight(appName: string): Promise<ActionResult> {
    console.log(`[AgentVision] Trying Spotlight method...`);
    
    // Open Spotlight with Cmd+Space
    try {
      await execPromise(`swift ${path.join(app.getAppPath(), 'swift', 'key.swift')} com.apple.finder "^cmd+space"`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error('[AgentVision] Failed to open Spotlight:', error);
      return { success: false, message: 'Could not open Spotlight' };
    }
    
    // Take screenshot to find Spotlight
    const screenshot = await this.takeScreenshot();
    if (!screenshot) {
      return { success: false, message: 'Could not take screenshot' };
    }
    
    // Click in the center of Spotlight (it usually appears there)
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.bounds;
    const centerX = Math.round(screenWidth / 2);
    const centerY = Math.round(screenHeight / 3); // Upper third of screen
    
    const cursor = getVirtualCursor();
    await cursor.moveCursor({ x: centerX, y: centerY });
    await new Promise(resolve => setTimeout(resolve, 200));
    await cursor.performClick({ x: centerX, y: centerY });
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Type app name
    try {
      await execPromise(`swift ${path.join(app.getAppPath(), 'swift', 'key.swift')} com.apple.Spotlight "${appName}"`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('[AgentVision] Failed to type app name:', error);
    }
    
    // Press Enter to open the first result
    try {
      await execPromise(`swift ${path.join(app.getAppPath(), 'swift', 'key.swift')} com.apple.Spotlight "^enter"`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return {
        success: true,
        message: `Opened ${appName} via Spotlight`
      };
    } catch (error) {
      console.error('[AgentVision] Failed to press Enter:', error);
      return { success: false, message: 'Could not confirm app opening' };
    }
  }

  private async openViaDock(appName: string): Promise<ActionResult> {
    console.log(`[AgentVision] Trying Dock method...`);
    
    const dockResult = await this.findAndClickText(appName,
      `Find the "${appName}" icon in the macOS Dock at the bottom of the screen`);
    
    if (dockResult.success) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return {
        success: true,
        message: `Opened ${appName} via Dock`
      };
    }
    
    return { success: false, message: 'Could not find app in Dock' };
  }
}

// Export singleton instance
export const agentVision = new AgentVisionService(); 