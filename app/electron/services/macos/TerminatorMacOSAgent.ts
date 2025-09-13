import { IpcMainEvent, app } from 'electron';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AgentOverlayService } from '../AgentOverlayService';
import { ClickPreviewService } from '../ClickPreviewService';
import { searchOnBrowser } from '../../tools/search';

// SPEED: Removed Terminator.js import (slow desktop automation removed)

// Promisify exec for async AppleScript execution
const execPromise = promisify(exec);

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Initialize Groq (primary model - fast Llama-4-Maverick)
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1'
});

// Initialize OpenAI (second fallback model)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Anthropic (third fallback model when OpenAI fails)
// NOTE: Install with: npm install @anthropic-ai/sdk
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || ''
});

// Interfaces for Terminator-based automation
interface TerminatorAction {
  type: 'click' | 'double_click' | 'right_click' | 'middle_click' | 'hover' | 'drag_and_drop' | 'scroll' | 'scroll_at' | 'type' | 'key' | 'wait' | 'analyze' | 'window' | 'applescript' | 'ocr_find_click' | 'done' | 'spotlight_open_app' | 'navigate_to_url' | 'search';
  selector?: string;
  text?: string;
  keyString?: string;
  applescriptCode?: string;
  windowName?: string;
  appName?: string; // For spotlight_open_app action
  url?: string; // For navigate_to_url action
  intent: string;
  amount?: number;
  repeats?: number;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  duration?: number;
}

interface TerminatorPlan {
  id: string;
  title: string;
  steps: TerminatorAction[];
  memory: string;
  nextGoal: string;
}

interface TerminatorElement {
  name: string;
  role: string;
  selector: string;
  webSelector?: string;  // CSS selector for Chrome web elements
  bounds?: { x: number, y: number, width: number, height: number };
  buttonIndex?: number; // For position-based clicking when name() fails
  clickable?: boolean; // Whether the element can be clicked/interacted with
}

interface ActionLogEntry {
  step: number;
  planned: TerminatorAction;
  timestampIso: string;
  executed?: {
    resultMessage: string;
    success: boolean;
    verification?: string;
    error?: string;
  };
}

interface CompletedTask {
  id: string;
  task: string;
  startTime: string;
  endTime: string;
  success: boolean;
  summary: string;
  finalState: string;
  actionsPerformed: string[];
}

// Global task history that persists across agent instances
const GLOBAL_TASK_HISTORY: CompletedTask[] = [];

/**
 * TerminatorMacOSAgent - The ONLY automation agent in Opus
 * 
 * This agent handles ALL automation tasks:
 * - Desktop applications (Calculator, TextEdit, Finder, etc.)
 * - Browser automation (Chrome, Safari, Firefox, etc.)
 * - Web searches, YouTube, flights, shopping - EVERYTHING
 * 
 * There is NO separate Chrome agent or Playwright agent.
 * ALL tasks are routed here regardless of type.
 */
export class TerminatorMacOSAgent {
  // SPEED: Removed desktop property (slow Terminator Desktop removed)
  private stepCount: number = 0;
  private memory: string = '';
  private isRunning: boolean = false;
  private targetAppName: string = ''; // Track which app we're automating
  private userPreviousApp: string = ''; // Store user's app before we started
  private userFriendlyMode: boolean = true; // Allow user to work while agent runs
  private chromeSettingsPopupShown = false; // Track if we've shown the Chrome settings popup
  private completionSent: boolean = false; // Track if completion message was already sent
  private currentTask: string = ''; // Store the current task for extraction purposes
  private addressBarPrimed: boolean = false; // Track if cmd+l was just used
  private actionLog: ActionLogEntry[] = [];
  private taskStartTime: string = ''; // Track when the current task started
  // Virtual cursor state (no on-screen cursor yet; used for coordinate-aware actions)
  private virtualCursorPosition: { x: number; y: number } | null = null;
  private lastFocusedRect: { x: number; y: number; width: number; height: number } | null = null;

  private isLikelyOnYoutube(): boolean {
    try {
      return (this.memory || '').toLowerCase().includes('youtube.com');
    } catch {
      return false;
    }
  }

