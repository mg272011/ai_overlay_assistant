import { GeminiVisionService } from './GeminiVisionService';
import { takeAndSaveScreenshots } from '../utils/screenshots';
import { getVirtualCursor } from '../performAction';
import { execPromise } from '../utils/utils';
import * as path from 'path';
import { app, screen } from 'electron';

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
  private visionService: GeminiVisionService;
  private maxRetries = 3;
  private screenshotDelay = 500; // ms to wait after actions before screenshot

  constructor() {
    this.visionService = new GeminiVisionService();
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

    // Step 2: Fall back to Gemini Vision
    console.log(`[AgentVision] Local OCR failed, using Gemini Vision...`);
    const screenshot = await this.takeScreenshot();
    if (!screenshot) {
      return { success: false, message: 'Failed to take screenshot' };
    }

    const prompt = context 
      ? `${context}. Find "${targetText}" and return its center coordinates.`
      : `Find the text or UI element labeled "${targetText}" on the screen. Return the center coordinates where it should be clicked.`;

    const visionResult = await this.visionService.analyzeScreenForElement(screenshot, prompt);
    
    if (visionResult.found && visionResult.x && visionResult.y) {
      console.log(`[AgentVision] Found via Gemini at (${visionResult.x}, ${visionResult.y})`);
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
   * Take a screenshot with consistent naming
   */
  private async takeScreenshot(): Promise<string | null> {
    try {
      const screenshots = await takeAndSaveScreenshots('Desktop', `agent-vision-${Date.now()}`);
      return screenshots?.[0] || null;
    } catch (error) {
      console.error('[AgentVision] Screenshot error:', error);
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

      const result = await this.visionService.analyzeScreenForElement(
        screenshot,
        `Is "${elementDescription}" visible on screen? Return its coordinates if found.`
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
   * Smart app opening with multiple strategies
   */
  async openApplication(appName: string): Promise<ActionResult> {
    console.log(`[AgentVision] Opening application: ${appName}`);
    
    // Strategy 1: Check if app is already open
    const isOpen = await this.isApplicationVisible(appName);
    if (isOpen) {
      return {
        success: true,
        message: `${appName} is already open`
      };
    }

    // Strategy 2: Try Spotlight
    const spotlightResult = await this.openViaSpotlight(appName);
    if (spotlightResult.success) {
      return spotlightResult;
    }

    // Strategy 3: Try Dock
    const dockResult = await this.openViaDock(appName);
    if (dockResult.success) {
      return dockResult;
    }

    // Strategy 4: Shell command fallback
    try {
      await execPromise(`open -a "${appName}"`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const nowOpen = await this.isApplicationVisible(appName);
      if (nowOpen) {
        return {
          success: true,
          message: `Opened ${appName} via shell command`
        };
      }
    } catch (error) {
      console.error(`[AgentVision] Shell open failed:`, error);
    }

    return {
      success: false,
      message: `Failed to open ${appName} using all strategies`
    };
  }

  private async isApplicationVisible(appName: string): Promise<boolean> {
    const screenshot = await this.takeScreenshot();
    if (!screenshot) return false;

    const result = await this.visionService.analyzeScreenForElement(
      screenshot,
      `Is the application "${appName}" currently visible on screen? Look for its window, title bar, or any UI elements that indicate it's open.`
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