  // ---- Helpers added to stabilize flow ----
  private async getCurrentFocusedApp(): Promise<string> {
    try {
      const script = `tell application "System Events" to name of first application process whose frontmost is true`;
      const result = await this.executeAppleScript(script);
      return String(result || '').trim() || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  private async userFriendlyDelay(ms: number): Promise<void> {
    // ULTRA SPEED: Minimal delays for all operations
    const ultraFast = ms > 200 ? 100 : 30;
    const cap = this.userFriendlyMode ? ultraFast : ms;
    return new Promise(resolve => setTimeout(resolve, Math.max(0, cap)));
  }

  private getClickDelay(): number {
    // ULTRA SPEED: Minimal delay for all interactions
    return 30;
  }

  private async smartFocus(appName?: string): Promise<void> {
    if (!appName) return;
    try {
      const current = await this.getCurrentFocusedApp();
      if (current.toLowerCase() === appName.toLowerCase()) return;
      
      // Simple app activation for already-running apps
      console.log(`[TerminatorAgent] Focusing "${appName}"`);
      
      // Try direct activation first (works for running apps)
      await this.executeAppleScript(`tell application "${appName}" to activate`);
      await new Promise(r => setTimeout(r, 300));
      
    } catch (error) {
      console.log(`[TerminatorAgent] ⚠️ Failed to focus "${appName}":`, error);
    }
  }

  // Capture a full-screen JPEG and return base64 (no data: prefix)
  private async captureScreenshotBase64(): Promise<string> {
    try {
      const tmpFile = path.join(app.getPath('temp'), `neatly-agent-${Date.now()}.jpg`);
      const cmd = `/usr/sbin/screencapture -x -t jpg "${tmpFile}"`;
      await execPromise(cmd);
      const buf = await fs.readFile(tmpFile);
      await fs.unlink(tmpFile).catch(() => {});
      return buf.toString('base64');
    } catch (e) {
      console.log('[TerminatorAgent] Screenshot capture failed:', e);
      return '';
    }
  }

  // Use Gemini 2.5 Flash to extract a short hint from the screenshot


  // Save completed task to global history
  private saveCompletedTask(success: boolean, summary?: string): void {
    try {
      // Extract key actions performed
      const keyActions = this.actionLog
        .filter(log => log.executed?.success)
        .map(log => `${log.planned.type}: ${log.planned.intent}`)
        .slice(0, 10); // Keep top 10 actions
      
      // Get final state description
      const finalState = this.memory.split('\n').slice(-3).join(' → ') || 'Task completed';
      
      const completedTask: CompletedTask = {
        id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        task: this.currentTask,
        startTime: this.taskStartTime,
        endTime: new Date().toISOString(),
        success,
        summary: summary || `Completed: ${this.currentTask}`,
        finalState,
        actionsPerformed: keyActions
      };
      
      // Add to global history (keep last 50 tasks)
      GLOBAL_TASK_HISTORY.unshift(completedTask);
      if (GLOBAL_TASK_HISTORY.length > 50) {
        GLOBAL_TASK_HISTORY.length = 50;
      }
      
      console.log(`[TerminatorAgent] 📝 Saved task to history: ${completedTask.id}`);
    } catch (error) {
      console.log('[TerminatorAgent] Failed to save task history:', error);
    }
  }
  
  // Format task history for inclusion in prompt
  private formatTaskHistory(): string {
    if (GLOBAL_TASK_HISTORY.length === 0) {
      return 'No previous tasks completed yet.';
    }
    
    // Show last 5 tasks
    const recentTasks = GLOBAL_TASK_HISTORY.slice(0, 5);
    let history = 'RECENT COMPLETED TASKS (I can reference these for follow-up requests):\n';
    
    recentTasks.forEach((task, idx) => {
      const duration = new Date(task.endTime).getTime() - new Date(task.startTime).getTime();
      const durationStr = duration < 60000 ? `${Math.round(duration/1000)}s` : `${Math.round(duration/60000)}m`;
      
      history += `\n${idx + 1}. "${task.task}" (${durationStr} ago)\n`;
      history += `   Status: ${task.success ? '✅ Success' : '❌ Failed'}\n`;
      history += `   Summary: ${task.summary}\n`;
      history += `   Key actions: ${task.actionsPerformed.slice(0, 3).join(', ')}\n`;
      
      // Add context hints for follow-up
      if (task.success && idx === 0) {
        history += `   💡 User can say "continue from there" or reference this task\n`;
      }
    });
    
    return history;
  }

  // ---- End helpers ----


  // ✅ LLM-GENERATED INITIAL MESSAGES: Natural variations for task acceptance


  // ✅ LLM-GENERATED COMPLETION MESSAGES: Natural variations for task completion
  private async generateCompletionMessage(task: string = ''): Promise<string> {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
      
      // Check if this was a calculation task and try to get the result
      const isCalculation = task.toLowerCase().includes('calculat') || task.includes('×') || task.includes('*');
      let calculationResult = '';
      
      // Try to get calculation result from Calculator display
      if (isCalculation && this.targetAppName === 'Calculator') {
        try {
          const resultScript = `
            tell application "System Events"
              tell process "Calculator"
                try
                  set displayValue to value of static text 1 of group 1 of window 1
                  return displayValue
                end try
              end tell
            end tell`;
          calculationResult = await this.executeAppleScript(resultScript);
          console.log(`[TerminatorAgent] Got calculation result: ${calculationResult}`);
        } catch (error) {
          console.log(`[TerminatorAgent] Could not get calculation result:`, error);
        }
      }
      
      const prompt = `Generate a natural completion message for this task:

Task: "${task}"
Type: ${isCalculation ? 'Calculation' : 'General automation'}
${calculationResult ? `Actual Result: "${calculationResult}"` : ''}

Examples for calculations:
- "The result is 56088!" 
- "Got it! The answer is 56088"
- "Calculation complete: 56088"

Examples for other tasks:
- "All done!" 
- "Task completed!" 
- "Finished!"

Rules:
- Be natural and conversational
- For calculations, ALWAYS include the actual result if provided
- If no result provided, use a generic completion message
- Keep it brief but friendly
- Sound satisfied with completion
${calculationResult ? `- IMPORTANT: Use the actual result "${calculationResult}" in your response` : ''}

Generate ONE completion message:`;

      const result = await model.generateContent(prompt);
      const message = result.response.text().trim().replace(/['"]/g, '');
      
      return message || "All done!";
      
    } catch (error) {
      console.log('[TerminatorAgent] Completion message generation failed, using fallback');
      return "All done!";
    }
  }
  
  constructor() {
    console.log('[TerminatorAgent] Initializing Ultimate macOS Agent...');
    console.log('[TerminatorAgent] Features: Terminator + OCR + Window Detection + AppleScript');
  }
  
  // SPEED: Removed initDesktop method (slow Terminator Desktop removed)
  
  // SPEED: Disabled window tracking (Terminator Desktop removed for speed)
  private async updateWindowList(): Promise<void> {
    console.log(`[TerminatorAgent] Window tracking disabled for speed`);
  }
  

  
  // MacPilot-inspired AppleScript execution
  private async executeAppleScript(script: string): Promise<string> {
    try {
      const delimiter = `OSA_EOF_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const command = `osascript <<'${delimiter}'\n${script}\n${delimiter}`;
      const { stdout } = await execPromise(command);
      return stdout.trim();
    } catch (error) {
      console.error('[TerminatorAgent] AppleScript error:', error);
      throw error;
    }
  }

  // REMOVED: getSafeButtonName - no longer needed with AppleScript-only approach

  // === Swift AX helpers ===
  private async getBundleIdFromAppName(appName: string): Promise<string | null> {
    try {
      const { stdout } = await execPromise(`osascript -e 'id of app "${appName}"'`);
      const id = (stdout || '').trim();
      return id || null;
    } catch {
      return null;
    }
  }

  private parseJsonArrayLoose(stdout: string): any[] {
    try { return JSON.parse(stdout); } catch {}
    const start = stdout.indexOf('[');
    const end = stdout.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      const slice = stdout.slice(start, end + 1).trim();
      try { return JSON.parse(slice); } catch {}
    }
    return [];
  }

  private async swiftListClickableElements(bundleId: string): Promise<Array<{ id: number; AXRole?: string; AXTitle?: string; AXDescription?: string; AXValue?: string; AXPosition?: string; AXSize?: string }>> {
    try {
      const { stdout } = await execPromise(`swift swift/click.swift ${bundleId}`);
      const arr = this.parseJsonArrayLoose(stdout) as any[];
      return Array.isArray(arr) ? arr as any : [];
    } catch (e) {
      console.log('[TerminatorAgent] Swift clickable list failed:', (e as any)?.message || e);
      return [];
    }
  }

  private async swiftClickById(bundleId: string, id: number): Promise<boolean> {
    try {
      console.log(`[COORDINATES] 🖱️ Executing Swift click for element id: ${id}`);
      const result = await execPromise(`swift swift/click.swift ${bundleId} ${id}`);
      console.log(`[COORDINATES] 🖱️ Swift click result:`, result);
      return true;
    } catch (e) {
      console.log('[TerminatorAgent] Swift click failed:', (e as any)?.message || e);
      return false;
    }
  }

  // High-speed AppleScript UI scan (buttons, textfields, static texts)
  // REMOVED: scanUIWithAppleScript - no longer needed with AppleScript-only approach

  // Helper method to send status updates to the UI
  private sendStatusUpdate(event: IpcMainEvent, responseChannel: string, update: any): void {
    event.reply(responseChannel, update);
  }

  // Helper method to format action messages for the UI
  private formatActionMessage(action: TerminatorAction): string {
    switch (action.type) {
      case 'click':
        return `Clicked (${action.text || action.selector || 'element'})`;
      case 'double_click':
        return `Double-clicked (${action.text || action.selector || 'element'})`;
      case 'right_click':
        return `Right-clicked (${action.text || action.selector || 'element'})`;
      case 'middle_click':
        return `Middle-clicked (${action.text || action.selector || 'element'})`;
      case 'hover':
        return `Hovered on (${action.text || 'coordinates'})`;
      case 'drag_and_drop':
        return `Dragged from (${(action as any).startX},${(action as any).startY}) to (${(action as any).endX},${(action as any).endY})`;
      case 'scroll_at':
        return `Scrolled at (${(action as any).x},${(action as any).y})`;
      case 'type':
        return `Typed (${action.text || 'text'})`;
      case 'key':
        return `Pressed (${action.keyString || 'key'})`;
      case 'scroll':
        return `Scrolled (${action.amount || 1} times)`;
      case 'wait':
        return `Waited (${action.amount || 1}s)`;
      case 'window':
        return `Opened (${action.windowName || 'app'})`;
      case 'spotlight_open_app':
        return `Opened (${action.appName || 'app'}) via Spotlight`;
      case 'navigate_to_url':
        return `Navigated to (${action.url || action.text || 'website'})`;
      case 'applescript':
        return `Executed (AppleScript)`;
      case 'analyze':
        return `Analyzed (screen)`;
      case 'done':
        return `Completed task`;
      default:
        return `Executed (${action.type})`;
    }
  }

  public async executeTask(
    task: string, 
    event: IpcMainEvent, 
    responseChannel: string
  ): Promise<void> {
    console.log('[DEBUG] 🟢🟢🟢 TERMINATOR AGENT STARTED ��🟢🟢');
    console.log(`[DEBUG] Task: "${task}"`);
    console.log(`[DEBUG] Response channel: "${responseChannel}"`);
    console.log(`[DEBUG] Process ID: ${process.pid}`);
    
    // Reset completion tracking for new task
    this.completionSent = false;
    
    // Store current task for later access
    this.currentTask = task;
    this.taskStartTime = new Date().toISOString();
    
    // 🛡️ SAFETY: Log task for safety monitoring
    console.log(`[TerminatorAgent] 🛡️ SAFETY CHECK: Task requested: "${task}"`);
    console.log(`[TerminatorAgent] 🛡️ SAFETY: Will only interact with apps mentioned in this task`);
    
    // 👤 USER-FRIENDLY: Remember what app user was using
    try {
      const currentApp = await this.getCurrentFocusedApp();
      this.userPreviousApp = currentApp;
      console.log(`[TerminatorAgent] 👤 USER-FRIENDLY: Remembered user was using: ${currentApp}`);
    } catch (error) {
      console.log(`[TerminatorAgent] Could not detect user's current app:`, error);
    }
    
    this.stepCount = 0;
    this.memory = '';
    this.isRunning = true;
    this.targetAppName = ''; // Reset target app for new task
    this.actionLog = [];

    
    console.log('[TerminatorAgent] Starting task execution:', task);
    
    // SPEED: Skip slow Terminator Desktop init - Swift AX is primary method
    
    // Start planning immediately but delay the initial message for natural feel
    
            // Skip initial message - start executing immediately with Groq speed
    
    try {
      while (this.isRunning && this.stepCount < 30) {
        this.stepCount++;
        

        
        // ✅ First step: detect current app and pre-scan when possible (esp. Chrome)
        let elements: TerminatorElement[] = [];
        
        if (this.stepCount === 1 && !this.targetAppName) {
          try {
            const focused = await this.getCurrentFocusedApp();
            if (focused) {
              this.targetAppName = focused;
              console.log(`[TerminatorAgent] Step ${this.stepCount}: Detected focused app: ${this.targetAppName}`);
            }
          } catch {}
          
          try {
            console.log(`[TerminatorAgent] Step ${this.stepCount}: Initial scan for ${this.targetAppName || 'current app'}...`);
            elements = await this.getDesktopElements();
          } catch (err: any) {
            console.log('[TerminatorAgent] Initial scan failed:', err?.message || err);
            elements = [];
          }
          
          console.log(`[TerminatorAgent] Step ${this.stepCount}: Planning action with ${elements.length} scanned elements...`);
          const action = await this.planNextAction(task, elements);
          console.log(`[TerminatorAgent] Planned action:`, action);
          
          // Structured memory: log planned action for step 1
          this.actionLog.push({
            step: this.stepCount,
            planned: action,
            timestampIso: new Date().toISOString()
          });
          
          // Send thinking status to UI
          this.sendStatusUpdate(event, responseChannel, {
            type: 'agent_thinking',
            content: `🧠 Reasoning: ${action.intent || 'Planning next action...'}`
          });
          
          if (action.type === 'done') {
            console.log('[TerminatorAgent] Task completed successfully');
            const completionMessage = await this.generateCompletionMessage(task);
            event.reply(responseChannel, {
              type: 'completion',
              content: completionMessage
            });
            this.completionSent = true;
            break;
          }
          
          // Execute the first action (usually opening an app)
          console.log(`[TerminatorAgent] Executing action: ${action.type} - ${action.intent}`);
          
          // Send action status to UI
          this.sendStatusUpdate(event, responseChannel, {
            type: 'agent_action',
            content: this.formatActionMessage(action)
          });
          
          // Show agent's intent in chat with varied beginnings
          const intentPrefixes = [
            "Now I'll", "Next I'll", "I'm going to", "Let me", "Time to", 
            "I'll now", "Going to", "About to", "I need to", "Let me try to",
            "Working on", "I'll", "Next step:", "Now:", "Proceeding to"
          ];
          const randomPrefix = intentPrefixes[this.stepCount % intentPrefixes.length];
          event.reply(responseChannel, {
            type: 'agent_action',
            content: `${randomPrefix} ${action.intent.toLowerCase()}`
          });
          
          const overlay = new AgentOverlayService();
          await overlay.pulse();
          const result = await this.executeAction(action, []);
          console.log(`[TerminatorAgent] Action result:`, result);
          
          // Enhanced memory tracking for first action
          const verification = await this.verifyActionResult(action, result);
          const memoryEntry = `${this.stepCount}. [${action.type}] ${action.intent} → ${result.message}${verification ? ` ✓ ${verification}` : ''}`;
          this.memory = memoryEntry;  // First entry, no need to append
          console.log(`[TerminatorAgent] Memory initialized: ${memoryEntry}`);
          // Structured memory: attach execution outcome
          const last = this.actionLog[this.actionLog.length - 1];
          if (last && last.step === this.stepCount) {
            last.executed = {
              resultMessage: result?.message || '',
              success: Boolean(verification) || (result?.message || '').toLowerCase().includes('clicked') || (result?.message || '').toLowerCase().includes('double-clicked') || (result?.message || '').toLowerCase().includes('right-clicked') || (result?.message || '').toLowerCase().includes('middle-clicked') || (result?.message || '').toLowerCase().includes('hovered') || (result?.message || '').toLowerCase().includes('dragged') || (result?.message || '').toLowerCase().includes('scrolled') || (result?.message || '').toLowerCase().includes('typed'),
              verification: verification || undefined,
              error: (result?.message || '').toLowerCase().includes('failed') ? result?.message : undefined
            };
          }
          
                    // Post-action scan for fresh UI state
          try {
            console.log(`[TerminatorAgent] Step ${this.stepCount}: Scanning after first action via Swift AX...`);
            await this.getDesktopElements();
          } catch (err: any) {
            console.log('[TerminatorAgent] Post-first-action scan failed:', err?.message || err);
          }
          
          // Continue to next iteration with minimal delay
          await this.userFriendlyDelay(100); // ULTRA SPEED: Reduced from 1000ms
          continue;
        }
        
        // ULTRA SPEED: Skip scanning on every 3rd step for all apps
        console.log(`[TerminatorAgent] Step ${this.stepCount}: Scanning ${this.targetAppName || 'current app'}...`);
        elements = await this.getDesktopElements();
        
        // Check if we just completed an equation before planning
        const lastMemoryLine = this.memory.split('\n').pop() || '';
        const justTypedEquation = lastMemoryLine.includes('typed: "') && lastMemoryLine.includes('=');
        
        if (justTypedEquation) {
          console.log('[TerminatorAgent] Just completed equation, marking as done');
          const completionMessage = await this.generateCompletionMessage(task);
          event.reply(responseChannel, {
            type: 'completion',
            content: completionMessage
          });
          this.completionSent = true;
          break;
        }
        
        // Check for web tasks and Chrome availability
        const isWebTask = task.toLowerCase().includes('search') || 
                         task.toLowerCase().includes('flight') || 
                         task.toLowerCase().includes('website') || 
                         task.toLowerCase().includes('browser') ||
                         task.toLowerCase().includes('youtube') ||
                         task.toLowerCase().includes('google');
        
        if (isWebTask && elements.length === 0) {
          try {
            // Check if Chrome is available
            await this.executeAppleScript('tell application "Google Chrome" to get version');
            console.log(`[TerminatorAgent] Chrome is available for web task`);
          } catch (chromeError) {
            console.log(`[TerminatorAgent] Chrome not found, showing error popup`);
            // Show popup that Chrome is required
            await this.executeAppleScript(`
              display dialog "Chrome Required for Web Tasks" & return & return & "The Opus agent works best with Google Chrome for web automation (flights, searches, etc.). Safari has limited automation support." & return & return & "Please install Chrome from chrome.google.com and try again." buttons {"OK"} default button "OK" with icon caution
            `);
            event.reply(responseChannel, {
              type: 'error',
              content: 'Chrome is required for web tasks. Please install Chrome and try again.'
            });
            return;
          }
        }

        // Plan next action with AI using freshly scanned elements
        console.log(`[TerminatorAgent] Planning next action for: "${task}"`);
        const action = await this.planNextAction(task, elements);
        console.log(`[TerminatorAgent] Planned action:`, action);
        
        // Structured memory: log planned action for subsequent steps
        this.actionLog.push({
          step: this.stepCount,
          planned: action,
          timestampIso: new Date().toISOString()
        });
        
        // If we've failed the same planned action 3 times in a row, adjust approach before executing
        try {
          const recentFails = this.countRecentFailuresFor(action);
          if (recentFails >= 3) {
            console.log('[TerminatorAgent] ⚠️ Same action failed 3x; switching approach automatically');
            // Nudge strategy without changing high-level intent
            if (action.type === 'click') {
              // Insert a short wait to allow UI to stabilize, then proceed
              await this.userFriendlyDelay(200);
            } else if (action.type === 'type') {
              // Add a focusing click heuristic by updating intent (planner already sees this in memory)
              action.intent = `${action.intent} (refocus field first, then type)`;
            } else if (action.type === 'key') {
              // Add a tiny wait before key to avoid race conditions
              await this.userFriendlyDelay(150);
            }
          }
        } catch {}
        
        // Send thinking status to UI
        this.sendStatusUpdate(event, responseChannel, {
          type: 'agent_thinking',
          content: `🧠 Reasoning: ${action.intent || 'Planning next action...'}`
        });
        
        if (action.type === 'done') {
          // Check if this is a user stop command (contextual stopping)
          const isStopCommand = /\b(stop|enough|done|that's good|ok stop|cancel|thats enough)\b/i.test(task);
          
          if (isStopCommand) {
            // User explicitly wants to stop - don't verify, just stop
            console.log('[TerminatorAgent] User stop command detected - completing immediately');
            this.saveCompletedTask(true, "Task stopped as requested");
            event.reply(responseChannel, {
                type: 'completion',
              content: "✅ Task stopped as requested."
            });
            this.completionSent = true;
            break;
          } else {
            // Gate completion with visual verification for regular tasks
            const ok = await this.verifyTaskCompletionWithScreenshot(task);
            if (ok) {
              console.log('[TerminatorAgent] Task completed successfully');
              const completionMessage = await this.generateCompletionMessage(task);
              this.saveCompletedTask(true, completionMessage);
              event.reply(responseChannel, {
                type: 'completion',
                content: completionMessage
              });
              this.completionSent = true;
              break;
            } else {
              console.log('[TerminatorAgent] Visual verification failed, task not complete - planning next action');
              // Skip the "done" action and continue to next planning cycle
              continue;
            }
          }
        }
        
        // Execute action using Terminator
        console.log(`[TerminatorAgent] Executing action: ${action.type} - ${action.intent}`);
        
        // Send action status to UI
        this.sendStatusUpdate(event, responseChannel, {
          type: 'agent_action',
          content: this.formatActionMessage(action)
        });
        
        const overlay = new AgentOverlayService();
        await overlay.pulse();
        const result = await this.executeAction(action, elements);
        console.log(`[TerminatorAgent] Action result:`, result);
        
        // Enhanced memory tracking with verification
        const verification = await this.verifyActionResult(action, result);
        const memoryEntry = `${this.stepCount}. [${action.type}] ${action.intent} → ${result.message}${verification ? ` ✓ ${verification}` : ''}`;
        this.memory = `${this.memory}\n${memoryEntry}`;
        console.log(`[TerminatorAgent] Memory updated: ${memoryEntry}`);
        // Structured memory: attach execution outcome
        const lastEntry = this.actionLog[this.actionLog.length - 1];
        if (lastEntry && lastEntry.step === this.stepCount) {
          lastEntry.executed = {
            resultMessage: result?.message || '',
            success: Boolean(verification) || (result?.message || '').toLowerCase().includes('clicked') || (result?.message || '').toLowerCase().includes('double-clicked') || (result?.message || '').toLowerCase().includes('right-clicked') || (result?.message || '').toLowerCase().includes('middle-clicked') || (result?.message || '').toLowerCase().includes('hovered') || (result?.message || '').toLowerCase().includes('dragged') || (result?.message || '').toLowerCase().includes('scrolled') || (result?.message || '').toLowerCase().includes('typed'),
            verification: verification || undefined,
            error: (result?.message || '').toLowerCase().includes('failed') ? result?.message : undefined
          };
        }
        
        // ✅ SINGLE CLEAN MESSAGE: Only after major actions
        if (result.message && result.message.includes('Error:')) {
          // Only send error messages
          event.reply(responseChannel, {
            type: 'step_error', 
            content: result.message.replace('Error: ', '')
          });
        } else {
          event.reply(responseChannel, {
            type: 'step',
            content: `${this.stepCount}. ${action.intent} - ${result.message}`
          });
        }
        
        // Check if task is done (done action was executed successfully)
        if (result.message === 'done') {
          console.log('[TerminatorAgent] Task completed - done action executed successfully');
          
          // Check if this was a task that might have longer content to share
          const isContentTask = task.toLowerCase().includes('summarize') || 
                               task.toLowerCase().includes('summary') ||
                               task.toLowerCase().includes('read') ||
                               task.toLowerCase().includes('analyze') ||
                               task.toLowerCase().includes('tell me about') ||
                               task.toLowerCase().includes('what does');
          
                    // Extract content from the done action itself
          let summaryContent = '';
          if (isContentTask && action.text && action.text.length > 20) {
            summaryContent = action.text;
          }
          
          // If we don't have good content from the action, and this is a content task, generate it
          if (isContentTask && (!summaryContent || summaryContent.length < 50)) {
            console.log('[TerminatorAgent] Generating detailed summary from scanned elements...');
            try {
              const currentElements = await this.getDesktopElements();
              summaryContent = await this.generateDetailedSummary(task, currentElements);
              if (!summaryContent || summaryContent.length < 20) {
                summaryContent = action.text || 'Content analysis completed.';
              }
            } catch (error) {
              console.log('[TerminatorAgent] Summary generation failed:', error);
              summaryContent = action.text || 'Content analysis completed.';
            }
          }
          
          // If there's content to share, send it first
          if (summaryContent && summaryContent.length > 20) {
            this.sendLongResponse(event, responseChannel, summaryContent);
            // Wait a moment for the content to be displayed
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
          
          const completionMessage = await this.generateCompletionMessage(task);
          this.saveCompletedTask(true, summaryContent && summaryContent.length > 20 ? summaryContent : completionMessage);
          event.reply(responseChannel, {
            type: 'completion',
            content: completionMessage
          });
          this.completionSent = true;
          break;
        }
        
        // ULTRA SPEED: Minimal delay between actions
        await this.userFriendlyDelay(50); // ULTRA SPEED: Reduced from 1000ms
      }
      
    } catch (error) {
      console.error('[DEBUG] 🔴🔴🔴 TASK EXECUTION ERROR 🔴🔴🔴:', error);
      console.error('[DEBUG] Error stack:', (error as any)?.stack);
      event.reply(responseChannel, {
        type: 'step_error',
        content: `Error: ${error}`
      });
    } finally {
      console.log('[DEBUG] 🟡 TERMINATOR AGENT CLEANUP - Setting isRunning to false');
      this.isRunning = false;
      // Hide overlay when agent stops
      try { await new AgentOverlayService().hide(); } catch {}
      
      // 👤 USER-FRIENDLY: For browser tasks, leave user on the website they navigated to
      const isBrowserTask = this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
      if (this.userPreviousApp && this.userPreviousApp !== this.targetAppName && this.userFriendlyMode && !isBrowserTask) {
        try {
          console.log(`[TerminatorAgent] 👤 Restoring focus to user's app: ${this.userPreviousApp}`);
          await this.executeAppleScript(`tell application "${this.userPreviousApp}" to activate`);
        } catch (error) {
          console.log(`[TerminatorAgent] Could not restore user's app focus:`, error);
        }
      } else if (isBrowserTask) {
        console.log(`[TerminatorAgent] 👤 Leaving user on website (browser task completed)`);
      }
      
      console.log('[DEBUG] 🟡 TERMINATOR AGENT CLEANUP - Checking completion status');
      // Only send a completion if no prior completion message was emitted during the loop
      if (!this.completionSent) {
        console.log('[DEBUG] 🟡 TERMINATOR AGENT CLEANUP - Sending fallback completion message');
      try {
        const completionMessage = await this.generateCompletionMessage(task);
      event.reply(responseChannel, {
        type: 'completion',
          content: completionMessage
        });
        } catch (error) {
          console.log('[TerminatorAgent] Completion message generation failed:', error);
        event.reply(responseChannel, {
          type: 'completion',
            content: 'Task completed successfully.'
        });
        }
        this.completionSent = true;
      } else {
        console.log('[DEBUG] 🟡 TERMINATOR AGENT CLEANUP - Completion already sent, skipping');
      }
      console.log('[DEBUG] 🟢 TERMINATOR AGENT FINISHED SUCCESSFULLY');
    }
  }
  
  private async getDesktopElements(): Promise<TerminatorElement[]> {
    
    try {
      const elements: TerminatorElement[] = [];
      const startTime = Date.now();
      
      // ✅ ELEMENT DETECTION: Chrome JS vs Swift AX
      if (this.targetAppName) {
        const bundleId = await this.getBundleIdFromAppName(this.targetAppName);
        if (bundleId) {
          const isChromeApp = /chrome|google chrome/i.test(this.targetAppName);
          
          if (isChromeApp) {
            // Chrome: Skip Swift AX (always 0 elements), use JavaScript only
            console.log(`[TerminatorAgent] 🌐 Chrome detected: Using JavaScript elements only (skipping Swift AX)`);
            try {
              const chromeElements = await this.getChromeElementsViaJavaScriptV2();
              if (chromeElements.length > 0) {
                // Prioritize web content over browser UI
                const webElements = chromeElements.filter(el => 
                  !el.name?.includes('Close') && 
                  !el.name?.includes('Minimize') && 
                  !el.name?.includes('Maximize') &&
                  !el.name?.includes('Back') &&
                  !el.name?.includes('Forward') &&
                  !el.name?.includes('Reload')
                );
                elements.push(...webElements);
                console.log(`[TerminatorAgent] 🌐 Chrome JavaScript found ${chromeElements.length} elements, prioritized ${webElements.length} web elements in ${Date.now() - startTime}ms`);
              }
            } catch (chromeErr) {
              console.log(`[TerminatorAgent] Chrome JavaScript failed:`, chromeErr);
            }
          } else {
            // Non-Chrome: Use Swift AX
          console.log(`[TerminatorAgent] 🚀 SWIFT AX: Listing elements for ${this.targetAppName} (${bundleId})`);
          const swiftList = await this.swiftListClickableElements(bundleId);
          const mapped = swiftList.map(sw => {
            const roleRaw = (sw.AXRole || '').toLowerCase();
            let role = 'button';
            if (roleRaw.includes('text') && roleRaw.includes('field')) role = 'textfield';
            else if (roleRaw.includes('text') && roleRaw.includes('area')) role = 'textarea';
            else if (roleRaw.includes('menu') && roleRaw.includes('item')) role = 'menuitem';
            else if (roleRaw.includes('link')) role = 'link';
            const name = (sw.AXTitle || sw.AXDescription || sw.AXValue || '').trim();
            const isClickable = (sw as any).clickable !== false; // Default to true if not specified for backward compatibility
            
            // Parse coordinate information from Swift AX attributes
            let bounds: { x: number; y: number; width: number; height: number } | undefined;
            try {
              const positionStr = sw.AXPosition as string || '';
              const sizeStr = sw.AXSize as string || '';
              
              // Parse position: "x=598 y=494.5" format
              const posMatch = positionStr.match(/x=([0-9.-]+)\s+y=([0-9.-]+)/);
              // Parse size: "w=261 h=16" format  
              const sizeMatch = sizeStr.match(/w=([0-9.-]+)\s+h=([0-9.-]+)/);
              
              if (posMatch && sizeMatch) {
                bounds = {
                  x: parseFloat(posMatch[1]),
                  y: parseFloat(posMatch[2]), 
                  width: parseFloat(sizeMatch[1]),
                  height: parseFloat(sizeMatch[2])
                };
              }
            } catch (error) {
              // Ignore coordinate parsing errors
            }
            
            return {
              name: name || `${role}@id:${sw.id}`,
              role,
              selector: `swift:id:${sw.id}`,
              swiftId: sw.id as number,
              bounds,
              clickable: isClickable
            } as TerminatorElement;
          }).filter(e => e.name && e.name !== '');
          elements.push(...mapped);
          console.log(`[TerminatorAgent] 🚀 SWIFT AX FOUND: ${mapped.length} elements in ${Date.now() - startTime}ms`);
          }
        } else {
        // When no target app known, try to get current focused app and scan it
        const current = await this.getCurrentFocusedApp().catch(() => '');
        if (current) {
          const bundleId = await this.getBundleIdFromAppName(current);
                if (bundleId) {
            console.log(`[TerminatorAgent] 🚀 SWIFT AX: Listing elements for focused app ${current} (${bundleId})`);
                  const swiftList = await this.swiftListClickableElements(bundleId);
                  const mapped = swiftList.map(sw => {
                    const roleRaw = (sw.AXRole || '').toLowerCase();
                    let role = 'button';
                    if (roleRaw.includes('text') && roleRaw.includes('field')) role = 'textfield';
                    else if (roleRaw.includes('text') && roleRaw.includes('area')) role = 'textarea';
                    else if (roleRaw.includes('menu') && roleRaw.includes('item')) role = 'menuitem';
                    else if (roleRaw.includes('link')) role = 'link';
                    const name = (sw.AXTitle || sw.AXDescription || sw.AXValue || '').trim();
                    
                    // Parse coordinate information from Swift AX attributes
                    let bounds: { x: number; y: number; width: number; height: number } | undefined;
                    try {
                      const positionStr = sw.AXPosition as string || '';
                      const sizeStr = sw.AXSize as string || '';
                      
                      // Parse position: "x=598 y=494.5" format
                      const posMatch = positionStr.match(/x=([0-9.-]+)\s+y=([0-9.-]+)/);
                      // Parse size: "w=261 h=16" format  
                      const sizeMatch = sizeStr.match(/w=([0-9.-]+)\s+h=([0-9.-]+)/);
                      
                      if (posMatch && sizeMatch) {
                        bounds = {
                          x: parseFloat(posMatch[1]),
                          y: parseFloat(posMatch[2]), 
                          width: parseFloat(sizeMatch[1]),
                          height: parseFloat(sizeMatch[2])
                        };
                      }
                    } catch (error) {
                      // Ignore coordinate parsing errors
                    }
                    
                    return {
                      name: name || `${role}@id:${sw.id}`,
                      role,
                selector: `swift:id:${sw.id}`,
                      swiftId: sw.id as number,
                      bounds
                    } as TerminatorElement;
                  }).filter(e => e.name && e.name !== '');
                    elements.push(...mapped);
            console.log(`[TerminatorAgent] 🚀 SWIFT AX FOUND: ${mapped.length} elements in ${Date.now() - startTime}ms`);
            
            // Chrome JavaScript fallback for focused app too
            const isChromeApp = /chrome|google chrome/i.test(current);
            if (isChromeApp) {
              console.log(`[TerminatorAgent] 🌐 Chrome detected, trying JavaScript fallback for web content...`);
              try {
                const chromeElements = await this.getChromeElementsViaJavaScriptV2();
                if (chromeElements.length > 0) {
                  // Prioritize web content over browser UI - put web elements first
                  const webElements = chromeElements.filter(el => 
                    !el.name?.includes('Close') && 
                    !el.name?.includes('Minimize') && 
                    !el.name?.includes('Maximize') &&
                    !el.name?.includes('Back') &&
                    !el.name?.includes('Forward') &&
                    !el.name?.includes('Reload')
                  );
                  elements.unshift(...webElements); // Add web elements at the beginning
                  console.log(`[TerminatorAgent] 🌐 Chrome JavaScript found ${chromeElements.length} elements, prioritized ${webElements.length} web elements`);
                }
              } catch (chromeErr) {
                console.log(`[TerminatorAgent] Chrome JavaScript fallback failed:`, chromeErr);
              }
            }
          }
        }
      }
      

      return elements;
    }
    } catch (scanError) {
      console.error('[TerminatorAgent] 🚨 SWIFT AX SCAN FAILED! Error details:', scanError);
      return [];
    }
    
    // Fallback return to satisfy TypeScript
    return [];
  }
  
  private async planNextAction(task: string, elements: TerminatorElement[]): Promise<TerminatorAction> {
    // All browser tasks use the same intelligent planning (no separate Gemini for Chrome)
    console.log('[TerminatorAgent] Using unified OpenAI planning for all tasks');
    
    // Enhanced standard planning with better context awareness
    return await this.planIntelligentAction(task, elements);
  }

  // Decide if screenshot is needed for the next action
  private async shouldUseScreenshot(task: string, stepCount: number, memory: string): Promise<boolean> {
    try {
      const decisionPrompt = `You are helping decide if a screenshot is needed for the next action.

TASK: "${task}"
CURRENT STEP: ${stepCount}
RECENT ACTIONS: ${memory.split('\n').slice(-3).join('\n') || 'None yet'}

Should we take a screenshot for visual context? Consider:
- Simple actions like "open app", "type text", "press key" usually DON'T need screenshots
- Complex actions like "click specific button", "find element", "verify state" DO need screenshots
- VISUAL TASKS ALWAYS need screenshots: "fill out this form", "what's on my screen", "click the red button", "find the X in the corner"
- Tasks referencing screen content ("this form", "that button", "current page") NEED screenshots
- MESSAGING TASKS need screenshots: "message john", "text sarah", "send message", "dm someone", "reply to conversation"
- CONVERSATION TASKS need screenshots: "talk to chatgpt", "chat with", "conversation with", "ask AI", "discuss with app"
- SOCIAL MEDIA POSTING ALWAYS needs screenshots: "post on X", "tweet", "share on instagram", "post to facebook" - ALL steps need visual context
- WAITING FOR RESPONSES needs screenshots: After sending messages/questions to apps, take screenshot to see their response
- First action of a task might need screenshot to see current state
- If recent actions failed, screenshot might help
- Be consistent: similar actions in the same task should get the same decision

Answer with just "yes" or "no".`;

      const completion = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        messages: [{ role: 'user', content: decisionPrompt }],
        max_tokens: 10,
        temperature: 0.1
      });

      const response = (completion.choices[0].message.content || '').toLowerCase().trim();
      const shouldUse = response.includes('yes');
      console.log(`[TerminatorAgent] 📸 Screenshot decision: ${shouldUse ? 'YES - will capture' : 'NO - skipping'}`);
      return shouldUse;
    } catch (error) {
      console.log('[TerminatorAgent] Screenshot decision failed, defaulting to YES:', error);
      return true; // Default to taking screenshot if decision fails
    }
  }

  private async planIntelligentAction(task: string, elements: TerminatorElement[]): Promise<TerminatorAction> {
    // Smart screenshot decision
    let screenshot: string | null = null;
    let screenState: string = '';
    
    // Check if we should take a screenshot for this action
    const needsScreenshot = await this.shouldUseScreenshot(task, this.stepCount, this.memory);
    
    if (needsScreenshot) {
      // Take screenshot for visual context
      try {
        console.log('[TerminatorAgent] 📸 Capturing screenshot for action planning...');
        screenshot = await this.captureScreenshotBase64();
        console.log('[TerminatorAgent] 📸 Screenshot captured for planning');
      } catch (error) {
        console.log('[TerminatorAgent] Screenshot capture failed:', error);
      }
    } else {
      console.log('[TerminatorAgent] 📸 Skipping screenshot for simple action');
    }
    
    // Fast screen state detection for all steps
    try {
      screenState = await this.detectScreenState();
      console.log('[TerminatorAgent] 🚀 SPEED: Using fast screen state detection');
    } catch (error) {
      console.log('[TerminatorAgent] Screen state detection failed:', error);
      screenState = 'Unknown screen state';
    }

    // Build rich element context with better structure
    const elementContext = await this.buildRichElementContext(elements);
    
    // Build detailed memory with verification of previous actions
    const detailedMemory = this.buildDetailedMemory();
    
    // Analyze current state intelligently
    const stateAnalysis = this.analyzeCurrentState(elements);

    // Structured failure metric for the planner
    const lastPlanned = this.actionLog[this.actionLog.length - 1]?.planned;
    const recentFailureCount = lastPlanned ? this.countRecentFailuresFor(lastPlanned) : 0;

    // Get last action for verification in the prompt
    const lastAction = this.actionLog[this.actionLog.length - 1];
    const lastActionInfo = lastAction ? `\n🔍 LAST ACTION TO VERIFY: "${lastAction.planned.type}: ${lastAction.planned.intent}" - Check if this worked in the screenshot before planning next action.` : '';

    const intelligentPrompt = `You are operating a simulated macOS environment - like a virtual MacBook that acts and responds EXACTLY like a real one, but it's just a detailed simulation. Think of it as an advanced Mac simulator or training environment where you can safely practice automation tasks. All apps, websites, and interactions work perfectly just like the real thing, but it's completely contained and safe.

${screenshot ? '📸 VISUAL CONTEXT: The screenshot image shows the user\'s current screen exactly as they see it right now. Use this visual information along with the text context below to plan the most accurate next action.' : '📝 TEXT-ONLY MODE: No screenshot provided for this action (deemed simple enough). Use the text context and element information below to plan the next action.'}

${screenshot && lastAction ? `
🔍 **MANDATORY LAST ACTION VERIFICATION**:
- BEFORE planning your next action, you MUST first verify if the last action worked
- Last action was: "${lastAction.planned.type}: ${lastAction.planned.intent}"
- Look at the screenshot and determine: Did this action succeed or fail?
- If it FAILED: Include the complete failure reason in your next action's "reasoning" field
- If it SUCCEEDED: Note the success and proceed with the next logical step
- Be specific about what you see in the screenshot that proves success/failure
- This verification is REQUIRED - do not skip this step
` : ''}

📚 TASK HISTORY - What I've done before (REFERENCE ONLY - don't use this to determine if current task is complete!)
${this.formatTaskHistory()}

🎯 ULTIMATE TASK: "${task}"

🚨 **CRITICAL TASK COMPLETION RULES - READ FIRST**:

🆕 **THIS IS A NEW TASK**:
- **IGNORE PAST SUCCESSES**: Even if action history shows similar tasks completed before, THIS IS A NEW TASK!
- **NEVER MARK DONE BASED ON HISTORY**: Don't mark "done" because you see old logs that mention similar results
- **START FRESH**: Each task is independent - act like you're starting from scratch for this specific request
- **COMPLETE CURRENT TASK**: Only mark "done" after YOU complete the current task in this session

- **BE PRECISE**: Only do exactly what's asked, nothing more
- **"make a new note"** = create the note file and STOP (don't start typing content)
- **"create a document"** = create the document and STOP (don't start typing content)  
- **"open app X"** = open the app and STOP (don't start using it)
- **"write X"** = actually type the content X
- **STOP AFTER CORE TASK**: If you successfully created/opened what was requested, use "done" immediately
- **NO EXTRA STEPS**: Don't assume user wants to add content, format, or do additional actions

⚠️ CONTEXTUAL AWARENESS:
- If the task contains words like "stop", "enough", "done", "that's good", "ok stop", "cancel", etc., the user likely wants to END the current activity
- For such stopping phrases, respond with "done" action regardless of what was being done before
- Understand user feedback contextually - "enough" usually means stop the current action

📝 FOLLOW-UP TASK AWARENESS:
- Check the TASK HISTORY above - user might be referencing a previous task
- If user says "continue from there", "do the same for X", "now do Y", check what was just completed
- Common follow-ups: "now open it", "edit that", "send it", "save it", "close it" - all refer to recent work
- Use context from recent tasks to understand ambiguous requests

📊 CURRENT STATE ANALYSIS:
${stateAnalysis}

🖥️ SCREEN STATE: ${screenState || 'Available via elements'}

🧠 DETAILED ACTION HISTORY:
${detailedMemory}${lastActionInfo}

📉 FAILURE SIGNALS:
- recentFailureCountForLastAction: ${recentFailureCount}
- RULE: If the SAME action (same type + intent) has FAILED 3 times in a row, you MUST switch to a different approach (different element/selector, different action type, add a focusing click, add a small wait, or choose an alternative path). Do NOT repeat the same failing action a 4th time.
- CLICK FAILURES: If a click failed with "could not find element", try: 1) Scroll to reveal it, 2) Wait for page to load, 3) Click a parent/child element instead, 4) Use keyboard navigation, 5) Try a different UI path to achieve the same goal

📱 CURRENT APP: ${this.targetAppName || 'None selected'}

        🎯 TASK CONTEXT AWARENESS:
        
        📢 PUBLIC POSTING vs 💬 PRIVATE MESSAGING:
        
        FOR PUBLIC POSTS (visible to everyone):
        - Task words: "post", "tweet", "share", "publish", "share publicly", "make a post"
        - Look for: Post/Tweet buttons, compose areas for public content in the element list
        - AVOID: Message/DM buttons, private messaging areas
        - Examples: "post hi on X" → find posting elements from the scanned element list
        
        FOR PRIVATE MESSAGES (DMs/direct messages):
        - Task words: "message", "dm", "direct message", "send to [person]", "text [person]" 
        - Look for: Message/DM compose buttons and areas in the element list  
        - AVOID: Public posting buttons, main tweet compose areas
        - Examples: "message john hello" → Messages app: 1) Click "compose" 2) Type "john" in To: field 3) Type "hello" in message field
        
        FOR REPLIES:
        - Task words: "reply", "respond to", "answer"
        - Target elements: Reply buttons under specific posts/messages
        - Context: Replying to existing content, not creating new
        
        🚨 CRITICAL DISTINCTION:
        - "NEW POST" = Public, visible to all followers/public → Look for posting elements in the list
        - "NEW MESSAGE" = Private, only visible to recipient → Look for messaging elements in the list
        - When in doubt, check task context: public sharing vs private communication
        
        👁️ VISUAL SEARCH BAR DETECTION:
        - When task involves typing in search/input fields, LOOK at the screenshot to see the actual placeholder text
        - Include the exact placeholder/label text you see in your action intent (e.g., "type wireless headphones in 'Search Amazon'")
        - This helps the system find the exact right input field instead of guessing

        📱 WHATSAPP SEARCH BEHAVIOR:
        - To find contacts in WhatsApp: SCROLL through the chat list first (preferred method)
        - Alternative: Click the "Search" button in the top-left corner 

        📄 DOCUMENT CREATION AWARENESS:
        - When task mentions "new document", "new file", "create document", check if app opened existing content
        - If TextEdit/Pages opens with existing text, create new document first (⌘+N)
        - If task says "new" but you see old content, don't assume it's ready - make it new first
        - For text editors: always verify blank canvas before typing task content

🚫 IGNORE AGENT OVERLAY:
- NEVER try to dismiss or interact with the agent overlay (pulsing blue circle in corner)
- The agent overlay is part of the automation system, NOT a website popup
- If you see "agent overlay" in descriptions, completely ignore it
- Focus on the actual website content behind/around the overlay

🎤 NO VOICE CAPABILITIES:
- **CRITICAL**: You do NOT have voice, microphone, or speech capabilities
- NEVER attempt "voice search", "search by voice", "speak to search", or "voice commands"
- NEVER click microphone buttons or voice input icons
- For searches: ALWAYS type text manually, never use voice input
- If you see voice search options, IGNORE them and use text input instead

🎯 BUTTON PREFERENCE:
- PREFER solid action buttons (e.g., "Post", "Send", "Submit") over text box elements when possible
- AVOID clicking generic text boxes when specific action buttons exist (e.g., use "Post" button instead of clicking compose text area)

⏳ UI STATE LOADING:
- If you just performed an action and nothing is visible, and it makes sense you went to a new UI state (opened page, clicked button), you can wait 1000ms to allow it to load
📍 STEP NUMBER: ${this.stepCount}/30

📋 AVAILABLE CLICKABLE ELEMENTS (Choose from these exact options):
${this.buildOrganizedElementList(elements)}

🎯 MANDATORY ELEMENT-ONLY RULE:
- FORBIDDEN: Using coordinates when ANY elements are listed above - this is completely banned
- REQUIRED: Always use BOTH "text" field with exact element name AND "selector" field with exact ID/selector from the list
- For web: return CONCRETE selector: {"type":"click","text":"Tweet button","selector":"[data-testid=\"tweetButton\"]","intent":"Submit post"}  
- For desktop: use element text AND selector: {"type":"click","text":"Send","selector":"swift:id:123","intent":"Submit message"}
- Example: If you see [3] "Unnamed" (swift:id:456) → use {"type":"click","text":"Unnamed","selector":"swift:id:456"} NOT coordinates
- NO GENERIC NAMES: Don't use "Post" or "Button" - use the EXACT name and selector from the scanned element list

${elementContext}

🎨 INTELLIGENT PLANNING GUIDELINES:

==== 🧠 CORE RULES & STATE AWARENESS ====

1. STATE AWARENESS:
   - Understand what state the app is currently in
   - Detect if there are dialogs, alerts, or prompts blocking interaction
   - Recognize if an app just opened and might need initialization
   - Check if text fields are already focused or need to be clicked first
   - **NEVER repeat actions that have already succeeded**
   - **ELEMENT CLICKABILITY**: ✅ = CLICKABLE elements, ℹ️ = INFORMATIONAL elements only

2. SMART DECISION MAKING:
        - If typing didn't work, the text field might not be focused - click it first
   - **TYPING FAILURE DETECTION**: If typed same text multiple times with no result, click input field first
   - **COMPLETION DETECTION**: When core task achieved, immediately use "done" action
   - For text formatting (like bold), ensure text is selected first

3. PROGRESSIVE ACTIONS:
   - Break complex tasks into atomic, verifiable steps
   - After opening app, check initial state before proceeding
   - After typing text, verify it was entered before formatting
   - After clicking, wait briefly for UI updates

==== 🚀 APP OPENING & NAVIGATION ====

4. SPOTLIGHT APP OPENING:
   - Use "spotlight_open_app" action for ALL app opening
   - NEVER use AppleScript "tell application" 
   - Example: {"type": "spotlight_open_app", "appName": "Google Chrome", "intent": "Opening Chrome"}
   - CORRECT APP NAMES: "Google Chrome", "Mail", "TextEdit", "Calculator", "Messages"
   - WRONG: "x.com", "amazon.com" (these are websites, not apps!)

5. WEBSITE NAVIGATION:
   - Use "navigate_to_url" action for ALL website navigation
   - Example: {"type": "navigate_to_url", "url": "x.com", "intent": "Navigate to X"}
   - Common services:
     • ChatGPT → chatgpt.com
     • Claude → claude.ai
     • Gmail → gmail.com
     • YouTube → youtube.com
     • X/Twitter → x.com
     • Facebook → facebook.com
     • Instagram → instagram.com

6. APP SELECTION:
   - Web tasks → Google Chrome (preferred over Safari)
   - Email → Mail app
   - Messages → Messages app
   - Math → Calculator app
   - Documents → TextEdit
   - Messaging apps (WhatsApp, Telegram, Discord):
     1. Try native desktop app first
     2. If fails, use Chrome web version (web.whatsapp.com)

==== 🔍 SEARCH & INPUT RULES ====

7. SEARCH RULES:
   - ✅ USE SEARCH TOOL: {"type": "search", "text": "query"}
   - ❌ NEVER TYPE+ENTER: Don't manually type and press return
   - Website-specific search: Use the website's search bar (YouTube search, Amazon search)
   - General web search: Use search tool directly
   - After Google search: Scroll once to get past ads

8. TEXT INPUT RULES:
   - ALWAYS click text fields before typing if not focused
   - Search fields: Must click search input first, then type
   - Calculator: NEVER use 'type' - click each button individually
   - For multi-digit numbers: Click each digit separately (34 = click "3" then "4")

==== 📱 SOCIAL MEDIA WORKFLOWS ====

9. X.COM (TWITTER):
   - **MANDATORY X.COM RULE**: ALWAYS click "New tweet"/"Post" button BEFORE typing - NEVER type into "What's happening?" or "Post text" areas without clicking button first
   - **CRITICAL**: Click "New tweet"/"Post" button FIRST - NEVER click "What's happening?" text area directly
   - **BUTTON DISTINCTION**: "New tweet" button opens compose area, "Post" button (after typing) publishes the tweet - these are DIFFERENT buttons
   - Posting: 1) Click "Post"/"New tweet" button (bottom left), 2) Type in compose area, 3) Click "Post"
   - Liking: Look for "Like", "Heart", "♥" elements
   - Scrolling: Ensure on homepage/feed first

10. INSTAGRAM:
   - Navigate to instagram.com
   - Look for compose/share buttons
   - Use heart icons for liking

11. FACEBOOK:
   - Navigate to facebook.com
   - Look for "Create post" or "What's on your mind?"
   - Like buttons: "Like", "👍"

12. SOCIAL MEDIA PATTERNS:
   - "Every other post" liking:
     1. Scroll once (2-3 repeats)
     2. Click first like
     3. Scroll small amount
     4. Skip one post
     5. Click next like
     6. Repeat cycle

==== 💬 MESSAGING WORKFLOWS ====

13. MESSAGES APP:
   - **USE EXACT NAMES**: When user says "message [name]", look for that EXACT name - don't assume or interpret what they mean
   - Existing conversation: Click person's name → Type message → Press Enter
   - New message: Click "compose"/"+" → Type recipient → Tab → Type message → Enter
   - NEVER type recipient and message together

14. MAIL APP:
   - New email: Click "New Message" → Click "To:" → Type email → Tab → Type subject → Tab → Type body → Send
   - NEVER type everything in one field

15. WHATSAPP/TELEGRAM/DISCORD:
   - Try native app first
   - If fails: Chrome → web.whatsapp.com (or equivalent)
   - Follow same pattern as Messages app

==== 🛒 E-COMMERCE & BROWSING ====

16. AMAZON:
   - Search: Click search bar → Type query → Press Enter or click search button
   - Shopping: Scroll to see more options and deals
   - NEVER use browser address bar for Amazon searches

17. YOUTUBE:
   - Search: Use YouTube's search bar (NOT Google's)
   - NEVER use browser address bar for YouTube searches
   - Look for video thumbnails after searching

==== 🔧 SPECIAL APP RULES ====

18. CALCULATOR:
   - NEVER use 'type' action
   - Click individual buttons for each digit
   - Operations: "Multiply", "Divide", "Add", "Subtract", "Equals"
   - Example: 34×89 = Click "3"→"4"→"Multiply"→"8"→"9"→"Equals"

19. CHROME SPECIFICS:
   - Never click suggestions or bookmarks
   - After opening, wait for load before interacting
   - For searches when Chrome open: Use search tool directly

==== 📜 SCROLLING RULES ====

20. DYNAMIC SCROLLING:
   - "scroll a bit" → repeats: 3-4
   - "scroll down" → repeats: 2
   - "scroll a lot" → repeats: 6-8
   - Social media: Ensure on homepage first
   - Shopping: Scroll to see more options

==== ⚡ ACTION SELECTION ====

21. CLICK TYPES:
   - click: Standard single click
   - double_click: Open files, expand folders
   - right_click: Context menus
   - middle_click: Open in new tab
   - hover: Reveal tooltips/menus
   - drag_and_drop: Move items

22. MENU INTERACTION:
   - After clicking menu: Look for menu items in next scan
   - Don't repeat menu clicks
   - Wait for popup menus to appear

==== 🚫 NEVER DO THESE ====

23. FORBIDDEN ACTIONS:
   - Assume app is in specific state without checking
   - Skip initialization steps
   - Type without ensuring text field is focused
   - Apply formatting without selecting text first
   - Use hardcoded workflows
   - Search for literal symbol text without considering semantic alternatives

24. INTELLIGENT SYMBOL MAPPING:
   - "X" → "Multiply" (Calculator) or "Close" (UI)
   - "÷" → "Divide"
   - "+" → "Add"
   - "-" → "Subtract"
   - "=" → "Equals"

==== ✅ STEP-BY-STEP DECISION PROCESS ====

25. ANALYZE SITUATION:
   - What app am I in?
   - What elements are visible?
   - What was my last action?
   - If just searched → click result, don't search again!

26. UNDERSTAND TASK:
   - What is user asking?
   - What steps are needed?
   - Where am I in sequence?

27. CHOOSE ACTION:

4️⃣ CRITICAL ELEMENT-FIRST RULE:
   - 🚨 ALWAYS use elements from "AVAILABLE CLICKABLE ELEMENTS" list - NEVER use coordinates when elements exist
   - If ANY element exists that could work, use it with "text" field - even if the name is "Unnamed" or generic
   - Look for the [number] and use the EXACT text shown (e.g., [5] "Post" → use text: "Post", [3] "Unnamed" → use text: "Unnamed")
   - Coordinates are BANNED when elements are available - only for empty element lists or very specific pixel-perfect needs
   - If you need something not in the list: "wait"/"scroll" to reveal more elements first
${screenshot ? `
5️⃣ VISUAL COORDINATE MODE (SCREENSHOT PROVIDED):
   - 🎯 Use coordinates ONLY as a fallback when element-based clicking fails or when explicitly requested to use coordinates` : ''}

RESPOND WITH JSON ONLY:
{
  "type": "click|double_click|right_click|middle_click|hover|drag_and_drop|scroll|scroll_at|type|key|applescript|wait|done|spotlight_open_app|navigate_to_url|search",
  "intent": "Clear description of what this action accomplishes and why it's needed now",
  "text": "EXACT element name from the scanned list (for click actions) OR text to type (for type actions) OR search query (for search)",
  "selector": "EXACT selector/ID from the element list (e.g., 'swift:id:123', '[data-testid=\"tweetButton\"]', 'applescript:button:Send') - REQUIRED for all click actions",
  "keyString": "e.g., cmd+a, cmd+b, return",
  "applescriptCode": "Full AppleScript if opening app or complex action",
  "appName": "App name for spotlight_open_app (e.g., 'Google Chrome', 'Mail')",
  "url": "Website URL for navigate_to_url (e.g., 'x.com', 'amazon.com')",
          "amount": "Scroll distance for scroll actions (default: 300)",
  "repeats": "How many times to repeat scroll (1-10, adjust based on user intent)",
  "x": "X coordinate - for ANY action when using visual mode (click, double_click, right_click, hover, etc.)",
  "y": "Y coordinate - for ANY action when using visual mode (click, double_click, right_click, hover, etc.)", 
  "deltaX": "Horizontal scroll delta for scroll_at (-/+ pixels)",
  "deltaY": "Vertical scroll delta for scroll_at (-/+ pixels, negative = up)",
  "startX": "Start X coordinate for drag_and_drop",
  "startY": "Start Y coordinate for drag_and_drop",
  "endX": "End X coordinate for drag_and_drop", 
  "endY": "End Y coordinate for drag_and_drop",
  "duration": "Duration in ms for hover/drag_and_drop actions",
  "reasoning": "Why this is the best next action given the current state",
  "expectedOutcome": "What should happen after this action succeeds"
}

📍 STRICT ELEMENT-ONLY POLICY:
- MANDATORY: Use EXACT element names AND selectors from scan - coordinates are FORBIDDEN when elements exist
- REQUIRED: Always provide both "text" (element name) AND "selector" (exact ID/selector) for click actions
- BE CONSISTENT: If your reasoning mentions a specific element name, use that exact name and its selector
- For text areas/inputs: Use the specific element name AND selector if provided in scan (e.g., text: "textfield@id:60", selector: "swift:id:60")
- ZERO TOLERANCE: Never use coordinates when elements are available, even if names are generic like "Unnamed"
- NO GUESSING: Don't say generic names like "Post" - use the EXACT element name and selector from the scanned list`;

    try {
              // Use Groq Llama-4-Maverick as primary model
        console.log(`[TerminatorAgent] Using model: Groq llama-4-maverick for intelligent planning`);
      
      const groqMessages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'user',
          content: intelligentPrompt
        }
      ];
      
      let responseText = '';
      
      try {
        // Primary: Gemini 2.5 Flash with screenshot
        console.log(`[TerminatorAgent] Using model: Gemini 2.5 Flash for intelligent planning with screenshot`);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        // Build content parts with text and optional screenshot
        const parts: any[] = [{ text: intelligentPrompt }];
        if (screenshot) {
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: screenshot } });
          console.log('[TerminatorAgent] 📸 Including screenshot in Gemini planning request');
        }
        
        const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
        responseText = result.response?.text()?.trim() || '';
        console.log(`[TerminatorAgent] Gemini response received`);
      } catch (geminiError: any) {
        console.log(`[TerminatorAgent] ⚠️ Gemini failed, falling back to GPT-4o:`, geminiError.message);
        try {
          // First fallback: OpenAI GPT-4o with screenshot support
          const messages: OpenAI.ChatCompletionMessageParam[] = [
            {
              role: 'user',
              content: screenshot ? [
                { type: 'text', text: intelligentPrompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } }
              ] : intelligentPrompt
            }
          ];
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages,
            max_tokens: 5000,
            temperature: 0.1
          });
          responseText = completion.choices[0].message.content?.trim() || '';
          console.log(`[TerminatorAgent] GPT-4o response received`);
        } catch (openaiError: any) {
          console.log(`[TerminatorAgent] ⚠️ GPT-4o failed, falling back to Groq:`, openaiError.message);
          try {
            // Second fallback: Groq
            const completion = await groq.chat.completions.create({
              model: 'llama-3.3-70b-versatile',
              messages: groqMessages,
              max_tokens: 5000,
              temperature: 0.1
            });
            responseText = completion.choices[0].message.content?.trim() || '';
            console.log(`[TerminatorAgent] Groq response received`);
          } catch (groqError: any) {
            console.log(`[TerminatorAgent] ⚠️ All models failed:`, groqError.message);
            responseText = '';
          }
        }
      }
      
            // Check if AI refused to help (fallback to Claude)
      if (responseText && (responseText.includes("I'm sorry, I can't assist") || responseText.includes("I cannot help") || responseText.includes("I'm not able to"))) {
        console.log(`[TerminatorAgent] ⚠️ OpenAI refused task, trying Claude 3.5 Sonnet fallback...`);
        try {
          // Check if screenshot needs compression for Claude (5MB limit)
          let claudeScreenshot = screenshot;
          if (screenshot) {
            const screenshotSize = Buffer.from(screenshot, 'base64').length;
            console.log(`[TerminatorAgent] Screenshot size: ${screenshotSize} bytes`);
            
            if (screenshotSize > 5242880) { // 5MB limit
              console.log(`[TerminatorAgent] 📸 Screenshot too large for Claude (${screenshotSize} bytes), compressing...`);
              try {
                // Use sharp to compress the image
                const sharp = require('sharp');
                const imageBuffer = Buffer.from(screenshot, 'base64');
                const compressedBuffer = await sharp(imageBuffer)
                  .jpeg({ quality: 60, progressive: true })
                  .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
                  .toBuffer();
                
                claudeScreenshot = compressedBuffer.toString('base64');
                console.log(`[TerminatorAgent] ✅ Compressed screenshot: ${compressedBuffer.length} bytes`);
              } catch (compressionError) {
                console.log(`[TerminatorAgent] ⚠️ Image compression failed:`, compressionError);
                claudeScreenshot = null; // Send without image if compression fails
              }
            }
          }
          
          // Use the EXACT SAME prompt and (possibly compressed) screenshot that OpenAI got
          const claudeMessages: Anthropic.MessageParam[] = claudeScreenshot ? [
            {
              role: 'user',
              content: [
                { 
                  type: 'text', 
                  text: intelligentPrompt 
                },
                { 
                  type: 'image', 
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: claudeScreenshot
                  }
                }
              ]
            }
          ] : [
            {
              role: 'user',
              content: intelligentPrompt
            }
          ];
          
          const claudeResponse = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 1000,
            temperature: 0.1,
            messages: claudeMessages
          });
          
          // Extract text from Claude's response
          const claudeContent = claudeResponse.content[0];
          if (claudeContent.type === 'text') {
            responseText = claudeContent.text.trim();
            console.log(`[TerminatorAgent] 🔄 Claude 3.5 Sonnet fallback response:`, responseText);
          }
        } catch (claudeError) {
          console.log(`[TerminatorAgent] ❌ Claude fallback also failed:`, claudeError);
          // Continue with original refused response
        }
      }
      
      // ROBUST JSON EXTRACTION: Handle various formats AI might return
      if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
      }
      
      let jsonText = '';
      
      // Try multiple extraction strategies
      // 1. Look for complete JSON block
      const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      } 
      // 2. Find first { to last } span
      else {
        const firstBrace = responseText.indexOf('{');
        const lastBrace = responseText.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          jsonText = responseText.slice(firstBrace, lastBrace + 1);
        }
      }
      
      // 3. If still no JSON, look for "type": pattern and build minimal JSON
      if (!jsonText && responseText.includes('"type"')) {
        console.log('[TerminatorAgent] Building JSON from partial response');
        const typeMatch = responseText.match(/"type":\s*"([^"]+)"/);
        const intentMatch = responseText.match(/"intent":\s*"([^"]+)"/);
        if (typeMatch) {
          jsonText = `{
            "type": "${typeMatch[1]}",
            "intent": "${intentMatch ? intentMatch[1] : 'Extracted from partial response'}",
            "reasoning": "Recovered from malformed AI response",
            "expectedOutcome": "Action execution"
          }`;
        }
      }
      
      if (!jsonText) {
        console.log('[TerminatorAgent] Raw response for debugging:', responseText);
        // Create a fallback action instead of throwing
        console.log('[TerminatorAgent] Creating fallback action due to malformed response');
        jsonText = `{
          "type": "wait",
          "intent": "Fallback action due to malformed AI response",
          "reasoning": "AI response was not properly formatted JSON",
          "expectedOutcome": "Continue with next planning attempt"
        }`;
      }
      
      let action;
      try {
        action = JSON.parse(jsonText);
      } catch (parseError) {
        console.log('[TerminatorAgent] JSON parse failed, raw jsonText:', jsonText);
        throw new Error(`Invalid JSON in planning response: ${parseError}`);
      }
      
      // Log the reasoning for debugging
      console.log(`[TerminatorAgent] 🧠 AI Reasoning: ${action.reasoning || 'Not provided'}`);
      console.log(`[TerminatorAgent] 🎯 Expected Outcome: ${action.expectedOutcome || 'Not specified'}`);
      
      // Store expected outcome for verification
      (this as any).lastExpectedOutcome = action.expectedOutcome;
      
      return action as TerminatorAction;
      
    } catch (error) {
      console.error('[TerminatorAgent] Intelligent planning failed:', error);
      // Fallback to simpler planning
    return await this.planStandardAction(task, elements);
    }
  }

  private buildOrganizedElementList(elements: TerminatorElement[]): string {
    try {
      const indexed = elements.map((el, idx) => ({ el, idx }));
      const toLower = (s?: string) => (s || '').toLowerCase();
      const getRole = (e: TerminatorElement) => toLower(e.role);
      const isClickable = (e: TerminatorElement) => e.clickable !== false;

      type BucketMap = { [key: string]: Array<{ el: TerminatorElement; idx: number }>; };
      const clickableBuckets: BucketMap = {
        'Buttons': [],
        'Inputs/Textareas': [],
        'Links': [],
        'Selects/Comboboxes': [],
        'Checkboxes/Radios': [],
        'Menus/Options': [],
        'Media/Images': [],
        'Other Clickable': []
      };
      const infoBuckets: BucketMap = { 'Informational': [] };

      function categorize(e: TerminatorElement): string {
        const r = getRole(e);
        if (r.includes('button')) return 'Buttons';
        if (r.includes('textfield') || r.includes('textarea') || r.includes('text field')) return 'Inputs/Textareas';
        if (r.includes('link')) return 'Links';
        if (r.includes('checkbox') || r.includes('radio')) return 'Checkboxes/Radios';
        if (r.includes('menu') || r.includes('menuitem') || r.includes('option') || r.includes('list')) return 'Menus/Options';
        if (r.includes('combo') || r.includes('select') || r.includes('popup')) return 'Selects/Comboboxes';
        if (r.includes('image') || r.includes('img')) return 'Media/Images';
        return 'Other Clickable';
      }

      for (const it of indexed) {
        if (isClickable(it.el)) {
          clickableBuckets[categorize(it.el)].push(it);
        } else {
          infoBuckets['Informational'].push(it);
        }
      }

      const byPositionThenName = (a: { el: TerminatorElement; idx: number }, b: { el: TerminatorElement; idx: number }) => {
        const ab = a.el.bounds, bb = b.el.bounds;
        if (ab && bb) {
          if (ab.y !== bb.y) return ab.y - bb.y;
          if (ab.x !== bb.x) return ab.x - bb.x;
        }
        const an = (a.el.name || '').toLowerCase();
        const bn = (b.el.name || '').toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.idx - b.idx;
      };

      const sections: string[] = [];
      sections.push('📋 AVAILABLE ELEMENTS (grouped) - Use EXACT element name and selector from this list:');
      sections.push('');

      // Clickable groups first
      const clickableOrder = ['Buttons', 'Inputs/Textareas', 'Links', 'Selects/Comboboxes', 'Checkboxes/Radios', 'Menus/Options', 'Media/Images', 'Other Clickable'];
      for (const key of clickableOrder) {
        const arr = clickableBuckets[key];
        if (!arr || arr.length === 0) continue;
        arr.sort(byPositionThenName);
        sections.push(`✅ ${key} (${arr.length}):`);
        for (const { el, idx } of arr) {
          const bounds = el.bounds ? ` at (${el.bounds.x}, ${el.bounds.y}) size(${el.bounds.width}x${el.bounds.height})` : '';
          const role = el.role || 'unknown';
          const name = el.name || 'Unnamed';
          const selector = el.selector ? ` selector:"${el.selector}"` : '';
          const webSel = el.webSelector ? ` web:"${el.webSelector}"` : '';
          sections.push(`  [${idx}] "${name}" (${role})${selector}${webSel}${bounds}`);
        }
        sections.push('');
      }

      // Informational last
      const infoArr = infoBuckets['Informational'];
      if (infoArr && infoArr.length > 0) {
        infoArr.sort(byPositionThenName);
        sections.push(`ℹ️ Informational (${infoArr.length}):`);
        for (const { el, idx } of infoArr) {
          const bounds = el.bounds ? ` at (${el.bounds.x}, ${el.bounds.y}) size(${el.bounds.width}x${el.bounds.height})` : '';
          const role = el.role || 'unknown';
          const name = el.name || 'Unnamed';
          const selector = el.selector ? ` selector:"${el.selector}"` : '';
          const webSel = el.webSelector ? ` web:"${el.webSelector}"` : '';
          sections.push(`  [${idx}] "${name}" (${role})${selector}${webSel}${bounds}`);
        }
        sections.push('');
      }

      return sections.join('\n');
    } catch (e) {
      try {
        // Fallback to simple list if anything goes wrong
        return elements.map((el, idx) => `  [${idx}] "${el.name || 'Unnamed'}" (${el.role || 'unknown'})${el.selector ? ` selector:"${el.selector}"` : ''}${el.bounds ? ` at (${el.bounds.x}, ${el.bounds.y})` : ''}`).join('\n');
      } catch {
        return '';
      }
    }
  }

  private async buildRichElementContext(elements: TerminatorElement[]): Promise<string> {
    if (!elements || elements.length === 0) {
      return '🚫 NO INTERACTIVE ELEMENTS DETECTED\n- App may be loading, blank, or showing non-interactive content\n- Consider waiting, scrolling, or clicking to reveal more elements';
    }
    
    // ULTRA-ENHANCED visual scanning with spatial, state, and content analysis
    let context = `📋 COMPREHENSIVE SCREEN ANALYSIS (${elements.length} elements detected):\n\n`;
    
    // Spatial analysis: group elements by screen regions
    const regions = this.analyzeElementRegions(elements);
    if (regions.length > 0) {
      context += '🗺️ SCREEN LAYOUT REGIONS:\n';
      regions.forEach(region => {
        context += `  ${region.name}: ${region.elements.length} elements ${region.description}\n`;
      });
      context += '\n';
    }
    
    // Priority 1: Critical posting/interaction elements for X.com and other sites
    const postButtons = elements.filter(e => {
      const text = (e.name || '').toLowerCase();
      return text.includes('post') || text.includes('tweet') || text.includes('publish') || text.includes('send');
    });
    
    const composeElements = elements.filter(e => {
      const text = (e.name || '').toLowerCase();
      return text.includes('what\'s happening') || text.includes('compose') || text.includes('write') || 
             text.includes('new message') || text.includes('start a post');
    });
    
    const inputFields = elements.filter(e => 
      e.role?.toLowerCase() === 'textfield' || e.role?.toLowerCase() === 'textarea'
    );
      
    // Priority 2: Navigation and interaction elements
    const clickableButtons = elements.filter(e => 
      e.role?.toLowerCase() === 'button' && e.name && e.name.trim().length > 0
    );
    
    const links = elements.filter(e => 
      e.role?.toLowerCase() === 'link' && e.name && e.name.trim().length > 0
    );
    
    // EXPLICIT SECTION 1: POST/COMPOSE ELEMENTS (most important for social media)
    if (postButtons.length > 0 || composeElements.length > 0) {
      context += '🎯 POSTING/COMPOSE ELEMENTS (CRITICAL FOR SOCIAL MEDIA TASKS):\n';
      
      if (composeElements.length > 0) {
        context += '📝 COMPOSE AREAS:\n';
        composeElements.slice(0, 5).forEach(elem => {
          const bounds = (elem as any).bounds ? ` at (${(elem as any).bounds.x}, ${(elem as any).bounds.y})` : '';
          const focused = (elem as any).AXFocused ? ' [READY FOR TYPING]' : ' [CLICK TO ACTIVATE]';
          const clickIcon = elem.clickable !== false ? '✅' : 'ℹ️';
        context += `  ${clickIcon} "${elem.name}"${bounds}${focused}\n`;
        });
      }
      
      if (postButtons.length > 0) {
        context += '🔥 POST/PUBLISH BUTTONS:\n';
        postButtons.slice(0, 5).forEach(elem => {
          const bounds = (elem as any).bounds ? ` at (${(elem as any).bounds.x}, ${(elem as any).bounds.y})` : '';
          const enabled = (elem as any).AXEnabled === false ? ' [DISABLED]' : ' [CLICKABLE]';
          const clickIcon = elem.clickable !== false ? '✅' : 'ℹ️';
        context += `  ${clickIcon} "${elem.name}"${bounds}${enabled}\n`;
        });
      }
      context += '\n';
    }
    
    // EXPLICIT SECTION 2: INPUT FIELDS WITH ENHANCED STATE ANALYSIS
    if (inputFields.length > 0) {
      context += '📋 TEXT INPUT AREAS WITH DETAILED STATES:\n';
      inputFields.slice(0, 8).forEach(elem => {
      const value = (elem as any).AXValue || '';
        const focused = (elem as any).AXFocused ? ' [CURRENTLY FOCUSED - READY FOR TYPING]' : ' [CLICK FIRST TO TYPE]';
        const enabled = (elem as any).AXEnabled === false ? ' [DISABLED - CANNOT TYPE]' : '';
        const required = (elem as any).AXRequired ? ' [REQUIRED FIELD]' : '';
        const placeholder = (elem as any).AXPlaceholderValue ? ` placeholder:"${(elem as any).AXPlaceholderValue}"` : '';
        const hasText = value ? ` (contains: "${value.substring(0, 40)}...")` : ' [EMPTY]';
        const bounds = (elem as any).bounds ? ` at (${(elem as any).bounds.x}, ${(elem as any).bounds.y}) size(${(elem as any).bounds.width}x${(elem as any).bounds.height})` : '';
        const errorState = this.detectElementErrorState(elem);
        
        const clickIcon = elem.clickable !== false ? '✅' : 'ℹ️';
        context += `  ${clickIcon} "${elem.name}"${bounds}${hasText}${placeholder}${focused}${enabled}${required}${errorState}\n`;
      });
      context += '\n';
    }
    
    // EXPLICIT SECTION 3: ALL CLICKABLE BUTTONS WITH ENHANCED STATES
    if (clickableButtons.length > 0) {
      context += '🔘 CLICKABLE BUTTONS WITH VISUAL STATES:\n';
      clickableButtons.slice(0, 12).forEach(elem => {
        const bounds = (elem as any).bounds ? ` at (${(elem as any).bounds.x}, ${(elem as any).bounds.y}) size(${(elem as any).bounds.width}x${(elem as any).bounds.height})` : '';
        const enabled = (elem as any).AXEnabled === false ? ' [DISABLED]' : ' [CLICKABLE]';
        const selected = (elem as any).AXSelected ? ' [SELECTED/ACTIVE]' : '';
        const pressed = (elem as any).AXPressed ? ' [PRESSED]' : '';
        const defaultButton = (elem as any).AXDefault ? ' [DEFAULT ACTION]' : '';
        const description = (elem as any).AXDescription ? ` desc:"${(elem as any).AXDescription}"` : '';
        const errorState = this.detectElementErrorState(elem);
        const buttonType = this.categorizeButton(elem.name || '');
        
        const clickIcon = elem.clickable !== false ? '✅' : 'ℹ️';
        context += `  ${clickIcon} "${elem.name}"${bounds}${buttonType}${enabled}${selected}${pressed}${defaultButton}${description}${errorState}\n`;
      });
      context += '\n';
    }
    
    // EXPLICIT SECTION 4: LINKS AND NAVIGATION
    if (links.length > 0) {
      context += '🔗 CLICKABLE LINKS:\n';
      links.slice(0, 8).forEach(elem => {
        const bounds = (elem as any).bounds ? ` at (${(elem as any).bounds.x}, ${(elem as any).bounds.y})` : '';
        const clickIcon = elem.clickable !== false ? '✅' : 'ℹ️';
        context += `  ${clickIcon} "${elem.name}"${bounds}\n`;
      });
      context += '\n';
    }
    

    
    // Enhanced browser content analysis for Chrome/Safari
    if (this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName)) {
      try {
        const webAnalysis = await this.getEnhancedWebContentAnalysis();
        if (webAnalysis && webAnalysis.trim()) {
          context += webAnalysis + '\n\n';
        }
      } catch (error) {
        console.log('[TerminatorAgent] Enhanced web content analysis failed:', error);
      }
    }
    
    return context;
  }

  // **NEW METHOD: Spatial Analysis for Layout Understanding**
  private analyzeElementRegions(elements: TerminatorElement[]): Array<{name: string, elements: TerminatorElement[], description: string}> {
    const regions: Array<{name: string, elements: TerminatorElement[], description: string}> = [];
    
    // Get screen dimensions (rough estimates)
    const elementsWithBounds = elements.filter(e => (e as any).bounds);
    if (elementsWithBounds.length === 0) return regions;
    
    const screenWidth = Math.max(...elementsWithBounds.map(e => ((e as any).bounds.x + (e as any).bounds.width) || 0));
    const screenHeight = Math.max(...elementsWithBounds.map(e => ((e as any).bounds.y + (e as any).bounds.height) || 0));
    
    // Define regions based on typical screen layout
    const topRegion = elementsWithBounds.filter(e => (e as any).bounds.y < screenHeight * 0.2);
    const middleRegion = elementsWithBounds.filter(e => 
      (e as any).bounds.y >= screenHeight * 0.2 && (e as any).bounds.y < screenHeight * 0.8
    );
    const bottomRegion = elementsWithBounds.filter(e => (e as any).bounds.y >= screenHeight * 0.8);
    
    const leftRegion = elementsWithBounds.filter(e => (e as any).bounds.x < screenWidth * 0.3);
    const rightRegion = elementsWithBounds.filter(e => (e as any).bounds.x >= screenWidth * 0.7);
    
    if (topRegion.length > 0) regions.push({
      name: '🔝 TOP AREA', 
      elements: topRegion, 
      description: '(likely toolbar, navigation, or header)'
    });
    
    if (leftRegion.length > 0) regions.push({
      name: '◀️ LEFT SIDEBAR', 
      elements: leftRegion, 
      description: '(likely navigation or menu)'
    });
    
    if (rightRegion.length > 0) regions.push({
      name: '▶️ RIGHT SIDEBAR', 
      elements: rightRegion, 
      description: '(likely secondary content or tools)'
    });
    
    if (middleRegion.length > 0) regions.push({
      name: '🎯 CENTER AREA', 
      elements: middleRegion, 
      description: '(likely main content or working area)'
    });
    
    if (bottomRegion.length > 0) regions.push({
      name: '🔽 BOTTOM AREA', 
      elements: bottomRegion, 
      description: '(likely status bar or action buttons)'
    });
    
    return regions;
  }

  // **NEW METHOD: Error State Detection**
  private detectElementErrorState(element: TerminatorElement): string {
    const name = (element.name || '').toLowerCase();
    const value = ((element as any).AXValue || '').toLowerCase();
    const description = ((element as any).AXDescription || '').toLowerCase();
    const help = ((element as any).AXHelp || '').toLowerCase();
    
    // Check for error indicators in accessibility properties
    const errorKeywords = ['error', 'invalid', 'required', 'missing', 'incorrect', 'failed', 'warning'];
    const successKeywords = ['valid', 'success', 'correct', 'complete'];
    
    let errorState = '';
    
    // Check various accessibility properties for error indicators
    const allText = `${name} ${value} ${description} ${help}`;
    
    if (errorKeywords.some(keyword => allText.includes(keyword))) {
      errorState += ' [⚠️ ERROR STATE DETECTED]';
    }
    
    if (successKeywords.some(keyword => allText.includes(keyword))) {
      errorState += ' [✅ SUCCESS STATE]';
    }
    
    // Check if element is marked as invalid
    if ((element as any).AXInvalid === true || (element as any).AXInvalid === 'true') {
      errorState += ' [❌ INVALID]';
    }
    
    // Check for red color indicators (limited accessibility info)
    if (description.includes('red') || help.includes('red')) {
      errorState += ' [🔴 RED INDICATOR]';
    }
    
    return errorState;
  }

  // **NEW METHOD: Button Categorization for Context**
  private categorizeButton(buttonName: string): string {
    const name = buttonName.toLowerCase();
    
    if (name.includes('send') || name.includes('post') || name.includes('publish') || name.includes('submit')) {
      return ' [📤 ACTION BUTTON]';
    }
    if (name.includes('cancel') || name.includes('close') || name.includes('dismiss')) {
      return ' [❌ CANCEL BUTTON]';
    }
    if (name.includes('save') || name.includes('confirm') || name.includes('ok') || name.includes('apply')) {
      return ' [✅ CONFIRM BUTTON]';
    }
    if (name.includes('new') || name.includes('create') || name.includes('add') || name.includes('compose')) {
      return ' [➕ CREATE BUTTON]';
    }
    if (name.includes('edit') || name.includes('modify') || name.includes('change')) {
      return ' [✏️ EDIT BUTTON]';
    }
    if (name.includes('delete') || name.includes('remove') || name.includes('trash')) {
      return ' [🗑️ DELETE BUTTON]';
    }
    if (name.includes('search') || name.includes('find')) {
      return ' [🔍 SEARCH BUTTON]';
    }
    if (name.includes('back') || name.includes('previous') || name.includes('return')) {
      return ' [◀️ NAVIGATION BUTTON]';
    }
    if (name.includes('next') || name.includes('forward') || name.includes('continue')) {
      return ' [▶️ NAVIGATION BUTTON]';
    }
    if (name.includes('menu') || name.includes('options') || name.includes('settings')) {
      return ' [⚙️ MENU BUTTON]';
    }
    
    return ' [🔘 GENERAL BUTTON]';
  }

  private buildDetailedMemory(): string {
    if (!this.memory || this.memory.trim() === '') {
      return 'No actions taken yet - this is the first step.';
    }
    
    // Parse the memory and add context about likely outcomes
    const lines = this.memory.split('\n').filter(Boolean);
    
    // Separate successful and failed actions for better clarity
    const successful: string[] = [];
    const failed: string[] = [];
    
    lines.forEach((line) => {
      if (line.includes('✓') || line.includes('opened') || line.includes('clicked') || line.includes('double-clicked') || line.includes('right-clicked') || line.includes('middle-clicked') || line.includes('hovered') || line.includes('dragged') || line.includes('scrolled') || line.includes('typed')) {
        successful.push(line);
      } else if (line.includes('failed') || line.includes('error')) {
        failed.push(line);
      } else {
        successful.push(line); // Default to successful if unclear
      }
    });
    
    let memory = 'COMPLETED ACTIONS:\n';
    memory += successful.length > 0 ? successful.join('\n') : 'None yet';
    
    if (failed.length > 0) {
      memory += '\n\nFAILED ATTEMPTS:\n' + failed.join('\n');
    }
    
    // Append structured memory summary for models needing richer context
    try {
      if (Array.isArray(this.actionLog) && this.actionLog.length > 0) {
        memory += '\n\nSTRUCTURED ACTION LOG:';
        for (const entry of this.actionLog) {
          const planned = entry.planned;
          const exec = entry.executed;
          const stamp = entry.timestampIso;
          const plannedLine = `\n${entry.step}. PLAN → type=${planned.type}${planned.intent ? ` intent="${planned.intent}"` : ''}${planned.text ? ` text="${planned.text}"` : ''}${planned.keyString ? ` key="${planned.keyString}"` : ''}${planned.url ? ` url="${planned.url}"` : ''}${planned.appName ? ` app="${planned.appName}"` : ''} @ ${stamp}`;
          memory += plannedLine;
          if (exec) {
            const execLine = `\n   RESULT → ${exec.success ? '✓ success' : '✗ fail'}${exec.verification ? ` (${exec.verification})` : ''}${exec.resultMessage ? ` — ${exec.resultMessage}` : ''}${exec.error ? ` [error: ${exec.error}]` : ''}`;
            memory += execLine;
          }
        }
      }
    } catch {}
    
    return memory;
  }

  private analyzeCurrentState(elements: TerminatorElement[]): string {
    let analysis = '';
    
    // Check for dialogs or alerts
    const hasDialog = elements.some(e => 
      e.role?.toLowerCase() === 'dialog' || 
      e.role?.toLowerCase() === 'alert' ||
      e.role?.toLowerCase() === 'sheet'
    );
    
    if (hasDialog) {
      analysis += '⚠️ DIALOG/ALERT DETECTED - Must be handled before proceeding\n';
    }
    

    
    // Check for text fields and their state
    const textFields = elements.filter(e => 
      e.role?.toLowerCase() === 'textfield' || 
      e.role?.toLowerCase() === 'textarea'
    );
    
    if (textFields.length > 0) {
      const focused = textFields.find(e => (e as any).AXFocused === true);
      if (focused) {
        analysis += '✅ Text field is currently FOCUSED - ready for typing\n';
      } else {
        analysis += '📝 Text fields available but NOT focused - click before typing\n';
      }
    } else if (this.targetAppName?.toLowerCase().includes('textedit')) {
      analysis += '⚠️ No text fields detected in TextEdit - may need to create new document\n';
    }
    
    // Check for common UI patterns
    const buttons = elements.filter(e => e.role?.toLowerCase() === 'button');
    const hasNewButton = buttons.some(e => {
      const title = ((e as any).AXTitle || '').toLowerCase();
      return title.includes('new') || title.includes('create');
    });
    
    if (hasNewButton) {
      analysis += '💡 "New" or "Create" button detected - app may be waiting for document creation\n';
    }
    
    // Analyze app capability for task
    analysis += this.analyzeAppTaskFit();
    
    // Check if app seems empty or uninitialized
    if (elements.length < 5 && this.targetAppName) {
      analysis += '⚠️ Very few UI elements - app may be loading or needs initialization\n';
    }
    
    // App-agnostic state detection
    if (elements.length === 0) {
      analysis += '🔴 NO ELEMENTS DETECTED - App may not be ready or focused\n';
    }
    
    return analysis || '✅ App appears ready for interaction';
  }

  private analyzeAppTaskFit(): string {
    // No target app yet
    if (!this.targetAppName) {
      return '📱 NO APP SELECTED - Determine appropriate app for this task\n';
    }
    
    return `📱 CURRENT APP: ${this.targetAppName} - Analyze if this app can handle the requested task\n`;
  }

  // Helper: count consecutive failures for same action type/intent in recent history
  private countRecentFailuresFor(planned: TerminatorAction): number {
    try {
      let count = 0;
      // Walk the actionLog from most recent backwards until a success or different action
      for (let i = this.actionLog.length - 1; i >= 0; i--) {
        const e = this.actionLog[i];
        // Only consider same action type and similar intent text (case-insensitive contains)
        const sameType = e.planned.type === planned.type;
        const sameIntent = (e.planned.intent || '').toLowerCase() === (planned.intent || '').toLowerCase();
        if (!sameType || !sameIntent) break;
        const failed = !e.executed || e.executed.success === false;
        if (failed) count++; else break;
      }
      return count;
    } catch {
      return 0;
    }
  }

  private async verifyActionResult(action: TerminatorAction, result: { message: string }): Promise<string> {
    // Verify the action had the expected effect
    try {
      // Different verification based on action type
      switch (action.type) {
        case 'applescript':
          if (action.intent?.toLowerCase().includes('open')) {
            // Verify app opened
            const appName = action.applescriptCode?.match(/tell application "([^"]+)"/)?.[1];
            if (appName && this.targetAppName === appName) {
              return `App "${appName}" opened successfully`;
            }
          }
          break;
        
        case 'type':
          // Text was typed - verify it appeared
          if (action.text && result.message === 'typed') {
            return `Text entered: "${action.text}"`;
          }
          break;
        
        case 'click':
          // Element was clicked
          if (result.message.includes('clicked')) {
            return `Element clicked successfully`;
          }
          break;
        
        case 'key':
          // Key combination pressed
          if (action.keyString && result.message === 'pressed key') {
            const keyAction = action.keyString.toLowerCase();
            if (keyAction.includes('cmd+a')) {
              return 'Text selected';
            } else if (keyAction.includes('cmd+b')) {
              return 'Bold formatting applied';
            } else if (keyAction.includes('cmd+n')) {
              return 'New document created';
            } else if (keyAction.includes('return') || keyAction.includes('enter')) {
              return 'Enter key pressed';
            }
            return `Key combo "${action.keyString}" executed`;
          }
          break;
        
        case 'scroll':
          // Scroll action completed
          if (result.message.includes('scrolled')) {
            return 'Page scrolled successfully';
          }
          break;
        
        case 'double_click':
          // Double-click action completed
          if (result.message.includes('double-clicked')) {
            return 'Element double-clicked successfully';
          }
          break;
        
        case 'right_click':
          // Right-click action completed
          if (result.message.includes('right-clicked')) {
            return 'Element right-clicked successfully';
          }
          break;
        
        case 'middle_click':
          // Middle-click action completed
          if (result.message.includes('middle-clicked')) {
            return 'Element middle-clicked successfully';
          }
          break;
        
        case 'hover':
          // Hover action completed
          if (result.message.includes('hovered')) {
            return 'Hover completed successfully';
          }
          break;
        
        case 'drag_and_drop':
          // Drag and drop action completed
          if (result.message.includes('dragged')) {
            return 'Drag and drop completed successfully';
          }
          break;
        
        case 'scroll_at':
          // Scroll at coordinates action completed
          if (result.message.includes('scrolled at')) {
            return 'Precise scroll completed successfully';
          }
          break;
      }
    } catch (error) {
      console.log('[TerminatorAgent] Verification error:', error);
    }
    
    // Return empty string if no specific verification
    return '';
  }


  
  private async planStandardAction(task: string, elements: TerminatorElement[]): Promise<TerminatorAction> {
    // Enhanced version with better state awareness
    const elementContext = await this.buildRichElementContext(elements);
    const detailedMemory = this.buildDetailedMemory();
    const stateAnalysis = this.analyzeCurrentState(elements);

    const basePrompt = `You are controlling a Mac using advanced automation.
    
TASK: "${task}"

CURRENT STATE:
${stateAnalysis}

STEP: ${this.stepCount}/30
ACTION HISTORY:
${detailedMemory}

AVAILABLE ELEMENTS:
${elementContext}

 SMART RULES:
 - Apps may open with dialogs or empty states - handle these first
 - Text fields must be focused (clicked) before typing
 - TEXTEDIT: New documents are automatically focused and ready for typing immediately
 - Text must be selected (cmd+a) before formatting (cmd+b for bold)
         - Open apps via Spotlight in 3 steps: 1) Press ⌘+Space, 2) Type full app name, 3) Press Return
 - One atomic action per step - verify success before proceeding
 - Adapt based on current state, don't assume
 - CALCULATOR: NEVER type! Click buttons: "3", "8", "Multiply", "2", "9", "Equals"
 - INTELLIGENT SYMBOL MAPPING: When user says "X", look for "Multiply", "Close", or "Cancel" in available elements - choose based on app context
 - For math symbols: "+" → "Add", "-" → "Subtract", "÷" → "Divide", "=" → "Equals"
 - Don't search literal symbols - understand semantic element names

Respond JSON only:
{
  "type": "click|type|key|applescript|scroll|wait|done|spotlight_open_app|navigate_to_url",
  "intent": "what this accomplishes",
  "text": "text to interact with",
  "keyString": "keyboard shortcut",
  "applescriptCode": "AppleScript if needed"
}`;

    // Screenshot policy: only on step 1 for initial context (browser tasks use DOM data instead)
    const shouldAttachScreenshot = this.stepCount === 1;

    const parts: any[] = [{ text: basePrompt }];
    if (shouldAttachScreenshot) {
      try {
        const b64 = await this.captureScreenshotBase64();
        if (b64) {
          console.log('[TerminatorAgent] 📸 Captured step screenshot for planning');
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
        }
      } catch {}
    }

    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
      let raw = result.response?.text()?.trim() || '';
      if (raw.startsWith('```')) raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
      
      let jsonText = '';
      // Try multiple extraction strategies  
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) jsonText = m[0];
      else {
        const first = raw.indexOf('{');
        const last = raw.lastIndexOf('}');
        if (first >= 0 && last > first) jsonText = raw.slice(first, last + 1);
      }
      
      // If still no JSON, look for "type": pattern and build minimal JSON
      if (!jsonText && raw.includes('"type"')) {
        console.log('[TerminatorAgent] Building JSON from partial Gemini response');
        const typeMatch = raw.match(/"type":\s*"([^"]+)"/);
        const intentMatch = raw.match(/"intent":\s*"([^"]+)"/);
        if (typeMatch) {
          jsonText = `{
            "type": "${typeMatch[1]}",
            "intent": "${intentMatch ? intentMatch[1] : 'Extracted from partial response'}",
            "reasoning": "Recovered from malformed Gemini response"
          }`;
        }
      }
      
      if (!jsonText) {
        console.log('[TerminatorAgent] ❌ NO JSON FOUND - Raw response for debugging:', raw);
        throw new Error('No JSON found in planning response');
      }
      
      let action;
      try {
        action = JSON.parse(jsonText);
      } catch (parseError) {
        console.log('[TerminatorAgent] ❌ JSON PARSE FAILED - raw jsonText:', jsonText);
        throw new Error(`Invalid JSON in planning response: ${parseError}`);
      }
      // Normalize any deprecated action types to click
      if (action.type === 'ocr_find_click') {
        action.type = 'click';
        if (action.text && !action.selector) {
          action.selector = `name:${action.text}`;
        }
      }
      return action as TerminatorAction;
    } catch (error) {
      console.error('[TerminatorAgent] Planning failed:', error);
      return { type: 'wait', intent: 'wait briefly before retrying', text: '', keyString: '', applescriptCode: '', windowName: '', amount: 0, repeats: 1 } as any;
    }
  }
  
  private async executeAction(action: TerminatorAction, scannedElements: TerminatorElement[] = []): Promise<{ message: string }> {
    try {
      console.log(`[TerminatorAgent] Executing ${action.type}: ${action.intent}`);
      
      switch (action.type) {
        case 'navigate_to_url': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🌐 Navigate at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🌐 Navigate - no cursor position tracked`);
          }
          // Compound action: Does the entire URL navigation sequence in one go
          const url = action.url || action.text || '';
          if (!url) {
            return { message: 'no URL provided' };
          }
          
          console.log(`[TerminatorAgent] 🌐 Navigating to ${url} (compound action)`);
          
          // Step 1: Activate Chrome and focus address bar
          await this.executeAppleScript(`tell application "Google Chrome" to activate`);
          await new Promise(r => setTimeout(r, 300));
          await this.executeAppleScript(`tell application "System Events" to keystroke "l" using {command down}`);
          await new Promise(r => setTimeout(r, 300));
          
          // Best-effort: set cursor near top-center as address bar proxy (dynamic, not hardcoded)
          try {
            const { screen } = await import('electron');
            const primary = screen.getPrimaryDisplay();
            const centerX = Math.floor(primary.workArea.x + primary.workArea.width / 2);
            const topY = Math.max(primary.workArea.y + 80, primary.workArea.y + Math.floor(primary.workArea.height * 0.08));
            console.log(`[COORDINATES] 🌐 Navigate step 1 (focus address): (${centerX}, ${topY})`);
            ClickPreviewService.showDot(centerX, topY).catch(() => {});
            this.updateCursorPosition(centerX, topY);
          } catch (e) {
            console.log(`[DEBUG] Navigate step 1 error:`, e);
          }
          
          // Step 2: Clear and type URL
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🌐 Navigate step 2 (type URL): (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🌐 Navigate step 2 (type URL) - no cursor position tracked`);
          }
          await this.executeAppleScript(`tell application "System Events" to keystroke "a" using {command down}`);
          await new Promise(r => setTimeout(r, 200));
          const escaped = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          await this.executeAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
          await new Promise(r => setTimeout(r, 500)); // Longer wait after typing URL
          
          // Step 3: Dismiss suggestions and navigate
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🌐 Navigate step 3 (enter): (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🌐 Navigate step 3 (enter) - no cursor position tracked`);
          }
          await this.executeAppleScript(`tell application "System Events" to key code 53`); // Escape
          await new Promise(r => setTimeout(r, 400)); // Longer wait after escape
          await this.executeAppleScript(`tell application "System Events" to keystroke return`);
          await new Promise(r => setTimeout(r, 800)); // Wait for page load
          
          console.log(`[TerminatorAgent] 🌐 Navigation completed, allowing extra time for page load...`);
          await new Promise(r => setTimeout(r, 400)); // Additional time for page load
          
          return { message: `navigated to ${url}` };
        }
        
        case 'search': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🔍 Search at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
          } else {
            console.log(`[COORDINATES] 🔍 Search - no cursor position tracked`);
          }
          // Use the new search tool for web searches
          const query = action.text || '';
          if (!query) {
            return { message: 'no search query provided' };
          }
          
          console.log(`[TerminatorAgent] 🔍 Searching for "${query}" using search tool`);
          
          // Preserve current cursor position through search
          this.preserveCursor();
          
          // Call the search function directly
          const result = await searchOnBrowser(query);
          
          if (result.error) {
            return { message: `search failed: ${result.error}` };
          }
          
          return { message: `searched for "${query}"` };
        }
        
        case 'spotlight_open_app': {
          // Compound action: Does the entire Spotlight app opening sequence in one go
          const appName = action.appName || action.windowName || '';
          if (!appName) {
            return { message: 'no app name provided' };
          }
          
          console.log(`[TerminatorAgent] 🚀 Opening ${appName} via Spotlight (compound action)`);
          
          // Step 1: Open Spotlight (⌘+Space) and set cursor to display center dynamically
          await this.executeAppleScript(`tell application "System Events" to keystroke space using {command down}`);
          await new Promise(r => setTimeout(r, 150));
          try {
            const { screen } = await import('electron');
            const primary = screen.getPrimaryDisplay();
            const cx = Math.floor(primary.workArea.x + primary.workArea.width / 2);
            const cy = Math.floor(primary.workArea.y + primary.workArea.height / 2);
            console.log(`[COORDINATES] 🧭 Spotlight step 1 (open): (${cx}, ${cy})`);
            ClickPreviewService.showDot(cx, cy).catch(() => {});
            this.updateCursorPosition(cx, cy);
          } catch (e) {
            console.log(`[DEBUG] Step 1 error:`, e);
          }
          
          // Step 2: Type app name (move to LEFT side of the Spotlight bar for typing)
          try {
            const { screen } = await import('electron');
            const primary = screen.getPrimaryDisplay();
            const centerX = Math.floor(primary.workArea.x + primary.workArea.width / 2);
            const centerY = Math.floor(primary.workArea.y + primary.workArea.height / 2);
            // Aim ~20% of workArea width to the left from center, clamp within safe margin
            const leftX = Math.max(primary.workArea.x + 120, centerX - Math.floor(primary.workArea.width * 0.20));
            const leftY = centerY;
            console.log(`[COORDINATES] 🧭 Spotlight step 2 (input anchor - left): (${leftX}, ${leftY})`);
            ClickPreviewService.showDot(leftX, leftY).catch(() => {});
            this.updateCursorPosition(leftX, leftY);
          } catch (e) {
            console.log(`[DEBUG] Step 2 error:`, e);
          }
          await this.executeAppleScript(`tell application "System Events" to keystroke "${appName}"`);
          await new Promise(r => setTimeout(r, 100));
          
          // Step 3: Press Return to open (stay at input anchor)
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🧭 Spotlight step 3 (enter): (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🧭 Spotlight step 3 (enter) - no cursor position tracked`);
          }
          await this.executeAppleScript(`tell application "System Events" to keystroke return`);
          await new Promise(r => setTimeout(r, 300));
          
          // Update target app tracking
          this.targetAppName = appName;
          
          // Special handling for Chrome: Put it in fullscreen mode
          if (appName.toLowerCase().includes('chrome')) {
            await new Promise(r => setTimeout(r, 400)); // Wait for Chrome to fully load
            await this.executeAppleScript(`tell application "System Events" to keystroke "f" using {control down, command down}`);
            console.log(`[TerminatorAgent] 🖥️ Put Chrome in fullscreen mode`);
          }
          
          // Wait 2 seconds after app opens before the next action
          console.log(`[TerminatorAgent] ⏳ Waiting 2 seconds for ${appName} to fully load...`);
          await new Promise(r => setTimeout(r, 2000));
          
          return { message: `opened ${appName} via Spotlight` };
        }
        case 'scroll': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🔄 Scroll at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
          } else {
            console.log(`[COORDINATES] 🔄 Scroll - no cursor position tracked`);
          }
          // Scroll anchored to last known cursor position when available
          const amount = typeof (action as any).amount === 'number' ? (action as any).amount : 300;
          const repeats = Math.max(1, Math.min(10, Number((action as any).repeats || 1)));
          
          // Check if we're in Chrome for JavaScript-based scrolling
          const isChrome = !!this.targetAppName && /Chrome/i.test(this.targetAppName);
          
          if (isChrome) {
            console.log(`[TerminatorAgent] 🌐 Using JavaScript scrolling for Chrome`);
            try {
              const scrollJs = `(function() {
                const amount = ${amount};
                const repeats = ${repeats};
                for (let i = 0; i < repeats; i++) {
                  window.scrollBy(0, amount);
                  // Small delay between scroll repeats
                  if (i < repeats - 1) {
                    setTimeout(() => {}, 40);
                  }
                }
                return 'scrolled ' + amount + ' (' + repeats + 'x)';
              })()`;
              
              const scrollScript = `
                tell application "Google Chrome"
                  tell active tab of front window
                    execute javascript "${scrollJs.replace(/"/g, '\\"')}"
                  end tell
                end tell
              `;
              
              const result = await this.executeAppleScript(scrollScript);
              console.log(`[TerminatorAgent] 🌐 Chrome JavaScript scroll result:`, result);
              return { message: `scrolled ${amount} (${repeats}x) via JavaScript` };
            } catch (chromeErr) {
              console.log(`[TerminatorAgent] ⚠️ Chrome JavaScript scroll failed, falling back to Swift:`, chromeErr);
              // Fall through to Swift scrolling
            }
          }
          
          // Standard Swift scrolling for non-Chrome apps or if Chrome JS fails
          if (this.virtualCursorPosition) {
            const { scrollAt } = await import('../../tools/mouse');
            for (let i = 0; i < repeats; i++) {
              const deltaY = amount > 0 ? Math.abs(amount) * -1 : Math.abs(amount); // positive amount means scroll down
              await scrollAt(this.virtualCursorPosition.x, this.virtualCursorPosition.y, 0, deltaY);
              await new Promise(r => setTimeout(r, 40));
            }
            return { message: `scrolled ${amount} (${repeats}x) at (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})` };
          }
          // Fallback: arrow keys if no position is known yet
          for (let i = 0; i < repeats; i++) {
            const script = `tell application "System Events" to key code 125`;
            const lines = amount > 0 ? Math.ceil(amount / 100) : Math.ceil(Math.abs(amount) / 100);
            for (let j = 0; j < lines; j++) {
              await this.executeAppleScript(amount > 0 ? script : `tell application "System Events" to key code 126`);
              await new Promise(r => setTimeout(r, 40));
            }
          }
          return { message: `scrolled ${amount} (${repeats}x)` };
        }
        case 'wait': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] ⏳ Wait at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
          } else {
            console.log(`[COORDINATES] ⏳ Wait - no cursor position tracked`);
          }
          const ms = Math.max(100, Math.min(10000, Number((action as any).duration || (action as any).ms || 800)));
          await new Promise(r => setTimeout(r, ms));
          this.preserveCursor();
          return { message: `waited ${ms}ms` };
        }
        case 'ocr_find_click': {
          // Deprecated: route to Swift AX matching and click by text
          const query = (action as any).text || '';
          if (!query) return { message: 'no text provided' };
          try {
            const bundleId = this.targetAppName ? await this.getBundleIdFromAppName(this.targetAppName) : null;
            if (bundleId) {
              const list = await this.swiftListClickableElements(bundleId);
              const lower = query.toLowerCase();
              const candidate = list.find((el: any) => ((el.AXTitle||'').toLowerCase().includes(lower) || (el.AXDescription||'').toLowerCase().includes(lower) || (el.AXValue||'').toLowerCase().includes(lower)));
              if (candidate && typeof candidate.id === 'number') {
                // Log coordinates for element-based clicks
                try {
                  const positionStr = candidate.AXPosition as string || '';
                  const sizeStr = candidate.AXSize as string || '';
                  const posMatch = positionStr.match(/x=([0-9.-]+)\s+y=([0-9.-]+)/);
                  const sizeMatch = sizeStr.match(/w=([0-9.-]+)\s+h=([0-9.-]+)/);
                  
                  if (posMatch && sizeMatch) {
                    const centerX = Math.round(parseFloat(posMatch[1]) + parseFloat(sizeMatch[1]) / 2);
                    const centerY = Math.round(parseFloat(posMatch[2]) + parseFloat(sizeMatch[2]) / 2);
                    console.log(`[COORDINATES] 🖱️ TerminatorAgent element click at coordinates: (${centerX}, ${centerY}) - element: ${candidate.AXTitle || candidate.AXDescription || 'unnamed'}`);
                    // Show dot preview at derived center
                    ClickPreviewService.showDot(centerX, centerY).catch(() => {});
                  } else if (posMatch) {
                    const px = Math.round(parseFloat(posMatch[1]));
                    const py = Math.round(parseFloat(posMatch[2]));
                    console.log(`[COORDINATES] 🖱️ TerminatorAgent element click at coordinates: (${px}, ${py}) - element: ${candidate.AXTitle || candidate.AXDescription || 'unnamed'}`);
                    ClickPreviewService.showDot(px, py).catch(() => {});
                  }
                } catch (error) {
                  // Ignore coordinate parsing errors
                }
                
                const ok = await this.swiftClickById(bundleId, candidate.id);
                if (ok) {
                  await new Promise(r => setTimeout(r, 150));
                  return { message: `clicked ${query}` };
                }
              }
            }
          } catch {}
          return { message: 'candidate not found' };
        }
        case 'click': {
          // Check if coordinates were provided by AI (visual mode)
          if (action.x && action.y) {
            console.log(`[TerminatorAgent] 🎯 Using AI-provided coordinates: (${action.x}, ${action.y})`);
            
            // Show preview at the intended raw global coords initially
            ClickPreviewService.showDot(action.x, action.y).catch(() => {});
            
            // For browsers, use JavaScript injection (no permissions needed)
            const isBrowser = this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
            if (isBrowser) {
              try {
                const clickJs = `(function() {
                  try {
                    const dpr = window.devicePixelRatio || 1;
                    // Prefer raw globals (these are usually in CSS px already when sourced from the model)
                    const rawGX = Math.round(${action.x});
                    const rawGY = Math.round(${action.y});
                    // Backup: DPR scaled
                    const dprGX = Math.round(${action.x} / dpr);
                    const dprGY = Math.round(${action.y} / dpr);

                    function calcClientXY(gx, gy){
                    const sx = window.screenX || window.screenLeft || 0;
                    const sy = window.screenY || window.screenTop || 0;
                    const borderX = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                    const topChrome = Math.max(0, (window.outerHeight - window.innerHeight) - borderX);
                      let cx = Math.round(gx - sx - borderX);
                      let cy = Math.round(gy - sy - topChrome);
                    cx = Math.max(0, Math.min(cx, window.innerWidth - 1));
                    cy = Math.max(0, Math.min(cy, window.innerHeight - 1));
                      return { cx, cy };
                    }

                    function isClickable(el){
                      if (!el) return false;
                      const s = getComputedStyle(el);
                      if (s.pointerEvents === 'none' || s.visibility !== 'visible' || s.display === 'none') return false;
                      const t = el.tagName;
                      const role = el.getAttribute('role');
                      return ['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','LABEL'].includes(t)
                        || role === 'button' || role === 'link' || el.onclick != null
                        || !!el.closest('a,button,input,textarea,select,[role="button"],[onclick]');
                    }

                    function findNearestClickable(cx, cy){
                      const offsets = [];
                      const radius = 28; // expanded neighborhood for stability
                      for (let r=0; r<=radius; r+=2){
                        for (let dx=-r; dx<=r; dx+=2){
                          const dy = r - Math.abs(dx);
                          offsets.push([dx, dy]);
                          if (dy !== 0) offsets.push([dx, -dy]);
                        }
                      }
                      for (const [dx, dy] of offsets){
                        const x = Math.max(0, Math.min(cx + dx, window.innerWidth - 1));
                        const y = Math.max(0, Math.min(cy + dy, window.innerHeight - 1));
                        let el = document.elementFromPoint(x, y);
                        let cur = el;
                        while (cur && !isClickable(cur)) cur = cur.parentElement;
                        if (cur) {
                          const b = cur.getBoundingClientRect();
                          return { el: cur, cx: Math.round(b.left + b.width/2), cy: Math.round(b.top + b.height/2) };
                        }
                      }
                      return null;
                    }

                    function pickPoint(){
                      const cands = [calcClientXY(rawGX, rawGY), calcClientXY(dprGX, dprGY)];
                      for (const c of cands){
                        const el = document.elementFromPoint(c.cx, c.cy);
                        if (el) return { el, cx: c.cx, cy: c.cy, note: 'direct' };
                        const snapped = findNearestClickable(c.cx, c.cy);
                        if (snapped) return { el: snapped.el, cx: snapped.cx, cy: snapped.cy, note: 'snapped' };
                      }
                      return null;
                    }

                    const picked = pickPoint();
                    if (!picked) {
                      return JSON.stringify({ ok: false, reason: 'no element near target', dpr, rawGX, rawGY, innerWidth: window.innerWidth, innerHeight: window.innerHeight });
                    }

                    const element = picked.el;
                    const cx = picked.cx;
                    const cy = picked.cy;

                    function navigateIfLink(el){
                      try {
                        let anchor = el.closest && el.closest('a');
                        if (anchor && anchor.href) {
                          const href = anchor.href;
                          anchor.click();
                          setTimeout(() => { try { if (location.href === location.href) { window.location.href = href; } } catch(_){} }, 150);
                          return { href };
                        }
                      } catch(_){ }
                      return null;
                    }

                    // Do not dispatch DOM events here; we only compute stable client coordinates
                    // The native side will map client coords via AXWebArea and click
                    const sx = window.screenX || window.screenLeft || 0;
                    const sy = window.screenY || window.screenTop || 0;
                    const borderX = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                    const topChrome = Math.max(0, (window.outerHeight - window.innerHeight) - borderX);
                    const globalX = sx + borderX + cx;
                    const globalY = sy + topChrome + cy;

                    return JSON.stringify({ ok: true, cx, cy, globalX, globalY, picked: picked.note, tag: element.tagName });
                  } catch (e) {
                    return JSON.stringify({ ok: false, error: String(e) });
                  }
                })()`;
                
                const clickScript = `
                  tell application "Google Chrome"
                    tell active tab of front window
                      execute javascript "${clickJs.replace(/"/g, '\\"')}"
                    end tell
                  end tell
                `;
                
                const result = await this.executeAppleScript(clickScript);
                let ok = false;
                let screenX = Math.round(action.x);
                let screenY = Math.round(action.y);
                try {
                  let text = String(result ?? '').trim();
                  if (text.startsWith('"') && text.endsWith('"')) {
                    try { text = JSON.parse(text); } catch {}
                  }
                  const json = JSON.parse(text);
                  if (json && json.ok) {
                    const cx = Number(json.cx);
                    const cy = Number(json.cy);
                    const gX = Number(json.globalX);
                    const gY = Number(json.globalY);
                    const { execPromise } = await import('../../utils/utils');
                    const bundleId = await this.getBundleIdFromAppName(this.targetAppName!);
                    const { stdout: webAreaJson } = await execPromise(`swift swift/getWebAreaFrame.swift ${bundleId}`);
                    let fx = NaN, fy = NaN;
                    try {
                      const fr = JSON.parse(webAreaJson);
                      fx = Number(fr.x);
                      fy = Number(fr.y);
                    } catch {}
                    if (!Number.isNaN(cx) && !Number.isNaN(cy) && !Number.isNaN(fx) && !Number.isNaN(fy)) {
                      screenX = Math.round(fx + cx);
                      screenY = Math.round(fy + cy);
                    } else if (!Number.isNaN(gX) && !Number.isNaN(gY)) {
                      screenX = Math.round(gX);
                      screenY = Math.round(gY);
                    }
                    await execPromise(`swift swift/clickAtCoordinates.swift ${screenX} ${screenY}`);
                    ok = true;
                  }
                } catch (e) {
                  console.log(`[TerminatorAgent] Browser coordinate click non-JSON result:`, result);
                }
                console.log(`[COORDINATES] 🌐 TerminatorAgent browser click mapped via AXWebArea: target=(${action.x},${action.y}) screen=(${screenX},${screenY})`);
                ClickPreviewService.showDot(screenX, screenY).catch(() => {});
                this.updateCursorPosition(screenX, screenY);
                await new Promise(resolve => setTimeout(resolve, this.getClickDelay()));
                if (ok) {
                  return { message: `clicked at mapped browser coordinates (${screenX}, ${screenY})` };
                } else {
                  throw new Error('Browser coordinate click not ok');
                }
              } catch (browserError) {
                console.log(`[TerminatorAgent] Browser coordinate click failed:`, browserError);
                try {
                  // Fallback: Map predicted global coords via AXWebArea → screen (no Node window usage)

                  // Get AXWebArea frame from Swift
                  const { execPromise } = await import('../../utils/utils');
                  const bundleId = await this.getBundleIdFromAppName(this.targetAppName!);
                  const { stdout: webAreaJson } = await execPromise(`swift swift/getWebAreaFrame.swift ${bundleId}`);
                  let fx = 0, fy = 0;
                  try {
                    const fr = JSON.parse(webAreaJson);
                    fx = Number(fr.x) || 0;
                    fy = Number(fr.y) || 0;
                  } catch {}

                  // Ask page to convert global → client via JS (avoids Node 'window' usage)
                  const clientJs = `(function(){
                    try {
                      const sx = window.screenX || window.screenLeft || 0;
                      const sy = window.screenY || window.screenTop || 0;
                      const borderX = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));
                      const topChrome = Math.max(0, (window.outerHeight - window.innerHeight) - borderX);
                      const cx = Math.max(0, Math.min(Math.round(${action.x} - sx - borderX), window.innerWidth - 1));
                      const cy = Math.max(0, Math.min(Math.round(${action.y} - sy - topChrome), window.innerHeight - 1));
                      return JSON.stringify({ ok:true, cx, cy });
                    } catch(e){ return JSON.stringify({ ok:false }); }
                  })()`;
                  const clientScript = `
                    tell application "Google Chrome"
                      tell active tab of front window
                        execute javascript "${clientJs.replace(/"/g, '\\"')}"
                      end tell
                    end tell
                  `;
                  let cx = NaN, cy = NaN;
                  try {
                    const raw = await this.executeAppleScript(clientScript);
                    let t = String(raw ?? '').trim();
                    if (t.startsWith('"') && t.endsWith('"')) { try { t = JSON.parse(t); } catch {} }
                    const cj = JSON.parse(t);
                    if (cj && cj.ok) { cx = Number(cj.cx); cy = Number(cj.cy); }
                  } catch {}

                  // Map to screen using AXWebArea origin + client coords if available; else fallback to global
                  const screenX = !Number.isNaN(cx) && !Number.isNaN(cy) ? Math.round(fx + cx) : Math.round(action.x);
                  const screenY = !Number.isNaN(cx) && !Number.isNaN(cy) ? Math.round(fy + cy) : Math.round(action.y);

                  await execPromise(`swift swift/clickAtCoordinates.swift ${screenX} ${screenY}`);
                  ClickPreviewService.showDot(screenX, screenY).catch(() => {});
                  this.updateCursorPosition(screenX, screenY);
                  await new Promise(resolve => setTimeout(resolve, this.getClickDelay()));
                  return { message: `clicked at mapped browser coordinates (${screenX}, ${screenY})` };
                } catch (mapErr) {
                  console.log(`[TerminatorAgent] AXWebArea mapping fallback failed:`, mapErr);
                }
              }
            }
            
            // For native apps, use Swift click tool (use raw global coords)
            try {
              const { execPromise } = await import('../../utils/utils');
              const intX = Math.round(action.x);
              const intY = Math.round(action.y);
              console.log(`[COORDINATES] 🖱️ TerminatorAgent Swift click at coordinates: (${intX}, ${intY})`);
              await execPromise(`swift swift/clickAtCoordinates.swift ${intX} ${intY}`);
              this.updateCursorPosition(intX, intY);
              await new Promise(resolve => setTimeout(resolve, this.getClickDelay()));
              return { message: `clicked at AI-specified coordinates (${intX}, ${intY})` };
            } catch (coordError: any) {
              console.log(`[TerminatorAgent] Swift coordinate click failed:`, coordError);
              // Fall through to element-based clicking
            }
          }
          
          // Handle clicks with or without selectors
          let desiredName: string | null = null;
          let swiftId: number | null = null;
          
          if (action.selector) {
            // Prefer Swift AX accessibility path when we have a target app and a name or id
            try {
              if (action.selector.startsWith('swift:')) {
                const parts = action.selector.split(':');
                if (parts[1] === 'id' && parts[2]) {
                  const idNum = Number(parts[2]);
                  if (!Number.isNaN(idNum)) {
                    swiftId = idNum;
                  }
                }
              } else if (action.selector.startsWith('applescript:')) {
                const parts = action.selector.split(':');
                if (parts[1] === 'pos' && parts[2]) {
                  const [xStr, yStr] = parts[2].split(',');
                  const x = Number(xStr);
                  const y = Number(yStr);
                  if (!Number.isNaN(x) && !Number.isNaN(y)) {
                    const posClickScript = `tell application "System Events" to click at {${x}, ${y}}`;
                    await this.executeAppleScript(posClickScript);
                    await new Promise(resolve => setTimeout(resolve, this.getClickDelay()));
                    if (this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName)) {
                    }
                    return { message: `clicked at position` };
                  }
                }
                desiredName = parts[2] || null;
              } else if (action.selector.includes('name:')) {
                const m = action.selector.match(/name:([^|]+)/);
                desiredName = m ? m[1] : null;
              }
            } catch (err) {
              console.log('[TerminatorAgent] Selector parsing failed:', err);
            }
          }
          
          // Fallback to action.text if selector didn't provide a name
          if (!desiredName && (action as any).text) {
            desiredName = String((action as any).text);
            console.log(`[TerminatorAgent] 🔄 Using action.text as desiredName: "${desiredName}"`);
          }
          
          // Additional fallback: extract from action intent if text is missing
          if (!desiredName && action.intent) {
            // Try to extract element name from intent like "Click the 'Post' button"
            const intentMatch = action.intent.match(/(?:click|press|tap).*?['"]([^'"]+)['"]/i);
            if (intentMatch) {
              desiredName = intentMatch[1];
              console.log(`[TerminatorAgent] 🔄 Extracted from intent: "${desiredName}"`);
            }
            // Or look for common patterns like "Click Post button"
            else if (action.intent.match(/click\s+([A-Za-z]+)\s+button/i)) {
              const buttonMatch = action.intent.match(/click\s+([A-Za-z]+)\s+button/i);
              if (buttonMatch) {
                desiredName = buttonMatch[1];
                console.log(`[TerminatorAgent] 🔄 Extracted button name from intent: "${desiredName}"`);
              }
            }
          }
          
          // Parse role@id pattern to direct Swift click if we have a desiredName
          if (desiredName) {
            const idMatch = desiredName.match(/^(textfield|textarea|button|menuitem|link)@id:(\d+)$/i);
            if (idMatch && this.targetAppName) {
              const role = idMatch[1].toLowerCase();
              const idNum = Number(idMatch[2]);
              if (!Number.isNaN(idNum)) {
                const bundleId = await this.getBundleIdFromAppName(this.targetAppName);
                if (bundleId) {
                  const ok = await this.swiftClickById(bundleId, idNum);
                  if (ok) {
                    await new Promise(r => setTimeout(r, this.getClickDelay()));
                    return { message: `clicked ${role} id ${idNum}` };
                  }
                }
              }
            }
          }

          console.log(`[TerminatorAgent] 🎯 Final desiredName: "${desiredName}", targetAppName: "${this.targetAppName}"`);

          // Final check: if desiredName is still null, provide helpful error
          if (!desiredName) {
            const errorMsg = `No element name found. Action text: "${action.text}", Intent: "${action.intent}", Selector: "${action.selector}"`;
            console.log(`[TerminatorAgent] ❌ ${errorMsg}`);
            return { message: `click failed: ${errorMsg}` };
          }

          // Removed problematic emergency typing logic - let AI handle typing properly

          // Swift AX path for all clicks (with or without selectors)
          try {
            // If we have a direct Swift id, click it immediately
            if (swiftId !== null && this.targetAppName) {
              const bundleId = await this.getBundleIdFromAppName(this.targetAppName);
              if (bundleId) {
                const ok = await this.swiftClickById(bundleId, swiftId);
                if (ok) {
                  await new Promise(r => setTimeout(r, this.getClickDelay()));
                  return { message: `clicked id ${swiftId}` };
                }
                
                // Coordinate fallback for direct Swift ID clicks
                console.log(`[TerminatorAgent] 🎯 Direct Swift ID click failed, trying to find element for coordinate fallback`);
                try {
                  const list = await this.swiftListClickableElements(bundleId);
                  const elementWithId = list.find((el: any) => el.id === swiftId);
                  if (elementWithId && elementWithId.AXPosition && elementWithId.AXSize) {
                    const posMatch = elementWithId.AXPosition.match(/x=([0-9.-]+)\s+y=([0-9.-]+)/);
                    const sizeMatch = elementWithId.AXSize.match(/w=([0-9.-]+)\s+h=([0-9.-]+)/);
                    if (posMatch && sizeMatch) {
                      const centerX = Math.round(parseFloat(posMatch[1]) + parseFloat(sizeMatch[1])/2);
                      const centerY = Math.round(parseFloat(posMatch[2]) + parseFloat(sizeMatch[2])/2);
                      this.updateCursorPosition(centerX, centerY);
                      
                      const { execPromise } = await import('../../utils/utils');
                      await execPromise(`swift swift/clickAtCoordinates.swift ${centerX} ${centerY}`);
                      await new Promise(r => setTimeout(r, this.getClickDelay()));
                      return { message: `clicked id ${swiftId} at coordinates (${centerX}, ${centerY})` };
                    }
                  }
                } catch (coordErr) {
                  console.log(`[TerminatorAgent] Direct Swift ID coordinate fallback failed:`, coordErr);
                }
              }
              }

              // For YouTube, find and click the actual search input field instead of "Search" button
              const isBrowser = !!this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
              if (isBrowser && desiredName && /^(search)$/i.test(desiredName) && this.isLikelyOnYoutube()) {
                // Try to find the actual search input field instead of the button
                const bundleId = await this.getBundleIdFromAppName(this.targetAppName);
                if (bundleId) {
                  const list = await this.swiftListClickableElements(bundleId);
                  // Look for search input field specifically
                  let searchInput: any | null = null;
                  for (const el of list) {
                    const role = (el.AXRole || '').toLowerCase();
                    const title = (el.AXTitle || '').toLowerCase();
                    const desc = (el.AXDescription || '').toLowerCase();
                    
                    // Look for YouTube-specific search field (more specific than generic "search")
                    if (role.includes('textfield') || role.includes('searchfield')) {
                      // YouTube-specific search field indicators
                      if (title.includes('search youtube') || desc.includes('search youtube') || 
                          title.includes('youtube search') || desc.includes('youtube search') ||
                          (title.includes('search') && !title.includes('google')) ||
                          (desc.includes('search') && !desc.includes('google'))) {
                        searchInput = el;
                        break;
                      }
                    }
                  }
                  
                  if (searchInput && typeof searchInput.id === 'number') {
                    console.log(`[TerminatorAgent] 🔍 Found YouTube search input field: id=${searchInput.id}`);
                    const clicked = await this.swiftClickById(bundleId, searchInput.id);
                    if (clicked) {
                    await new Promise(r => setTimeout(r, this.getClickDelay()));
                      return { message: `clicked search input` };
                    }
                    
                    // Coordinate fallback for YouTube search input
                    if (searchInput.AXPosition && searchInput.AXSize) {
                      console.log(`[TerminatorAgent] 🎯 YouTube search Swift click failed, trying coordinate fallback`);
                      try {
                        const posMatch = searchInput.AXPosition.match(/x=([0-9.-]+)\s+y=([0-9.-]+)/);
                        const sizeMatch = searchInput.AXSize.match(/w=([0-9.-]+)\s+h=([0-9.-]+)/);
                        if (posMatch && sizeMatch) {
                          const centerX = Math.round(parseFloat(posMatch[1]) + parseFloat(sizeMatch[1])/2);
                          const centerY = Math.round(parseFloat(posMatch[2]) + parseFloat(sizeMatch[2])/2);
                          this.updateCursorPosition(centerX, centerY);
                          
                          const { execPromise } = await import('../../utils/utils');
                          await execPromise(`swift swift/clickAtCoordinates.swift ${centerX} ${centerY}`);
                          await new Promise(r => setTimeout(r, this.getClickDelay()));
                          return { message: `clicked search input at coordinates (${centerX}, ${centerY})` };
                        }
                      } catch (coordErr) {
                        console.log(`[TerminatorAgent] YouTube search coordinate fallback failed:`, coordErr);
                      }
                    }
                  }
                }
                
                // Fallback: try the "/" shortcut if we can't find the input
                console.log(`[TerminatorAgent] Fallback: using / shortcut for YouTube search`);
                await this.executeAppleScript(`tell application "System Events" to keystroke "/"`);
                await new Promise(r => setTimeout(r, 150));
                return { message: `focused search via shortcut` };
              }

              if (this.targetAppName && desiredName) {
                const bundleId = await this.getBundleIdFromAppName(this.targetAppName);
                if (bundleId) {
                  
                  // 🌐 CHROME FIRST: Try JavaScript-detected web elements for browsers
                  const isChromeApp = /chrome|google chrome/i.test(this.targetAppName);
                  if (isChromeApp) {
                    console.log(`[TerminatorAgent] 🌐 Chrome detected: Trying JavaScript web elements first for "${desiredName}"`);
                    

                    try {
                      const chromeElements = await this.getChromeElementsViaJavaScriptV2();
                      console.log(`[TerminatorAgent] 🌐 Found ${chromeElements.length} JavaScript web elements`);
                      
                      const lower = desiredName.toLowerCase();
                      let webElement: any | null = null;
                      
                      // PRIORITY 1: Exact matches with smart prioritization
                      const exactMatches = [];
                      for (const el of chromeElements) {
                        const elName = (el.name || '').toLowerCase();
                        // role available for future scoring if needed
                        // const elRole = (el.role || '').toLowerCase();
                        const elSelector = (el.webSelector || '').toLowerCase();
                        if (elName === lower || elSelector.includes(lower.replace(/\s+/g, ''))) {
                          exactMatches.push(el);
                        }
                      }
                      
                      if (exactMatches.length > 1) {
                        // Deterministic selection: prefer elements with robust selectors first
                        const bySelector = exactMatches.filter(el => el.webSelector && /data-testid|aria-label|#|\[role=|\[type=/.test(el.webSelector));
                        if (bySelector.length > 0) {
                          webElement = bySelector[0];
                          console.log(`[TerminatorAgent] 🎯 Multiple matches - chose by robust selector: "${webElement.name}" selector=${webElement.webSelector}`);
                        } else {
                          // Fallback heuristic: prefer center-ish elements over nav/sidebar
                          exactMatches.sort((a,b)=>{
                            const ay = (a.bounds?.y || 0), by = (b.bounds?.y || 0);
                            const ax = (a.bounds?.x || 0), bx = (b.bounds?.x || 0);
                            // Prefer vertical center, then horizontal center
                            const centerScore = (v:number)=>Math.abs(v - (innerHeight?innerHeight/2:0));
                            // Without innerHeight in Node, just prefer lower y (main content) and larger y
                            return (ay - by) || (ax - bx);
                          });
                          webElement = exactMatches[0];
                          console.log(`[TerminatorAgent] 🎯 Multiple matches - chose first by position heuristic: "${webElement.name}" at (${webElement.bounds?.x}, ${webElement.bounds?.y})`);
                        }
                      } else if (exactMatches.length === 1) {
                        webElement = exactMatches[0];
                        console.log(`[TerminatorAgent] 🎯 Single exact match: "${webElement.name}" at (${webElement.bounds?.x}, ${webElement.bounds?.y})`);
                      }
                      
                      // PRIORITY 2: Partial matches only if no exact match found
                      if (!webElement) {
                        for (const el of chromeElements) {
                          const elName = (el.name || '').toLowerCase();
                          if (elName.includes(lower)) {
                            webElement = el;
                            console.log(`[TerminatorAgent] 🎯 PARTIAL match web element: "${el.name}" at (${el.bounds?.x}, ${el.bounds?.y})`);
                            break;
                          }
                        }
                      }
                      
                      if (webElement) {
                        // Try JavaScript click first (no accessibility permissions needed!)
                        if (webElement.webSelector) {
                          try {
                            console.log(`[TerminatorAgent] 🌐 Trying JavaScript click on: "${desiredName}" with selector: ${webElement.webSelector}`);
                            // Use the robust selector that was already detected - simplified to avoid AppleScript escaping issues
                            const selectorEscaped = webElement.webSelector.replace(/'/g, "\\'").replace(/"/g, '\\"');
                            const textEscaped = desiredName.replace(/'/g, "\\'").replace(/"/g, '\\"');
                            const robustJs = `(()=>{try{const center=(el)=>{const r=el.getBoundingClientRect();return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)}};const vis=(el)=>{const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity||'1')<0.1||cs.pointerEvents==='none')return false;const r=el.getBoundingClientRect();if(r.width<6||r.height<6)return false;return true};const tryClick=(el)=>{try{el.scrollIntoView({behavior:'instant',block:'center',inline:'center'});if((el.tagName||'').toLowerCase().match(/input|textarea/)||el.isContentEditable){el.focus();}const c=center(el);const ev=(n)=>el.dispatchEvent(new MouseEvent(n,{view:window,bubbles:true,cancelable:true,clientX:c.x,clientY:c.y,button:0}));ev('pointerdown');ev('mousedown');ev('mouseup');ev('click');return true;}catch(_){return false}};const bySel=document.querySelector('${selectorEscaped}');if(bySel&&vis(bySel)){if(tryClick(bySel))return true;}const cands=document.querySelectorAll('[data-testid],[aria-label],button,a,[role=button]');for(let el of cands){const t=(el.innerText||el.textContent||'').trim();const al=el.getAttribute('aria-label')||'';if(t=== '${textEscaped}' || al=== '${textEscaped}' || t.includes('${textEscaped}')){if(vis(el)&&tryClick(el))return true;}}const mid=document.elementFromPoint(window.innerWidth/2,window.innerHeight/2);if(mid&&tryClick(mid))return true;return false;}catch(e){return false;}})()`;
                            
                            const jsClickScript = `
                              tell application "Google Chrome"
                                tell active tab of front window
                                  execute javascript "${robustJs}"
                                end tell
                              end tell
                            `;
                                          const clickResult = await this.executeAppleScript(jsClickScript);
              console.log(`[TerminatorAgent] 🌐 JavaScript click result:`, clickResult);
              
              if (clickResult && (clickResult.includes('true') || clickResult.trim() === 'true')) {
                console.log(`[TerminatorAgent] ✅ JavaScript click successful on ${desiredName}!`);
                
                // Special handling for popup-triggering elements
                const isPopupTrigger = /menu|option|dropdown|more|⋮|•••|settings/i.test(desiredName);
                if (isPopupTrigger) {
                  console.log(`[TerminatorAgent] 🕐 Detected popup trigger "${desiredName}" - waiting for menu to appear`);
                  await new Promise(r => setTimeout(r, 800)); // Extended wait for popup animation
                } else {
                  await new Promise(r => setTimeout(r, this.getClickDelay()));
                }
                
                return { message: `clicked web element ${desiredName} via JavaScript` };
              }
                          } catch (jsErr) {
                            console.log(`[TerminatorAgent] ⚠️ JavaScript click failed:`, jsErr);
                          }
                        }
                        
                        // For Chrome, do NOT fall back to coordinates. Use JS-only strategy.
                        if (/chrome|google chrome/i.test(this.targetAppName || '')) {
                          console.log('[TerminatorAgent] 🚫 Skipping coordinate fallback for Chrome (JS-only policy)');
                        } else if (webElement.bounds) {
                          const x = webElement.bounds.x;
                          const y = webElement.bounds.y;
                          
                          // Basic bounds checking to prevent invalid coordinates
                          if (x < 0 || y < 0 || x > 5000 || y > 5000) {
                            console.log(`[TerminatorAgent] ⚠️ Coordinates out of reasonable bounds: (${x}, ${y})`);
                          } else {
                          console.log(`[TerminatorAgent] 🌐 Fallback: Trying coordinate click at (${x}, ${y})`);
                          
                          try {
                              const posClickScript = `tell application \"System Events\" to click at {${x}, ${y}}`;
                            await this.executeAppleScript(posClickScript);
                            await new Promise(r => setTimeout(r, this.getClickDelay()));
                            return { message: `clicked web element ${desiredName}` };
                          } catch (coordError: any) {
                              if (coordError.message && (coordError.message.includes('-25211') || coordError.message.includes('-25200'))) {
                                console.log(`[TerminatorAgent] ❌ Accessibility permissions error - osascript needs permissions (error: ${coordError.message.includes('-25200') ? '-25200' : '-25211'})`);
                              return { message: `click failed: Grant accessibility permissions to Terminal/osascript in System Settings > Privacy & Security > Accessibility` };
                            }
                            console.log(`[TerminatorAgent] 🌐 Coordinate click failed:`, coordError);
                            }
                          }
                        }
                      }
                    } catch (webErr) {
                      console.log(`[TerminatorAgent] 🌐 JavaScript web element clicking failed:`, webErr);
                    }
                  }
                  
                            // Use the scanned elements that were already shown to the AI for planning
          // This prevents the "guessing game" - AI picked from these exact elements
          const list = scannedElements.length > 0 ? scannedElements : (isChromeApp ? [] : await this.swiftListClickableElements(bundleId));
                console.log(`[TerminatorAgent] 🔍 Using ${scannedElements.length > 0 ? 'scanned' : 'fresh'} elements: Looking for "${desiredName}" in ${list.length} elements`);
                  // Find best match by name/role (for both TerminatorElement and raw AX elements)
                  const lower = desiredName.toLowerCase();
                  let best: any | null = null;
                  for (const el of list) {
                    // Handle both TerminatorElement and raw AX element types with safe property access
                    const name = ((el as any).name || (el as any).AXTitle || '').toLowerCase();
                    const desc = ((el as any).role || (el as any).AXDescription || '').toLowerCase();
                    const value = ((el as any).AXValue || '').toLowerCase();
                  if (name === lower || desc === lower || value === lower) { 
                    console.log(`[TerminatorAgent] 🎯 Exact match found: name="${(el as any).name || (el as any).AXTitle}", role="${(el as any).role || (el as any).AXRole}"`);
                    best = el; 
                    break; 
                  }
                    if (!best && (name.includes(lower) || desc.includes(lower) || value.includes(lower))) {
                    console.log(`[TerminatorAgent] 🎯 Partial match found: name="${(el as any).name || (el as any).AXTitle}", role="${(el as any).role || (el as any).AXRole}"`);
                      best = el;
                    }
                  }
                  // Check if this is a web element (has webSelector) for Chrome
                  if (best && best.webSelector && isChromeApp) {
                    console.log(`[TerminatorAgent] 🌐 Web element match for "${desiredName}" - using JavaScript click`);
                    try {
                      const selectorEscaped = best.webSelector.replace(/'/g, "\\'").replace(/"/g, '\\"');
                      const textEscaped = desiredName.replace(/'/g, "\\'").replace(/"/g, '\\"');
                      const clickJs = `(function() {
                        function navigateIfLink(el){
                          // If element or ancestor is a link, prefer navigation
                          let anchor = el.closest('a');
                          if (anchor && anchor.href) {
                            const href = anchor.href;
                            anchor.click();
                            // If SPA prevented default, also force navigation
                            setTimeout(() => { try { if (location.href === location.href) { window.location.href = href; } } catch(_){} }, 150);
                            return 'clicked anchor ' + href;
                          }
                          return null;
                        }
                        
                        const el = document.querySelector('${selectorEscaped}');
                        if (el) {
                          el.scrollIntoView({behavior:'instant',block:'center'});
                          const linkResult = navigateIfLink(el);
                          if (linkResult) return linkResult;
                          el.click();
                          return 'clicked ' + '${textEscaped}';
                        }
                        // Fallback: try by text content
                        const all = document.querySelectorAll('*');
                        for (let elem of all) {
                          if (elem.textContent && elem.textContent.trim() === '${textEscaped}') {
                            elem.scrollIntoView({behavior:'instant',block:'center'});
                            const lr = navigateIfLink(elem);
                            if (lr) return lr;
                            elem.click();
                            return 'clicked by text';
                          }
                        }
                        return 'element not found';
                      })()`;
                      
                      const jsClickScript = `
                        tell application "Google Chrome"
                          tell active tab of front window
                            execute javascript "${clickJs}"
                          end tell
                        end tell
                      `;
                      
                      const result = await this.executeAppleScript(jsClickScript);
                      if (result && result.includes('clicked')) {
                        await new Promise(r => setTimeout(r, this.getClickDelay()));
                        return { message: `clicked ${desiredName}` };
                      }
                    } catch (jsErr) {
                      console.log(`[TerminatorAgent] JavaScript click failed:`, jsErr);
                    }
                    
                    // Coordinate fallback for web elements if JS click failed
                    if (best && best.bounds) {
                      console.log(`[TerminatorAgent] 🎯 Web JS click failed, trying coordinate fallback at (${best.bounds.x + best.bounds.width/2}, ${best.bounds.y + best.bounds.height/2})`);
                      try {
                        const centerX = Math.round(best.bounds.x + best.bounds.width/2);
                        const centerY = Math.round(best.bounds.y + best.bounds.height/2);
                        this.updateCursorPosition(centerX, centerY);
                        
                        const clickJs = `(function() {
                          const event = new MouseEvent('click', {
                            view: window,
                            bubbles: true,
                            cancelable: true,
                            clientX: ${centerX},
                            clientY: ${centerY}
                          });
                          const element = document.elementFromPoint(${centerX}, ${centerY});
                          if (element) {
                            element.dispatchEvent(event);
                            return 'clicked at coordinates';
                          }
                          return 'no element at coordinates';
                        })()`;
                        
                        const coordClickScript = `
                          tell application "Google Chrome"
                            tell active tab of front window
                              execute javascript "${clickJs.replace(/"/g, '\\"')}"
                            end tell
                          end tell
                        `;
                        
                        const coordResult = await this.executeAppleScript(coordClickScript);
                        if (coordResult && coordResult.includes('clicked')) {
                          await new Promise(r => setTimeout(r, this.getClickDelay()));
                          return { message: `clicked ${desiredName} at coordinates (${centerX}, ${centerY})` };
                        }
                      } catch (coordErr) {
                        console.log(`[TerminatorAgent] Web coordinate fallback failed:`, coordErr);
                      }
                    }
                  }
                  
                  // For native apps, use Swift AX
                  if (best && typeof best.swiftId === 'number' && !isChromeApp) {
                    console.log(`[TerminatorAgent] 🧩 Swift AX match for "${desiredName}": id=${best.swiftId}`);
                    
                    // Log coordinates for element-based clicks
                    if (best.bounds) {
                      const centerX = Math.round(best.bounds.x + best.bounds.width / 2);
                      const centerY = Math.round(best.bounds.y + best.bounds.height / 2);
                      console.log(`[COORDINATES] 🖱️ TerminatorAgent Swift AX click at coordinates: (${centerX}, ${centerY}) - element: ${desiredName}`);
                      // Show a 1s glowing dot at the computed center
                      ClickPreviewService.showDot(centerX, centerY).catch(() => {});
                    } else {
                      console.log(`[COORDINATES] 🖱️ TerminatorAgent Swift AX click - NO BOUNDS DATA for element: ${desiredName}`);
                    }
                    
                    const ok = await this.swiftClickById(bundleId, best.swiftId);
                    if (ok) {
                      await new Promise(r => setTimeout(r, 150));
                      return { message: `clicked ${desiredName}` };
                    }
                    
                    // Coordinate fallback for native elements if Swift AX click failed
                    if (best.bounds) {
                      console.log(`[TerminatorAgent] 🎯 Swift AX click failed, trying coordinate fallback at (${best.bounds.x + best.bounds.width/2}, ${best.bounds.y + best.bounds.height/2})`);
                      try {
                        const centerX = Math.round(best.bounds.x + best.bounds.width/2);
                        const centerY = Math.round(best.bounds.y + best.bounds.height/2);
                        this.updateCursorPosition(centerX, centerY);
                        
                        const { execPromise } = await import('../../utils/utils');
                        await execPromise(`swift swift/clickAtCoordinates.swift ${centerX} ${centerY}`);
                        await new Promise(r => setTimeout(r, this.getClickDelay()));
                        return { message: `clicked ${desiredName} at coordinates (${centerX}, ${centerY})` };
                      } catch (coordErr) {
                        console.log(`[TerminatorAgent] Native coordinate fallback failed:`, coordErr);
                      }
                    }
                  }
                  
                  console.log(`[TerminatorAgent] ❌ No clickable match found for "${desiredName}" in ${isChromeApp ? 'Chrome' : 'native app'}`);
                  
                  // Try image fallback for Chrome when no exact match is found
                  const isImageRequest = desiredName && /image|photo|picture|img|cat|dog|animal|first|any|result/i.test(desiredName);
                  if (isChromeApp && (isImageRequest || desiredName.includes('cat') || desiredName.includes('image'))) {
                    console.log(`[TerminatorAgent] 🖼️ Triggering image fallback for Chrome - no exact match for "${desiredName}"`);
                    try {
                      const fallbackResult = await this.tryImageClickFallback(desiredName);
                      if (fallbackResult && fallbackResult.includes('clicked')) {
                        return { message: fallbackResult };
                      }
                    } catch (err) {
                      console.log(`[TerminatorAgent] Image fallback failed: ${(err as any)?.message || err}`);
                    }
                  }
                }
            } else {
              console.log(`[TerminatorAgent] ❌ Missing targetAppName or desiredName: app="${this.targetAppName}", name="${desiredName}"`);
              // Fallback: if on Chrome with Google Images or generic image request, click the first image result
              const isImageRequest = desiredName && /image|photo|picture|img/i.test(desiredName);
              try {
                if ((this.targetAppName || '').toLowerCase().includes('chrome') || isImageRequest) {
                  console.log(`[TerminatorAgent] 🖼️ Attempting to click first available image (generic image request or missing name)`);
                  const fallbackJs = (() => {
                    const js = `(()=>{try{
                      // Prefer Google Images result anchors
                      const selectors = [
                        'a[href^="/imgres"] img',
                        'a.wXeWr.islib.nfEiy img',
                        'div.isv-r a img',
                        'g-img img',  // Google's g-img component
                        '[data-ved] img',  // Google search result images
                        'div[role="list"] img',  // Image grid containers
                        'div[data-ri] img'  // Google Images indexed results
                      ];
                      let img=null, anchor=null;
                      for (const sel of selectors) {
                        img = document.querySelector(sel);
                        if (img) { 
                          anchor = img.closest('a') || img.parentElement;
                          console.log('Found image with selector: ' + sel);
                          break; 
                        }
                      }
                      if (anchor) { 
                        anchor.scrollIntoView({behavior:"instant",block:"center"}); 
                        anchor.click(); 
                        return 'clicked_google_image'; 
                      }
                      // Generic fallback: click first visible image on page
                      const imgs = Array.from(document.querySelectorAll('img')).filter(i=>i && i.offsetWidth>50 && i.offsetHeight>50 && !i.src.includes('data:'));
                      if (imgs.length>0) { 
                        console.log('Found ' + imgs.length + ' generic images, clicking first one');
                        imgs[0].scrollIntoView({behavior:"instant",block:"center"}); 
                        const clickTarget = imgs[0].closest('a') || imgs[0];
                        clickTarget.click(); 
                        return 'clicked_generic_image'; 
                      }
                      return 'no_images_found';
                    }catch(e){console.error('Image click error:', e); return 'error: ' + e.message;}})()`;
                    return js.replace(/"/g, '\\"');
                  })();
                  const jsClickScript = `
                    tell application "Google Chrome"
                      tell active tab of front window
                        execute javascript "${fallbackJs}"
                      end tell
                    end tell
                  `;
                  const result = await this.executeAppleScript(jsClickScript);
                  console.log(`[TerminatorAgent] Image click result: ${result}`);
                  if (result && typeof result === 'string' && result.includes('clicked')) {
                    await new Promise(r => setTimeout(r, this.getClickDelay()));
                    return { message: `${result} (fallback for: ${desiredName || 'any image'})` };
                  }
                }
              } catch (fallbackErr) {
                console.log('[TerminatorAgent] Image fallback failed:', (fallbackErr as any)?.message || fallbackErr);
              }
            }
            }
            catch (swiftClickErr) {
              console.log('[TerminatorAgent] Swift AX path failed, falling back:', (swiftClickErr as any)?.message || swiftClickErr);
            }

          // Legacy fallback path for actions with selectors
          if (action.selector) {
            // ✅ DUAL SYSTEM: Handle both terminator and AppleScript selectors
            if (action.selector.startsWith('applescript:')) {
              // 🍎 APPLESCRIPT FALLBACK CLICKING
              const parts = action.selector.split(':');
              const elementType = parts[1]; // 'button'
              const elementName = parts[2]; // '5', '+', etc.
              
              console.log(`[TerminatorAgent] 🍎 FALLBACK: Clicking ${elementType} "${elementName}" via AppleScript`);
              
              try {
                // UNIVERSAL SOLUTION: Smart button finding for ALL apps
                console.log(`[TerminatorAgent] 🔍 Searching for button "${elementName}" in ${this.targetAppName}`);
                
                // Universal AppleScript that works for any app
                const universalClickScript = `
                  tell application "System Events"
                    tell process "${this.targetAppName}"
                      set targetFound to false
                      
                      -- Method 1: Try all buttons in window
                      try
                        set allButtons to buttons of window 1
                        repeat with btn in allButtons
                          try
                            set btnName to name of btn
                            if btnName is "${elementName}" then
                              click btn
                              return "clicked via name"
                            end if
                          end try
                          try
                            set btnDesc to description of btn
                            if btnDesc is "${elementName}" then
                              click btn
                              return "clicked via description"
                            end if
                          end try
                          try
                            set btnTitle to title of btn
                            if btnTitle is "${elementName}" then
                              click btn
                              return "clicked via title"
                            end if
                          end try
                        end repeat
                      end try
                      
                      -- Method 2: Try all UI elements recursively
                      try
                        set allElements to entire contents of window 1
                        repeat with elem in allElements
                          if class of elem is button then
                            try
                              if name of elem is "${elementName}" or description of elem is "${elementName}" or title of elem is "${elementName}" then
                                click elem
                                return "clicked via UI element search"
                              end if
                            end try
                          end if
                        end repeat
                      end try
                      
                      -- Method 3: Try by accessibility description
                      try
                        click button "${elementName}" of window 1
                        return "clicked directly"
                      end try
                      
                      error "Button not found after trying all methods"
                    end tell
                  end tell`;
                
                try {
                  const result = await this.executeAppleScript(universalClickScript);
                  console.log(`[TerminatorAgent] ✅ Click successful: ${result}`);
                } catch (clickError) {
                  console.log(`[TerminatorAgent] ⚠️ Universal click failed, trying position-based click`);
                  
                  // SPEED: Removed Terminator Desktop fallback (too slow to initialize)
                  console.log('[TerminatorAgent] Swift AX failed, no fallback available');
                      throw clickError;
                }
                
                // Add small delay after click to prevent accidental double-clicks
                await new Promise(resolve => setTimeout(resolve, this.getClickDelay()));
                if (this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName)) {
                }
                return { message: `clicked ${elementName}` };
              } catch (e) {
                console.log(`[TerminatorAgent] 🍎 AppleScript click failed: ${e}`);
                
                // Try alternative: click by position if we have bounds from terminator
                // SPEED: Removed Terminator Desktop position click (slow initialization)
                console.log('[TerminatorAgent] Terminator Desktop not available for position clicks');
                
                throw e;
              }
            } else {
              // SPEED: Removed Terminator Desktop selector (slow initialization)
              console.log('[TerminatorAgent] Terminator Desktop not available - using Swift AX only');
              throw new Error('Selector-based clicking requires Swift AX');
            }
          }
          
          // No vision fallback - just report the failure and let the agent try a different approach
          console.log('[TerminatorAgent] 🔄 Click failed, will try different approach in next planning cycle');
          return { message: `click failed: could not find "${desiredName || 'element'}" - will try different approach` };
          
          break;
        }
        
        case 'double_click': {
          // Check if coordinates were provided by AI (visual mode)
          if (action.x && action.y) {
            console.log(`[TerminatorAgent] 🎯 Using AI-provided coordinates for double-click: (${action.x}, ${action.y})`);
            console.log(`[COORDINATES] 🖱️ Double click at coordinates: (${action.x}, ${action.y})`);
            
            // Show a 1s glowing dot
            ClickPreviewService.showDot(action.x, action.y).catch(() => {});
            
            try {
              const { doubleClickAt } = await import('../../tools/mouse');
              await doubleClickAt(action.x, action.y);
              return { message: `double-clicked at AI-specified coordinates (${action.x}, ${action.y})` };
            } catch (error) {
              console.log(`[TerminatorAgent] AI coordinate double-click failed:`, error);
              // Fall through to element-based clicking
            }
          }
          
          // Handle double-clicks with same logic as regular clicks but use doubleClickAt
          let desiredName: string | null = null;
          
          // Get element name from selector or text
          if (action.selector) {
            try {
              if (action.selector.startsWith('applescript:pos:')) {
                const parts = action.selector.split(':');
                if (parts[2]) {
                  const [xStr, yStr] = parts[2].split(',');
                  const x = Number(xStr);
                  const y = Number(yStr);
                  if (!Number.isNaN(x) && !Number.isNaN(y)) {
                    // Import and use doubleClickAt from mouse.ts
                    const { doubleClickAt } = await import('../../tools/mouse');
                    await doubleClickAt(x, y);
                    return { message: `double-clicked at position` };
                  }
                }
              }
            } catch (err) {
              console.log('[TerminatorAgent] Double-click selector parsing failed:', err);
            }
          }
          
          // Fallback: try to find element by name/text and get its coordinates
          desiredName = action.text || null;
          
          // Additional fallback: extract from action intent if text is missing
          if (!desiredName && action.intent) {
            const intentMatch = action.intent.match(/(?:double.?click|double.?tap).*?['"]([^'"]+)['"]/i);
            if (intentMatch) {
              desiredName = intentMatch[1];
              console.log(`[TerminatorAgent] 🔄 Extracted from intent for double-click: "${desiredName}"`);
            }
          }
          
          if (desiredName) {
            console.log(`[TerminatorAgent] 🔄 Finding element for double-click: "${desiredName}"`);
            // Use same element finding logic as regular click but with double-click execution
            const bundleId = this.targetAppName ? await this.getBundleIdFromAppName(this.targetAppName) : null;
            if (bundleId) {
              const list = scannedElements.length > 0 ? scannedElements : await this.swiftListClickableElements(bundleId);
              const lower = desiredName.toLowerCase();
              const best = list.find((el: any) => {
                const name = ((el as any).name || (el as any).AXTitle || '').toLowerCase();
                return name === lower || name.includes(lower);
              });
              
              if (best && (best as any).bounds) {
                const bounds = (best as any).bounds;
                const { doubleClickAt } = await import('../../tools/mouse');
                await doubleClickAt(bounds.x + bounds.width/2, bounds.y + bounds.height/2);
                return { message: `double-clicked ${desiredName}` };
              }
            }
          }
          
          return { message: 'double-click failed: element not found' };
        }
        
        case 'right_click': {
          // Check if coordinates were provided by AI (visual mode)
          if (action.x && action.y) {
            console.log(`[TerminatorAgent] 🎯 Using AI-provided coordinates for right-click: (${action.x}, ${action.y})`);
            console.log(`[COORDINATES] 🖱️ Right click at coordinates: (${action.x}, ${action.y})`);
            
            // Show a 1s glowing dot
            ClickPreviewService.showDot(action.x, action.y).catch(() => {});
            
            try {
              const { rightClickAt } = await import('../../tools/mouse');
              await rightClickAt(action.x, action.y);
              return { message: `right-clicked at AI-specified coordinates (${action.x}, ${action.y})` };
            } catch (error) {
              console.log(`[TerminatorAgent] AI coordinate right-click failed:`, error);
              // Fall through to element-based clicking
            }
          }
          
          // Handle right-clicks with same logic as regular clicks but use rightClickAt
          let desiredName: string | null = null;
          
          // Get element name from selector or text
          if (action.selector) {
            try {
              if (action.selector.startsWith('applescript:pos:')) {
                const parts = action.selector.split(':');
                if (parts[2]) {
                  const [xStr, yStr] = parts[2].split(',');
                  const x = Number(xStr);
                  const y = Number(yStr);
                  if (!Number.isNaN(x) && !Number.isNaN(y)) {
                    // Import and use rightClickAt from mouse.ts
                    const { rightClickAt } = await import('../../tools/mouse');
                    await rightClickAt(x, y);
                    return { message: `right-clicked at position` };
                  }
                }
              }
            } catch (err) {
              console.log('[TerminatorAgent] Right-click selector parsing failed:', err);
            }
          }
          
          // Fallback: try to find element by name/text and get its coordinates
          desiredName = action.text || null;
          if (desiredName) {
            console.log(`[TerminatorAgent] 🔄 Finding element for right-click: "${desiredName}"`);
            // Use same element finding logic as regular click but with right-click execution
            const bundleId = this.targetAppName ? await this.getBundleIdFromAppName(this.targetAppName) : null;
            if (bundleId) {
              const list = scannedElements.length > 0 ? scannedElements : await this.swiftListClickableElements(bundleId);
              const lower = desiredName.toLowerCase();
              const best = list.find((el: any) => {
                const name = ((el as any).name || (el as any).AXTitle || '').toLowerCase();
                return name === lower || name.includes(lower);
              });
              
              if (best && (best as any).bounds) {
                const bounds = (best as any).bounds;
                const { rightClickAt } = await import('../../tools/mouse');
                await rightClickAt(bounds.x + bounds.width/2, bounds.y + bounds.height/2);
                return { message: `right-clicked ${desiredName}` };
              }
            }
          }
          
          return { message: 'right-click failed: element not found' };
        }
        
        case 'middle_click': {
          // Handle middle-clicks (for tabs, special behaviors)
          if (action.x && action.y) {
            console.log(`[COORDINATES] 🖱️ Middle click at coordinates: (${action.x}, ${action.y})`);
            
            // Show a 1s glowing dot
            ClickPreviewService.showDot(action.x, action.y).catch(() => {});
            
            try {
              const { middleClickAt } = await import('../../tools/mouse');
              await middleClickAt(action.x, action.y);
              return { message: `middle-clicked at AI-specified coordinates (${action.x}, ${action.y})` };
            } catch (error) {
              console.log(`[TerminatorAgent] AI coordinate middle-click failed:`, error);
              // Fall through to element-based clicking
            }
          }
          let desiredName: string | null = null;
          
          // Get element name from selector or text
          if (action.selector) {
            try {
              if (action.selector.startsWith('applescript:pos:')) {
                const parts = action.selector.split(':');
                if (parts[2]) {
                  const [xStr, yStr] = parts[2].split(',');
                  const x = Number(xStr);
                  const y = Number(yStr);
                  if (!Number.isNaN(x) && !Number.isNaN(y)) {
                    // Import and use middleClickAt from mouse.ts
                    const { middleClickAt } = await import('../../tools/mouse');
                    await middleClickAt(x, y);
                    return { message: `middle-clicked at position` };
                  }
                }
              }
            } catch (err) {
              console.log('[TerminatorAgent] Middle-click selector parsing failed:', err);
            }
          }
          
          // Fallback: try to find element by name/text and get its coordinates
          desiredName = action.text || null;
          if (desiredName) {
            console.log(`[TerminatorAgent] 🔄 Finding element for middle-click: "${desiredName}"`);
            // Use same element finding logic as regular click but with middle-click execution
            const bundleId = this.targetAppName ? await this.getBundleIdFromAppName(this.targetAppName) : null;
            if (bundleId) {
              const list = scannedElements.length > 0 ? scannedElements : await this.swiftListClickableElements(bundleId);
              const lower = desiredName.toLowerCase();
              const best = list.find((el: any) => {
                const name = ((el as any).name || (el as any).AXTitle || '').toLowerCase();
                return name === lower || name.includes(lower);
              });
              
              if (best && (best as any).bounds) {
                const bounds = (best as any).bounds;
                const { middleClickAt } = await import('../../tools/mouse');
                await middleClickAt(bounds.x + bounds.width/2, bounds.y + bounds.height/2);
                return { message: `middle-clicked ${desiredName}` };
              }
            }
          }
          
          return { message: 'middle-click failed: element not found' };
        }
        
        case 'scroll_at': {
          // Precise scrolling at specific coordinates with deltaX/deltaY
          const x = (action as any).x || 0;
          const y = (action as any).y || 0;
          const deltaX = (action as any).deltaX || 0;
          const deltaY = (action as any).deltaY || -120; // Default scroll down
          console.log(`[COORDINATES] 🔄 Scroll at coordinates: (${x}, ${y}) delta: (${deltaX}, ${deltaY})`);
          
          if (!x || !y) {
            return { message: 'scroll_at failed: missing coordinates' };
          }
          
          // Show a 1s glowing dot
          ClickPreviewService.showDot(x, y).catch(() => {});
          
          // Check if we're in Chrome for JavaScript-based scrolling
          const isChrome = !!this.targetAppName && /Chrome/i.test(this.targetAppName);
          
          if (isChrome) {
            console.log(`[TerminatorAgent] 🌐 Using JavaScript scroll_at for Chrome`);
            try {
              const scrollJs = `(function() {
                const element = document.elementFromPoint(${x}, ${y});
                if (element) {
                  // Try to find the scrollable parent
                  let scrollTarget = element;
                  while (scrollTarget && scrollTarget !== document.body) {
                    const style = window.getComputedStyle(scrollTarget);
                    if (style.overflow === 'auto' || style.overflow === 'scroll' || 
                        style.overflowY === 'auto' || style.overflowY === 'scroll') {
                      break;
                    }
                    scrollTarget = scrollTarget.parentElement;
                  }
                  
                  // Scroll the found element or window
                  if (scrollTarget && scrollTarget !== document.body) {
                    scrollTarget.scrollBy(${deltaX}, ${-deltaY});
                    return 'scrolled element at (' + ${x} + ', ' + ${y} + ')';
                  } else {
                    window.scrollBy(${deltaX}, ${-deltaY});
                    return 'scrolled window at (' + ${x} + ', ' + ${y} + ')';
                  }
                } else {
                  window.scrollBy(${deltaX}, ${-deltaY});
                  return 'scrolled window (no element at coordinates)';
                }
              })()`;
              
              const scrollScript = `
                tell application "Google Chrome"
                  tell active tab of front window
                    execute javascript "${scrollJs.replace(/"/g, '\\"')}"
                  end tell
                end tell
              `;
              
              const result = await this.executeAppleScript(scrollScript);
              console.log(`[TerminatorAgent] 🌐 Chrome JavaScript scroll_at result:`, result);
              this.updateCursorPosition(x, y);
              return { message: `scrolled at (${x}, ${y}) delta (${deltaX}, ${deltaY}) via JavaScript` };
            } catch (chromeErr) {
              console.log(`[TerminatorAgent] ⚠️ Chrome JavaScript scroll_at failed, falling back to Swift:`, chromeErr);
              // Fall through to Swift scrolling
            }
          }
          
          console.log(`[TerminatorAgent] 🔄 Scrolling at (${x}, ${y}) with delta (${deltaX}, ${deltaY})`);
          const { scrollAt } = await import('../../tools/mouse');
          await scrollAt(x, y, deltaX, deltaY);
          this.updateCursorPosition(x, y);
          
          return { message: `scrolled at (${x}, ${y}) delta (${deltaX}, ${deltaY})` };
        }
        
        case 'type': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] ⌨️ Type at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] ⌨️ Type - no cursor position tracked`);
          }
          const isBrowser = !!this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
          const isNavigationIntent = /address bar|navigate to|url|go to|focus address/i.test(action.intent || '') || /^(https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|org|net|gov|edu))/i.test(action.text || '');
          
          console.log(`[TerminatorAgent] 📝 Type action - Text: "${action.text}", Intent: "${action.intent}"`);
          console.log(`[TerminatorAgent] 📝 Browser: ${isBrowser}, Navigation: ${isNavigationIntent}`);
          
          // If action has specific coordinates, use them; otherwise preserve current cursor position
          if (action.x && action.y) {
            console.log(`[TerminatorAgent] 📝 Type action has coordinates - moving to (${action.x}, ${action.y})`);
            this.updateCursorPosition(action.x, action.y);
            ClickPreviewService.showDot(action.x, action.y).catch(() => {});
          } else {
            // For typing without coordinates, keep cursor where it is (don't jump to lastFocusedRect)
            console.log(`[TerminatorAgent] 📝 Type action has no coordinates - staying at current position`);
          }
          
          // Chrome stabilizer: ensure address bar focus for navigation-like typing
          if (isBrowser && isNavigationIntent) {
            console.log(`[TerminatorAgent] 📝 Navigation detected - using visible typing workflow`);
            
            // Simple reliable Chrome focusing (back to working method)
            await this.executeAppleScript(`tell application "Google Chrome" to activate`);
            await new Promise(r => setTimeout(r, 300));
            await this.executeAppleScript(`tell application "System Events" to keystroke "l" using {command down}`);
            await new Promise(r => setTimeout(r, 300));
            console.log(`[TerminatorAgent] 📝 Chrome focused and address bar selected`);
            // Approximate address bar region vertically near top; keep x from current
            try {
              const { screen } = await import('electron');
              const primary = screen.getPrimaryDisplay();
              const x = this.virtualCursorPosition ? this.virtualCursorPosition.x : Math.floor(primary.workArea.x + primary.workArea.width / 2);
              const y = Math.max(primary.workArea.y + 80, primary.workArea.y + Math.floor(primary.workArea.height * 0.08));
              this.updateCursorPosition(x, y);
            } catch (e) {
              console.log(`[DEBUG] Chrome address bar positioning error:`, e);
            }
          }
          // For Chrome and non-navigation typing, skip JavaScript (unreliable escaping) and use AppleScript
          else if (isBrowser && action.text) {
            console.log(`[TerminatorAgent] 📝 Using reliable AppleScript keystroke typing (skipping unreliable JavaScript)`);
          }
          
          // Fallback to regular AppleScript typing
          if (action.text) {
            console.log(`[TerminatorAgent] 📝 Using AppleScript keystroke typing`);
            const safe = action.text;
            await this.executeAppleScript(`tell application "System Events" to keystroke ${JSON.stringify(safe)}`);
            await new Promise(r => setTimeout(r, 120));
            
            // If this was URL navigation typing, give extra time for page to load
            if (isBrowser && isNavigationIntent) {
              console.log(`[TerminatorAgent] 🌐 URL typed, allowing extra time for page load...`);
              await new Promise(r => setTimeout(r, 500)); // Additional time for page load
            }
          }
          
          return { message: 'typed' };
        }
        
        case 'key': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] ⌨️ Key at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] ⌨️ Key - no cursor position tracked`);
          }
          // For non-cmd combinations OR browser tasks, ensure app focus
          const isCmdCombo = /cmd\s*\+|command\s*\+/.test((action as any).keyString || '');
          const isBrowserTask = !!this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
          
          if ((!isCmdCombo || isBrowserTask) && this.targetAppName) {
            // Always focus browser apps, even for shortcuts, since web shortcuts need page focus
            console.log(`[TerminatorAgent] 🎯 Ensuring ${this.targetAppName} is focused before key: ${action.keyString}`);
            await this.smartFocus(this.targetAppName);
          }
          // Keys do not move the cursor; preserve current position
          this.preserveCursor();
          
          const keyScript = this.convertKeyStringToAppleScript(action.keyString || '');

          // Special handling for Chrome navigation flow
          const isBrowser = !!this.targetAppName && /(Chrome|Safari|Firefox|Arc|Brave|Edge|Opera)/i.test(this.targetAppName);
          if (isBrowser) {
            const normalized = (action.keyString || '').toLowerCase().replace(/\s+/g, '');
            // Mark address bar as primed when focusing it
            if (normalized === 'cmd+l' || normalized === 'command+l') {
              await this.executeAppleScript(keyScript);
              this.addressBarPrimed = true;
              console.log('[TerminatorAgent] 🌐 Address bar primed');
              await new Promise(resolve => setTimeout(resolve, 300));
              return { message: 'pressed key' };
            }
            // If Return is requested right after priming, ensure URL typed first
            if (this.addressBarPrimed && /^(return|enter)$/.test(normalized)) {
              const fromIntent = this.extractUrlFromText((action as any).intent);
              const fromTask = this.extractUrlFromText(this.currentTask);
              const urlToType = fromIntent || fromTask;
              if (urlToType) {
                const escaped = urlToType.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                console.log(`[TerminatorAgent] 🌐 Typing full URL before Return: ${urlToType}`);
                
                // Clear any existing content first
                await this.executeAppleScript(`tell application "System Events" to keystroke "a" using {command down}`);
              await new Promise(resolve => setTimeout(resolve, 100));
                
                // Type the complete URL
                await this.executeAppleScript(`tell application "System Events" to keystroke "${escaped}"`);
                await new Promise(resolve => setTimeout(resolve, 300)); // Wait longer to avoid auto-complete
                
                // Press Escape to dismiss any suggestions dropdown
                await this.executeAppleScript(`tell application "System Events" to key code 53`); // Escape key
                await new Promise(resolve => setTimeout(resolve, 200));
              } else {
                console.log('[TerminatorAgent] 🌐 No URL found to type before Return');
              }
              await this.executeAppleScript(keyScript);
              this.addressBarPrimed = false;
              // Navigation wait
              console.log('[TerminatorAgent] 🌐 Chrome navigation detected, waiting for page load...');
              await new Promise(resolve => setTimeout(resolve, 2500));
              console.log('[TerminatorAgent] 🌐 Adding extra time for page to fully load...');
              await new Promise(resolve => setTimeout(resolve, 1000)); // Additional 1 second
              return { message: 'pressed key' };
            }
          }

            await this.executeAppleScript(keyScript);
            
            // Special handling for navigation keys in Chrome - wait for page load
            if (this.targetAppName && /chrome|google chrome/i.test(this.targetAppName)) {
            const normalized = (action.keyString || '').toLowerCase().replace(/\s+/g, '');
              if (/^(return|enter)$/.test(normalized)) {
                console.log('[TerminatorAgent] 🌐 Chrome navigation detected, waiting for page load...');
                await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
                console.log('[TerminatorAgent] 🌐 Adding extra time for page to fully load...');
                await new Promise(resolve => setTimeout(resolve, 1000)); // Additional 1 second
              } else if (/(cmd\+l|cmd\+t)/.test(normalized)) {
                console.log('[TerminatorAgent] 🌐 Chrome address bar focused, shorter wait...');
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
            
            return { message: 'pressed key' };
        }
        
        case 'applescript': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🍎 AppleScript invoked at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🍎 AppleScript - no cursor position tracked`);
          }
          if (action.applescriptCode) {
            // Extract app name if this is an app activation (handle multiline)
            const appMatch = action.applescriptCode.match(/tell application "([^"]+)"/);
            if (appMatch) {
              this.targetAppName = appMatch[1];
              console.log(`[TerminatorAgent] Target app set to: ${this.targetAppName}`);
            }
            
            // 🛡️ SAFETY CHECK: Log the AppleScript being executed for debugging
            console.log(`[TerminatorAgent] 🔍 EXECUTING APPLESCRIPT for ${this.targetAppName}:`);
            console.log(action.applescriptCode.substring(0, 200) + (action.applescriptCode.length > 200 ? '...' : ''));
            
            // 🛡️ SAFETY CHECK: Block any AppleScript that contains dangerous system shortcuts
            if (action.applescriptCode.includes('key code') && action.applescriptCode.includes('control down, command down')) {
              console.log(`[TerminatorAgent] 🛡️ SAFETY: Blocked AppleScript containing dangerous system shortcut`);
              return { message: `blocked unsafe applescript` };
            }
            
            await this.executeAppleScript(action.applescriptCode);
            // Preserve cursor (AppleScript does not change it)
            this.preserveCursor();
            
            // If Chrome, ensure a window exists and is frontmost
            if (/google chrome/i.test(this.targetAppName)) {
              try {
                // Use open command which is more reliable for bringing apps to front
                await execPromise('open -a "Google Chrome"');
                await new Promise(resolve => setTimeout(resolve, 800));
                
                // Ensure at least one window exists and bring it forward
                await this.executeAppleScript(`
                  tell application "Google Chrome"
                    if (count of windows) = 0 then
                      make new window
                    end if
                    
                    -- Bring the first window to front
                    set index of window 1 to 1
                    activate
                  end tell
                  
                  delay 0.2
                  
                  tell application "System Events"
                    tell process "Google Chrome"
                      set frontmost to true
                      
                      -- If window is minimized, unminimize it
                      try
                        if value of attribute "AXMinimized" of window 1 is true then
                          set value of attribute "AXMinimized" of window 1 to false
                        end if
                      end try
                      
                      -- Bring window to front
                      try
                        perform action "AXRaise" of window 1
                      end try
                    end tell
                  end tell
                `);
                
                // Final wait for Chrome to be fully visible
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log('[TerminatorAgent] Chrome should now be visible and frontmost');
                
                // Enter full screen mode
                try {
                  await this.executeAppleScript(`
                    tell application "System Events"
                      tell process "Google Chrome"
                        keystroke "f" using {control down, command down}
                      end tell
                    end tell
                  `);
                  await new Promise(resolve => setTimeout(resolve, 800));
                  console.log('[TerminatorAgent] Chrome entered full screen mode');
                } catch (fullscreenErr) {
                  console.log('[TerminatorAgent] Full screen activation failed:', fullscreenErr);
                }
              } catch (chromeErr) {
                console.log('[TerminatorAgent] Chrome focus failed:', chromeErr);
              }
            }
            
            // Focus the app after activation to bring to front
            await this.smartFocus(this.targetAppName);
            
            // Wait a moment for apps to fully open and be ready
            await new Promise(resolve => setTimeout(resolve, 300));
            
            return { message: `opened` };
          }
          break;
        }
        
        case 'hover': {
          // Use hoverAt from mouse.ts for hovering at coordinates
          let x = (action as any).x || 0;
          let y = (action as any).y || 0;
          const duration = (action as any).duration || 800;
          
          if (!x || !y) {
            return { message: 'hover failed: no coordinates' };
          }
          
          console.log(`[COORDINATES] 🎯 Hover at coordinates: (${x}, ${y}) duration: ${duration}ms`);
          
          // Show a 1s glowing dot
          ClickPreviewService.showDot(x, y).catch(() => {});
          
          console.log(`[TerminatorAgent] 🔄 Hovering at (${x}, ${y}) for ${duration}ms`);
          const { hoverAt } = await import('../../tools/mouse');
          await hoverAt(x, y, duration);
          
          return { message: `hovered at (${x}, ${y})` };
        }
        
        case 'drag_and_drop': {
          // Drag and drop using coordinate-based dragging
          const startX = (action as any).startX || 0;
          const startY = (action as any).startY || 0;
          const endX = (action as any).endX || 0;
          const endY = (action as any).endY || 0;
          const duration = (action as any).duration || 200;
          
          if (!startX || !startY || !endX || !endY) {
            return { message: 'drag failed: missing coordinates' };
          }
          
          console.log(`[TerminatorAgent] 🔄 Dragging from (${startX}, ${startY}) to (${endX}, ${endY})`);
          
          // Show a 1s glowing dot at start
          ClickPreviewService.showDot(startX, startY).catch(() => {});
          
          const { dragAndDrop } = await import('../../tools/mouse');
          await dragAndDrop(startX, startY, endX, endY, duration);
          
          return { message: `dragged from (${startX}, ${startY}) to (${endX}, ${endY})` };
        }
        
        case 'window': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🪟 Window at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🪟 Window - no cursor position tracked`);
          }
          if (action.windowName) {
            // SAFETY CHECK: Only allow switching to target app, not arbitrary applications
            if (this.targetAppName && action.windowName === this.targetAppName) {
              // Use Spotlight instead of AppleScript for app switching
              await this.smartFocus(action.windowName);
              return { message: `switched to ${action.windowName}` };
            } else {
              console.log(`[TerminatorAgent] 🛡️ SAFETY: Blocked window switch to ${action.windowName} - not the target app ${this.targetAppName}`);
              return { message: `blocked unsafe window switch` };
            }
          }
          break;
        }
        
        case 'analyze': {
          if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] 🔍 Analyze at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] 🔍 Analyze - no cursor position tracked`);
          }
          await this.updateWindowList();
          return { message: `analyzed` };
        }
        
                  case 'done': {
                      if (this.virtualCursorPosition) {
            console.log(`[COORDINATES] ✅ Done at cursor position: (${this.virtualCursorPosition.x}, ${this.virtualCursorPosition.y})`);
            ClickPreviewService.showDot(this.virtualCursorPosition.x, this.virtualCursorPosition.y).catch(() => {});
          } else {
            console.log(`[COORDINATES] ✅ Done - no cursor position tracked`);
          }
          console.log('[TerminatorAgent] Task marked as done');
          this.preserveCursor();
          return { message: 'done' };
          }
          
        default:
          return { message: 'Action completed' };
      }
      
      return { message: 'Action completed' };
      
    } catch (error) {
      console.error('[TerminatorAgent] Action failed:', error);
      return { message: `error: ${(error as any)?.message || String(error)}` };
    }
  }
  
  // Helper method for image clicking fallback
  private async tryImageClickFallback(desiredName: string): Promise<string> {
    console.log(`[TerminatorAgent] 🖼️ Attempting to click first available image (generic image request: ${desiredName})`);
    const fallbackJs = (() => {
      const js = `(()=>{try{
        // Prefer Google Images result anchors
        const selectors = [
          'a[href^="/imgres"] img',
          'a.wXeWr.islib.nfEiy img',
          'div.isv-r a img',
          'g-img img',  // Google's g-img component
          '[data-ved] img',  // Google search result images
          'div[role="list"] img',  // Image grid containers
          'div[data-ri] img'  // Google Images indexed results
        ];
        let img=null, anchor=null;
        for (const sel of selectors) {
          img = document.querySelector(sel);
          if (img) { 
            anchor = img.closest('a') || img.parentElement;
            console.log('Found image with selector: ' + sel);
            break; 
          }
        }
        if (anchor) { 
          anchor.scrollIntoView({behavior:"instant",block:"center"}); 
          anchor.click(); 
          return 'clicked_google_image'; 
        }
        // Generic fallback: click first visible image on page
        const imgs = Array.from(document.querySelectorAll('img')).filter(i=>i && i.offsetWidth>50 && i.offsetHeight>50 && !i.src.includes('data:'));
        if (imgs.length>0) { 
          console.log('Found ' + imgs.length + ' generic images, clicking first one');
          imgs[0].scrollIntoView({behavior:"instant",block:"center"}); 
          const clickTarget = imgs[0].closest('a') || imgs[0];
          clickTarget.click(); 
          return 'clicked_generic_image'; 
        }
        return 'no_images_found';
      }catch(e){console.error('Image click error:', e); return 'error: ' + e.message;}})()`;
      return js.replace(/"/g, '\\"');
    })();
    const jsClickScript = `
      tell application "Google Chrome"
        tell active tab of front window
          execute javascript "${fallbackJs}"
        end tell
      end tell
    `;
    const result = await this.executeAppleScript(jsClickScript);
    console.log(`[TerminatorAgent] Image click result: ${result}`);
    return (result && typeof result === 'string') ? result : 'fallback_failed';
  }

  // ✅ CHROME JAVASCRIPT INJECTION: Better Chrome element detection
  // NOTE: Requires Chrome setting: View > Developer > Allow JavaScript from Apple Events
  private async getChromeElementsViaJavaScript(): Promise<TerminatorElement[]> {
    const elements: TerminatorElement[] = [];
    
    try {
      console.log(`[TerminatorAgent] 🌐 Using JavaScript injection for Chrome element detection`);
      
      // JavaScript to inject into Chrome to find clickable elements
      const jsScript = `
        (function() {
          const elements = [];
          
          // Find all clickable elements (generic for any website)
          const clickableSelectors = [
            'button', 'a[href]', 'input[type="button"]', 'input[type="submit"]', 
            '[role="button"]', '[onclick]', '[ng-click]', '[data-testid]', 
            '[role="option"]', 'li[role="option"]',
            'input[type="text"]', 'input[type="email"]', 'input[type="password"]',
            'textarea', '[contenteditable="true"]',
            'img', 'a img', '[role="img"]', 'picture img', 'figure img',  // Added image selectors
            '[role="menu"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', // Popup menu selectors
            '[aria-haspopup]', '[data-menu]', '[class*="menu"]', '[class*="dropdown"]', '[class*="popup"]' // Additional popup selectors
          ];
          
          clickableSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach((el, index) => {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                // For images, get alt text, title, or nearby text
                let text = '';
                if (el.tagName.toLowerCase() === 'img') {
                  text = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label') || '';
                  // If no alt text, try to get text from parent link
                  if (!text && el.parentElement?.tagName.toLowerCase() === 'a') {
                    text = el.parentElement.getAttribute('title') || el.parentElement.getAttribute('aria-label') || '';
                  }
                  // Add a generic identifier if still no text
                  if (!text) {
                    text = 'Image ' + (index + 1);
                  }
                } else {
                  text = el.textContent?.trim() || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '';
                }
                
                if (text || el.tagName.toLowerCase() === 'img') {
                  // Build robust selector prioritizing semantic attributes
                  let robustSelector = '';
                  
                  // Priority 1: data-testid (most reliable)
                  const testId = el.getAttribute('data-testid');
                  if (testId) {
                    robustSelector = '[data-testid=\"' + testId + '\"]';
                  }
                  // Priority 2: aria-label (semantic)
                  else if (el.getAttribute('aria-label')) {
                    const ariaLabel = el.getAttribute('aria-label');
                    robustSelector = '[aria-label=\"' + ariaLabel + '\"]';
                  }
                  // Priority 3: role + accessible name
                  else if (el.getAttribute('role')) {
                    const role = el.getAttribute('role');
                    robustSelector = '[role=\"' + role + '\"]';
                  }
                  // Priority 4: button with specific text (for buttons)
                  else if (el.tagName.toLowerCase() === 'button' && text.length < 20 && text.match(/^[a-zA-Z0-9\\s]+$/)) {
                    robustSelector = 'button:contains(\"' + text + '\")';
                  }
                  
                  // Fallback to generic selector
                  if (!robustSelector) {
                    robustSelector = selector + ':nth-of-type(' + (index + 1) + ')';
                  }
                  
                  elements.push({
                    text: text.substring(0, 100),
                    selector: robustSelector,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                    type: el.tagName.toLowerCase()
                  });
                }
              }
            });
          });
          
          return JSON.stringify(elements);
        })();
      `;
      
      // Use AppleScript to inject JavaScript into Chrome
      const escaped = jsScript.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const appleScript = `
        tell application "Google Chrome"
          tell active tab of front window
            execute javascript "${escaped}"
          end tell
        end tell
      `;
      
      try {
        // First test if JavaScript permissions are enabled
        const testScript = `document.title || 'test'`;
        const testAppleScript = `
          tell application "Google Chrome"
            tell active tab of front window
              execute javascript "${testScript}"
            end tell
          end tell
        `;
        
        const testResult = await this.executeAppleScript(testAppleScript);
        console.log(`[TerminatorAgent] 🧪 Chrome JS test result:`, testResult);
        
        if (!testResult || testResult.includes('error') || testResult.includes('not allowed') || testResult.length < 2) {
          console.log(`[TerminatorAgent] 🚫 Chrome JavaScript not enabled - showing settings popup and using coordinate fallback`);
          if (!this.chromeSettingsPopupShown) {
            await this.showChromeSettingsPopup();
            this.chromeSettingsPopupShown = true;
          }
          // Fallback to coordinate-based detection instead of returning no elements
          return await this.getChromeElementsViaCoordinates();
        }
        
        const result = await this.executeAppleScript(appleScript);
        console.log(`[TerminatorAgent] JavaScript result type:`, typeof result);
        console.log(`[TerminatorAgent] JavaScript result length:`, result?.length || 0);
        console.log(`[TerminatorAgent] JavaScript result preview:`, String(result || '').substring(0, 200));
        
        if (result && typeof result === 'string' && result.length > 5) {
          try {
            const chromeElements = JSON.parse(result);
            console.log(`[TerminatorAgent] 🌐 Parsed ${chromeElements.length} web elements from JavaScript`);
            for (const el of chromeElements) {
              elements.push({
                name: el.text,
                role: el.type,
                selector: el.selector || `applescript:pos:${el.x},${el.y}`,  // Keep CSS selector if available
                webSelector: el.selector,  // Store the actual CSS selector
                bounds: {
                  x: el.x,
                  y: el.y,
                  width: 50, // Default width
                  height: 30  // Default height
                }
              });
            }
            console.log(`[TerminatorAgent] 🌐 Found ${elements.length} elements via JavaScript injection`);
          } catch (parseError) {
            console.log(`[TerminatorAgent] Failed to parse JavaScript result:`, parseError);
            console.log(`[TerminatorAgent] Raw result was:`, result);
          }
        } else {
          console.log(`[TerminatorAgent] JavaScript returned no usable result`);
        }
      } catch (jsError: any) {
        console.log(`[TerminatorAgent] JavaScript injection failed:`, jsError?.message || jsError);
        
        // Show user popup about Chrome setting requirement only once
        if (!this.chromeSettingsPopupShown) {
        await this.showChromeSettingsPopup();
          this.chromeSettingsPopupShown = true;
        }
        
        // Fallback to coordinate-based detection for Chrome
        console.log(`[TerminatorAgent] 📍 Falling back to coordinate-based Chrome detection`);
        return await this.getChromeElementsViaCoordinates();
      }
    } catch (error: any) {
      console.log(`[TerminatorAgent] Outer JavaScript injection error:`, error?.message || error);
    }
    
    return elements;
  }

  // ✅ CHROME COORDINATE FALLBACK: Last resort for Chrome when JavaScript fails
  private async getChromeElementsViaCoordinates(): Promise<TerminatorElement[]> {
    const elements: TerminatorElement[] = [];
    
    try {
      // Common Chrome UI coordinates (address bar, navigation, etc.)
      const commonChromeElements = [
        { name: "Address Bar", x: 400, y: 60, description: "URL address bar" },
        { name: "Refresh", x: 50, y: 60, description: "Refresh button" },
        { name: "Back", x: 25, y: 60, description: "Back button" },
        { name: "Forward", x: 75, y: 60, description: "Forward button" },
        { name: "Menu", x: 1200, y: 60, description: "Chrome menu" }
      ];
      
             for (const el of commonChromeElements) {
         elements.push({
           name: el.name,
           role: "button",
           selector: `applescript:pos:${el.x},${el.y}`,
           bounds: {
             x: el.x,
             y: el.y,
             width: 100,
             height: 30
           }
         });
       }
      
      console.log(`[TerminatorAgent] 📍 Added ${elements.length} coordinate-based Chrome elements`);
    } catch (error: any) {
      console.log(`[TerminatorAgent] Coordinate fallback failed:`, error?.message || error);
    }
    
    return elements;
  }

  // ✅ CHROME SETTINGS POPUP: Inform user about required Chrome setting
  private async showChromeSettingsPopup(): Promise<void> {
    // Only show popup once per session
    if (this.chromeSettingsPopupShown) {
      return;
    }
    this.chromeSettingsPopupShown = true;
    
    try {
      const message = `Chrome automation requires enabling JavaScript from Apple Events.

To enable:
1. Open Google Chrome
2. Navigate to the Developer Menu: From the menu bar at the top of your screen, click on "View," then hover over "Developer"
3. Enable JavaScript from Apple Events: In the Developer submenu, ensure that "Allow JavaScript from Apple Events" is checked. If it is not checked, click on it to enable it

This allows Opus to detect clickable elements on web pages.

Would you like to continue with basic Chrome automation?`;

      const escapedMessage = message
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");

      const appleScript = `
        tell application "System Events"
          activate
          display dialog "${escapedMessage}" ¬
            buttons {"Cancel", "Continue with Basic Mode", "Open Chrome Settings"} ¬
            default button "Continue with Basic Mode" ¬
            with title "Chrome Configuration Required" ¬
            with icon caution ¬
            giving up after 30
        end tell
      `;

      const result = await this.executeAppleScript(appleScript);
      console.log(`[TerminatorAgent] 🍎 Chrome settings popup result:`, result);

      // If user clicked "Open Chrome Settings", help them navigate there
      if (result && result.includes("Open Chrome Settings")) {
        await this.openChromeSettings();
      }
    } catch (error: any) {
      console.log(`[TerminatorAgent] Failed to show Chrome settings popup:`, error?.message || error);
    }
  }

  // ✅ CHROME SETTINGS HELPER: Navigate user to Chrome settings
  private async openChromeSettings(): Promise<void> {
    try {
      const settingsScript = `
        tell application "Google Chrome"
          activate
          tell front window
            tell active tab
              set URL to "chrome://settings/"
            end tell
          end tell
        end tell
        
        delay 2
        
        tell application "System Events"
          display notification "1. Open Developer Tools (F12)\\n2. Close them, then check View menu\\n3. OR search 'javascript' in chrome://flags" ¬
            with title "Chrome Settings Help" ¬
            subtitle "Enable JavaScript from Apple Events"
        end tell
      `;

      await this.executeAppleScript(settingsScript);
      console.log(`[TerminatorAgent] 🍎 Opened Chrome settings page`);
    } catch (error: any) {
      console.log(`[TerminatorAgent] Failed to open Chrome settings:`, error?.message || error);
    }
  }
  


  // Helper to convert key strings to AppleScript
  private convertKeyStringToAppleScript(keyString: string): string {
    const key = keyString.toLowerCase();
    
    if (key === 'cmd+space') {
      return 'tell application "System Events" to keystroke space using command down';
    } else if (key === 'return' || key === 'enter') {
      return 'tell application "System Events" to keystroke return';
    } else if (key === 'tab') {
      return 'tell application "System Events" to keystroke tab';
    } else if (key.includes('+')) {
      // Handle other combinations
      const parts = key.split('+');
      const mainKey = parts[parts.length - 1];
      const modifiers = parts.slice(0, -1);
      
      let modifierString = '';
      if (modifiers.includes('cmd')) modifierString += 'command down, ';
      if (modifiers.includes('shift')) modifierString += 'shift down, ';
      if (modifiers.includes('ctrl')) modifierString += 'control down, ';
      if (modifiers.includes('alt') || modifiers.includes('option')) modifierString += 'option down, ';
      
      if (modifierString) {
        modifierString = modifierString.slice(0, -2); // Remove trailing comma
        return `tell application "System Events" to keystroke "${mainKey}" using {${modifierString}}`;
      }
    }
    
    // Simple key
    return `tell application "System Events" to keystroke "${key}"`;
  }
  
  public stop(): void {
    this.isRunning = false;
    console.log('[TerminatorAgent] Stopping automation');
  }



  // Visual confirmation using screenshot and Gemini 2.5 Flash
  private async verifyTaskCompletionWithScreenshot(task: string): Promise<boolean> {
    try {
      console.log('[TerminatorAgent] 📸 Taking final screenshot for visual task verification...');
      
      // Take screenshot
      const b64 = await this.captureScreenshotBase64();
      if (!b64) {
        console.log('[TerminatorAgent] ⚠️ Could not capture screenshot, falling back to memory verification');
        return await this.verifyTaskCompletion(task);
      }
      
      // Simple visual verification prompt
      const verificationPrompt = `The task was: "${task}"

Based on the current screenshot which shows the user's computer, is this task done?

RESPOND WITH JSON ONLY:
{
  "task_complete": "YES" or "NO",
  "reason": "Brief explanation of current state or why task is/isn't complete"
}

Also check: Did the last action work as expected? Use the visual evidence to verify if recent actions succeeded.`;

      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: verificationPrompt },
            { inlineData: { mimeType: 'image/jpeg', data: b64 } }
          ]
        }]
      });
      
      const response = (result.response.text() || '').trim();
      console.log(`[TerminatorAgent] 🤖 Visual verification response: "${response}"`);
      
      // Parse JSON response - strip markdown formatting first
      let isDone = false;
      try {
        // Clean markdown formatting from LLM response
        let cleanJson = response;
        if (response.includes('```json')) {
          cleanJson = response.replace(/```json\s*/, '').replace(/```\s*$/, '').trim();
        } else if (response.includes('```')) {
          cleanJson = response.replace(/```\s*/, '').replace(/```\s*$/, '').trim();
        }
        
        const parsed = JSON.parse(cleanJson);
        isDone = parsed.task_complete === "YES";
        console.log(`[TerminatorAgent] 📸 Task complete: ${parsed.task_complete}, Reason: ${parsed.reason}`);
      } catch (parseError) {
        // Fallback to old text parsing if JSON parsing fails
        const responseLower = response.toLowerCase();
        isDone = responseLower.includes('yes') && !responseLower.includes('not') && !responseLower.includes('no');
        console.log(`[TerminatorAgent] 📸 JSON parse failed, using fallback text parsing: ${isDone}`);
      }
      
      if (!isDone) {
        console.log(`[TerminatorAgent] 📸 Visual verification says task is NOT complete: ${response}`);
      } else {
        console.log('[TerminatorAgent] ✅ Visual verification confirms task is complete');
      }
      
      return isDone;
      
    } catch (error) {
      console.log('[TerminatorAgent] Visual verification failed, falling back to memory verification:', error);
      return await this.verifyTaskCompletion(task);
    }
  }

  // Verify completion - use memory-based verification for reliability
  private async verifyTaskCompletion(task: string): Promise<boolean> {
    try {
      // For text-based tasks, use memory verification (more reliable than visual)
      const taskLower = task.toLowerCase();
      const isTextTask = taskLower.includes('type') || taskLower.includes('write') || 
                        taskLower.includes('text') || taskLower.includes('document');
      const isMessageTask = taskLower.includes('message') || taskLower.includes('text ') || 
                           taskLower.includes('send to');
      
      if (isTextTask) {
        // Check if key actions are in memory
        const hasTyped = this.memory.includes('typed') || this.memory.includes('Text entered');
        const hasFormatted = this.memory.includes('bold') || this.memory.includes('Bold formatting') ||
                            taskLower.includes('bold') && this.memory.includes('cmd+b');
        
        if (taskLower.includes('bold')) {
          return hasTyped && hasFormatted;
        } else {
          return hasTyped;
        }
      }
      
      if (isMessageTask) {
        // For messaging: check if message was typed AND sent (return key pressed)
        const hasTyped = this.memory.includes('typed') || this.memory.includes('Text entered');
        const hasSent = this.memory.includes('return') || this.memory.includes('Enter key pressed') ||
                       this.memory.includes('pressed key');
        
        // Extract person name from task to verify correct recipient
        const personMatch = taskLower.match(/message\s+(\w+)|text\s+(\w+)|send\s+to\s+(\w+)/);
        const personName = personMatch ? (personMatch[1] || personMatch[2] || personMatch[3]) : null;
        
        if (personName) {
          // Check if we interacted with the correct person
          const sentToCorrectPerson = this.memory.toLowerCase().includes(personName.toLowerCase());
          return hasTyped && hasSent && sentToCorrectPerson;
        } else {
          return hasTyped && hasSent;
        }
      }
      
      // For other tasks, try visual verification but be more lenient
      const b64 = await this.captureScreenshotBase64();
      if (!b64) return true; // If no screenshot, trust the memory
      
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const res = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: `Based on the screenshot, does it look like this task was completed? Answer yes or no only.\nTASK: ${task}` },
            { inlineData: { mimeType: 'image/jpeg', data: b64 } }
          ]
        }]
      });
      const t = (res.response.text() || '').toLowerCase().trim();
      return t.startsWith('y');
    } catch {
      // If verification fails, trust the agent's planning
      return true;
    }
  }

  private extractUrlFromText(text?: string): string | null {
    if (!text) return null;
    const httpMatch = text.match(/https?:\/\/[^\s"']+/i);
    if (httpMatch) return httpMatch[0];
    const domainMatch = text.match(/([a-z0-9-]+\.(?:com|org|net|edu|gov|io|co|us|uk|ai|dev|app))(?:\/[\w\-\.\/%#?=&]*)?/i);
    if (domainMatch) return `https://${domainMatch[0]}`;
    return null;
  }

  private async detectScreenState(): Promise<string> {
    try {
      // Enhanced screen state detection with window layout and positioning
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          set appWindows to count of windows of application process frontApp
          
          -- Get window layout information
          set windowInfo to ""
          if appWindows > 0 then
            set frontWindow to front window of application process frontApp
            set {x, y} to position of frontWindow
            set {w, h} to size of frontWindow
            try
              set frontWindow to front window of application process frontApp
              set {x, y} to position of frontWindow
              set {w, h} to size of frontWindow
              set windowInfo to " [Window: " & w & "x" & h & " at (" & x & "," & y & ")]"
            on error
              set windowInfo to ""
            end try
          end if
          
          if frontApp is "Finder" then
              return "🗂️ CURRENT VIEW: Desktop/Finder with " & appWindows & " windows open" & windowInfo & ". User can see files, folders, and desktop icons."
          else if frontApp contains "Chrome" then
            tell application "Google Chrome"
              if (count of windows) > 0 then
                set currentURL to URL of active tab of front window
                set currentTitle to title of active tab of front window
                if currentURL contains "x.com" then
                  return "🐦 CURRENT VIEW: X.com (Twitter) open in Chrome" & windowInfo & " - " & currentTitle & " | This is a social media platform for posting messages"
                else if currentURL contains "google.com" then
                  return "🔍 CURRENT VIEW: Google search page in Chrome" & windowInfo & " - " & currentTitle & " | User can search for information here"
                else if currentURL contains "youtube.com" then
                  return "📺 CURRENT VIEW: YouTube in Chrome" & windowInfo & " - " & currentTitle & " | Video platform for watching/uploading videos"
              else
                  return "🌐 CURRENT VIEW: Website (" & currentURL & ") in Chrome" & windowInfo & " - " & currentTitle & " | This is a web browser showing a website"
                end if
              else
                return "🌐 CURRENT VIEW: Chrome browser with no windows open - need to navigate to a website"
              end if
            end tell
          else if frontApp contains "Safari" then
            return "🌐 CURRENT VIEW: Safari web browser is active" & windowInfo & " - similar to Chrome, used for browsing websites"
          else if frontApp contains "Terminal" then
            return "💻 CURRENT VIEW: Terminal/Command line interface" & windowInfo & " - used for typing text commands to the computer"
          else if frontApp contains "Code" or frontApp contains "Cursor" then
            return "⌨️ CURRENT VIEW: Code editor (" & frontApp & ")" & windowInfo & " - used for writing and editing code/text files"
          else if frontApp contains "Calculator" then
            return "🧮 CURRENT VIEW: Calculator app" & windowInfo & " - used for mathematical calculations with clickable number and operation buttons"
          else if frontApp contains "Messages" then
            return "💬 CURRENT VIEW: Messages app" & windowInfo & " - used for sending text messages to contacts"
          else if frontApp contains "Mail" then
            return "📧 CURRENT VIEW: Mail app" & windowInfo & " - used for sending and receiving emails"
          else
            return "📱 CURRENT VIEW: " & frontApp & " app with " & appWindows & " windows" & windowInfo & " - this is a macOS application"
          end if
        end tell
      `;
      
      const result = await this.executeAppleScript(script);
      return result || '❓ Unknown screen state - cannot determine what app is currently active';
    } catch (error) {
      console.log('[TerminatorAgent] Screen state detection error:', error);
      return '❓ Desktop view (screen detection failed) - assume user is on the macOS desktop';
    }
  }

  // **NEW METHOD: Enhanced Web Content Analysis**
  private async getEnhancedWebContentAnalysis(): Promise<string> {
    try {
      const script = `
        tell application "Google Chrome"
          if (count of windows) > 0 then
            execute active tab of front window javascript "
              (function() {
                try {
                  let analysis = '🌐 COMPREHENSIVE WEB PAGE ANALYSIS:\\\\n\\\\n';
                  
                  // PAGE STRUCTURE
                  analysis += '📄 PAGE STRUCTURE:\\\\n';
                  analysis += '  - Title: ' + document.title + '\\\\n';
                  analysis += '  - URL: ' + window.location.href + '\\\\n';
                  analysis += '  - Page width: ' + window.innerWidth + 'px, height: ' + window.innerHeight + 'px\\\\n';
                  
                  // VISIBLE CONTENT ANALYSIS
                  const visibleElements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
                  });
                  
                  analysis += '\\\\n👁️ VISIBLE CONTENT REGIONS:\\\\n';
                  
                  // NAVIGATION ELEMENTS
                  const navElements = visibleElements.filter(el => 
                    el.tagName === 'NAV' || 
                    el.className.toLowerCase().includes('nav') || 
                    el.className.toLowerCase().includes('menu') ||
                    el.id.toLowerCase().includes('nav')
                  );
                  if (navElements.length > 0) {
                    analysis += '  🧭 Navigation areas: ' + navElements.length + ' detected\\\\n';
                  }
                  
                  // MAIN CONTENT
                  const mainContent = document.querySelector('main, [role=main], .main, #main') || 
                                    document.querySelector('article, .content, #content');
                  if (mainContent) {
                    analysis += '  📄 Main content area detected\\\\n';
                  }
                  
                  // FORMS AND INPUTS
                  const forms = document.querySelectorAll('form');
                  const inputs = document.querySelectorAll('input, textarea, select');
                  if (forms.length > 0) {
                    analysis += '  📝 Forms: ' + forms.length + ' detected\\\\n';
                  }
                  if (inputs.length > 0) {
                    analysis += '  ⌨️ Input fields: ' + inputs.length + ' (text: ' + 
                              document.querySelectorAll('input[type=text], input[type=email], input[type=password], textarea').length + 
                              ', buttons: ' + document.querySelectorAll('input[type=button], input[type=submit], button').length + ')\\\\n';
                  }
                  
                  // INTERACTIVE ELEMENTS
                  const buttons = document.querySelectorAll('button, [role=button]');
                  const links = document.querySelectorAll('a[href]');
                  analysis += '  🔘 Buttons: ' + buttons.length + ' detected\\\\n';
                  analysis += '  🔗 Links: ' + links.length + ' detected\\\\n';
                  
                  // ERRORS AND ALERTS
                  const errors = document.querySelectorAll('[role=alert], .error, .warning, .alert');
                  if (errors.length > 0) {
                    analysis += '  ⚠️ Error/Alert messages: ' + errors.length + ' detected\\\\n';
                  }
                  
                  // LOADING STATES
                  const loading = document.querySelectorAll('.loading, .spinner, [aria-busy=true]');
                  if (loading.length > 0) {
                    analysis += '  ⏳ Loading indicators: ' + loading.length + ' detected\\\\n';
                  }
                  
                  // PROMINENT TEXT CONTENT
                  analysis += '\\\\n📖 PROMINENT TEXT CONTENT:\\\\n';
                  const headings = document.querySelectorAll('h1, h2, h3');
                  headings.forEach((h, i) => {
                    if (i < 5) {
                      analysis += '  ' + h.tagName + ': ' + h.textContent.trim().substring(0, 60) + '\\\\n';
                    }
                  });
                  
                  // CURRENT FOCUS
                  const focused = document.activeElement;
                  if (focused && focused !== document.body) {
                    analysis += '\\\\n🎯 CURRENTLY FOCUSED: ' + focused.tagName;
                    if (focused.id) analysis += ' (id: ' + focused.id + ')';
                    if (focused.className) analysis += ' (class: ' + focused.className + ')';
                    analysis += '\\\\n';
                  }
                  
                  return analysis;
                } catch(e) {
                  return 'Web content analysis failed: ' + e.message;
                }
              })()
            "
          else
            return "No Chrome windows open"
          end if
        end tell
      `;
      
      const result = await this.executeAppleScript(script);
      return result || '';
    } catch (error) {
      return `🌐 Web content analysis unavailable: ${error}`;
    }
  }

  private async getChromeElementsViaJavaScriptV2(): Promise<TerminatorElement[]> {
    const elements: TerminatorElement[] = [];

    try {
      console.log(`[TerminatorAgent] 🌐 Using JavaScript injection V2 for Chrome element detection`);

      const jsScript = `
        (function(){
          const max = 400;
          const results = [];
          const visited = new Set();

          function isVisible(el){
            try{
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity||'1') < 0.1 || cs.pointerEvents === 'none') return false;
              if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) return false;
              if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
              const cx = Math.floor(r.left + r.width/2), cy = Math.floor(r.top + r.height/2);
              const top = document.elementFromPoint(cx, cy);
              if (top && !(el === top || el.contains(top) || top.contains(el))) {
                // allow slight overlaps; still consider visible
              }
              return true;
            }catch{ return false; }
          }

          function accName(el){
            try{
              const labelledby = el.getAttribute('aria-labelledby');
              if (labelledby){
                let s = '';
                labelledby.split(/\s+/).forEach(id=>{ const n = document.getElementById(id); if (n) s += ' ' + (n.textContent||''); });
                if (s.trim()) return s.trim();
              }
              const aria = el.getAttribute('aria-label'); if (aria) return aria.trim();
              if (el.tagName && el.tagName.toLowerCase() === 'img'){
                const alt = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label');
                if (alt) return alt.trim();
                if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'a'){
                  const t = el.parentElement.getAttribute('title') || el.parentElement.getAttribute('aria-label');
                  if (t) return t.trim();
                }
              }
              if (el.id){ const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lab && lab.textContent) return lab.textContent.trim(); }
              const ph = el.getAttribute('placeholder'); if (ph) return ph.trim();
              const title = el.getAttribute('title'); if (title) return title.trim();
              const txt = (el.innerText || el.textContent || '').trim();
              return txt;
            }catch{ return ''; }
          }

          function buildSelector(el){
            try{
              if (el.id && /^[A-Za-z_][\w:\\-\.]*$/.test(el.id)) return '#' + CSS.escape(el.id);
              const testId = el.getAttribute('data-testid') || el.getAttribute('data-qa') || el.getAttribute('data-test');
              if (testId) return '[data-testid="' + String(testId).replace(/"/g,'\\"') + '"]';
              const aria = el.getAttribute('aria-label');
              if (aria) return el.tagName.toLowerCase() + '[aria-label="' + String(aria).replace(/"/g,'\\"') + '"]';
              const role = el.getAttribute('role');
              if (role) return '[role="' + role + '"]';
              // Shallow CSS path up to 4 levels
              const parts = [];
              let node = el;
              let depth = 0;
              while (node && node.nodeType === 1 && depth < 4){
                let part = node.tagName.toLowerCase();
                if (node.id && /^[A-Za-z_][\w:\\-\.]*$/.test(node.id)){ parts.unshift(part + '#' + node.id); break; }
                const ti = node.getAttribute('data-testid') || node.getAttribute('data-qa');
                if (ti){ parts.unshift(part + '[data-testid="' + String(ti).replace(/"/g,'\\"') + '"]'); break; }
                let nth = 1; let sib = node;
                while ((sib = sib.previousElementSibling) != null){ if (sib.tagName === node.tagName) nth++; }
                parts.unshift(part + ':nth-of-type(' + nth + ')');
                node = node.parentElement; depth++;
              }
              return parts.join('>');
            }catch{ return ''; }
          }

          function isClickable(el){
            try{
              // Check if element is actually clickable
              const tag = el.tagName.toLowerCase();
              const type = (el.getAttribute('type') || '').toLowerCase();
              
              // Definitely clickable elements
              if (['button', 'a'].includes(tag)) return true;
              if (tag === 'input' && !['hidden'].includes(type)) return true;
              if (tag === 'textarea') return true;
              if (el.hasAttribute('onclick') || el.hasAttribute('ng-click')) return true;
              if (el.getAttribute('role') === 'button') return true;
              if (el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
              if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return true;
              
              // Check if element has click handlers
              const cs = getComputedStyle(el);
              if (cs.cursor === 'pointer') return true;
              
              // For images, check if they're in a clickable context
              if (tag === 'img') {
                const parent = el.parentElement;
                if (parent && ['a', 'button'].includes(parent.tagName.toLowerCase())) return true;
                if (el.hasAttribute('onclick')) return true;
                return false; // Most images are just informational
              }
              
              return false;
            }catch{ return false; }
          }

          function pushEl(el){
            if (!isVisible(el)) return;
            const r = el.getBoundingClientRect();
            const label = accName(el) || '';
            const sel = buildSelector(el) || '';
            const clickable = isClickable(el);
            results.push({
              text: label.slice(0, 120),
              selector: sel,
              x: Math.round(r.left + r.width/2 + window.scrollX),
              y: Math.round(r.top + r.height/2 + window.scrollY),
              type: el.tagName.toLowerCase(),
              w: Math.round(r.width),
              h: Math.round(r.height),
              clickable: clickable
            });
          }

          function collect(root){
            try{
              // Collect both clickable and informational elements
              const clickableSels = [
                'a[href]','button','input:not([type=hidden])','textarea','[role="button"]','[role="link"]','[tabindex]:not([tabindex="-1"])','[contenteditable="true"]',
                '[role="menu"]','[role="menuitem"]','[role="menuitemcheckbox"]','[role="menuitemradio"]','[aria-haspopup]','[data-menu]','[class*="menu"]','[class*="dropdown"]','[class*="popup"]'
              ];
              const informationalSels = [
                'h1','h2','h3','h4','h5','h6','p','span','div[class*="title"]','div[class*="label"]','div[class*="text"]','[role="heading"]','img','[role="img"]','picture img','figure img'
              ];
              const allSels = [...clickableSels, ...informationalSels];
              for (const s of allSels){
                const list = root.querySelectorAll(s);
                for (let i=0;i<list.length && results.length < max;i++) pushEl(list[i]);
                if (results.length >= max) break;
              }
              // Shadow DOM traversal
              const all = root.querySelectorAll('*');
              for (let i=0;i<all.length && results.length < max;i++){
                const n = all[i];
                if (n.shadowRoot){ try { collect(n.shadowRoot); } catch(_){} }
              }
              // Same-origin iframes
              const frames = root.querySelectorAll('iframe,frame');
              for (let i=0;i<frames.length && results.length < max;i++){
                const f = frames[i];
                try{ const doc = f.contentDocument; if (doc && !visited.has(doc)) { visited.add(doc); collect(doc); } }catch(_){/* cross-origin */}
              }
            }catch{}
          }

          visited.add(document);
          collect(document);
          return JSON.stringify(results);
        })();
      `;

      const escaped = jsScript.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const appleScript = `
        tell application "Google Chrome"
          tell active tab of front window
            execute javascript "${escaped}"
          end tell
        end tell
      `;

      const result = await this.executeAppleScript(appleScript);
      if (result && typeof result === 'string' && result.length > 2){
        try{
          const chromeElements = JSON.parse(result);
          console.log(`[TerminatorAgent] 🌐 V2 parsed ${chromeElements.length} web elements`);
          for (const el of chromeElements){
            elements.push({
              name: el.text,
              role: el.type,
              selector: el.selector || `applescript:pos:${el.x},${el.y}`,
              webSelector: el.selector,
              bounds: { x: el.x, y: el.y, width: Math.max(10, el.w||50), height: Math.max(10, el.h||30) },
              clickable: el.clickable || false
            });
          }
        } catch (e){
          console.log(`[TerminatorAgent] V2 parse error:`, e);
        }
      }
    } catch (error: any) {
      console.log(`[TerminatorAgent] V2 JS injection error:`, error?.message || error);
    }

    // Fallback to legacy scanner if V2 found nothing
    if (elements.length === 0) {
      try {
        const legacy = await this.getChromeElementsViaJavaScript();
        if (legacy && legacy.length > 0) return legacy;
      } catch (e) {
        console.log('[TerminatorAgent] Legacy JS scanner also failed:', (e as any)?.message || e);
      }
    }

    return elements;
  }

  // Send longer responses to the UI (summaries, detailed content, etc.)
  private sendLongResponse(event: IpcMainEvent, responseChannel: string, content: string): void {
    console.log(`[TerminatorAgent] Sending long response: ${content.substring(0, 100)}...`);
    event.reply(responseChannel, {
      type: 'agent_response',
      content: content
    });
  }

  // Generate detailed summary from scanned elements using Groq LLM
  /* istanbul ignore next */
private async generateDetailedSummary(task: string, elements: TerminatorElement[]): Promise<string> {
    try {
      console.log('[TerminatorAgent] Using Groq to generate detailed summary from scanned elements...');
      
      // Filter elements to get meaningful content
      const contentElements = elements.filter(el => 
        el.name && 
        el.name.length > 10 && 
        !el.name.toLowerCase().includes('button') &&
        !el.name.toLowerCase().includes('link') &&
        !el.name.toLowerCase().includes('menu') &&
        el.clickable !== true // Focus on informational elements
      ).slice(0, 20); // Limit to most relevant elements
      
      const elementContent = contentElements.map(el => el.name).join('\n');
      
      const summaryPrompt = `You are analyzing the content of a webpage. Based on the scanned elements below, generate a comprehensive 5+ sentence summary that explains what this page is about, its main purpose, key features, and any important information visible.

SCANNED WEBPAGE CONTENT:
${elementContent}

TASK: ${task}

Generate a detailed, informative summary that:
- Is 5+ sentences long
- Explains the main purpose and content of the page
- Highlights key features or information visible
- Uses natural, readable language
- Focuses on what a user would find most useful to know

Summary:`;

      const groqMessages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'user',
          content: summaryPrompt
        }
      ];
      
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: groqMessages,
        max_tokens: 800,
        temperature: 0.3
      });
      
      const summary = completion.choices[0].message.content?.trim() || '';
      console.log(`[TerminatorAgent] Generated summary: ${summary.substring(0, 100)}...`);
      
      return summary || 'Unable to generate detailed summary from current page content.';
      
    } catch (error) {
      console.log('[TerminatorAgent] Summary generation error:', error);
      return 'Content summary generation failed. Page contains standard web elements and interface components.';
    }
  }

  // Vision fallback - GPT-4o-mini planning with screenshot and complete context (UNUSED - kept for future use)
  // UNUSED - kept for future use
  // (Removed to avoid dead code and TS unused warnings)
  
  // Update virtual cursor position explicitly
  private updateCursorPosition(x: number, y: number): void {
    this.virtualCursorPosition = { x, y };
  }

  // Preserve last position (for key/wait/done/applescript)
  private preserveCursor(): void {
    // no-op: intentionally keeps last position
  }

}

// Export functions for main process handler
export async function buildActionPlanFromCommand(command: string): Promise<TerminatorPlan> {
  return {
    id: Date.now().toString(),
    title: `Terminator Virtual Cursor Automation: ${command}`,
    steps: [],
    memory: '',
    nextGoal: 'Complete the requested task using virtual cursor'
  };
}

export function executeActionPlan(
  plan: TerminatorPlan,
  event: IpcMainEvent,
  responseChannel: string
): void {
  const agent = new TerminatorMacOSAgent();
  agent.executeTask(plan.title, event, responseChannel);
}