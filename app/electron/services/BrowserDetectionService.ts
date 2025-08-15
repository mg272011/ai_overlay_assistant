import { EventEmitter } from 'events';
import { execPromise, logWithElapsed } from '../utils/utils';

export interface BrowserInfo {
  name: string;
  bundleId: string;
  isActive: boolean;
  windowTitle?: string;
}

export class BrowserDetectionService extends EventEmitter {
  private detectionInterval: NodeJS.Timeout | null = null;
  private lastActiveBrowser: string | null = null;
  private isMonitoring: boolean = false;
  private knownBrowsers = [
    { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
    { name: 'Safari', bundleId: 'com.apple.Safari' },
    { name: 'Firefox', bundleId: 'org.mozilla.firefox' },
    { name: 'Arc', bundleId: 'company.thebrowser.Browser' },
    { name: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac.Edge' },
    { name: 'Brave Browser', bundleId: 'com.brave.Browser' },
    { name: 'Opera', bundleId: 'com.operasoftware.Opera' }
  ];

  constructor() {
    super();
    logWithElapsed('BrowserDetection', 'Service initialized');
  }

  async startMonitoring() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    logWithElapsed('BrowserDetection', 'Starting browser monitoring');
    
    // Check for active browsers immediately
    await this.checkActiveBrowsers();
    
    // Check every 2 seconds for browser changes
    this.detectionInterval = setInterval(async () => {
      await this.checkActiveBrowsers();
    }, 5000); // Check every 5 seconds instead of 2 - less annoying
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;
    
    console.log('[BrowserDetection] FORCE STOPPING browser monitoring...');
    this.isMonitoring = false;
    
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
      console.log('[BrowserDetection] Cleared monitoring interval');
    }
    
    // Clear all event listeners to prevent zombie events
    this.removeAllListeners();
    console.log('[BrowserDetection] Removed all listeners');
    
    logWithElapsed('BrowserDetection', 'Stopped browser monitoring');
  }

  // Emergency stop method
  forceStop() {
    console.log('[BrowserDetection] EMERGENCY STOP called');
    this.isMonitoring = false;
    
    if (this.detectionInterval) {
      clearInterval(this.detectionInterval);
      this.detectionInterval = null;
    }
    
    this.removeAllListeners();
    console.log('[BrowserDetection] Emergency stop completed');
  }

  private async checkActiveBrowsers() {
    try {
      // Get the frontmost application
      const { stdout } = await execPromise(`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`);
      const frontmostApp = stdout.trim();
      
      // Check if it's a browser
      const browser = this.knownBrowsers.find(b => b.name === frontmostApp);
      
      if (browser && browser.name !== this.lastActiveBrowser) {
        // New browser detected or browser changed
        this.lastActiveBrowser = browser.name;
        
        // Get the window title
        let windowTitle = '';
        try {
          const titleResult = await execPromise(`osascript -e 'tell application "${browser.name}" to get name of front window'`);
          windowTitle = titleResult.stdout.trim();
        } catch {}
        
        const browserInfo: BrowserInfo = {
          name: browser.name,
          bundleId: browser.bundleId,
          isActive: true,
          windowTitle
        };
        
        this.emit('browser-detected', browserInfo);
        logWithElapsed('BrowserDetection', `Browser detected: ${browser.name} - ${windowTitle}`);
      } else if (!browser && this.lastActiveBrowser) {
        // Browser lost focus
        this.emit('browser-unfocused', this.lastActiveBrowser);
        this.lastActiveBrowser = null;
      }
    } catch (error) {
      // Silent fail - don't spam logs
    }
  }

  async getActiveBrowser(): Promise<BrowserInfo | null> {
    try {
      const { stdout } = await execPromise(`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`);
      const frontmostApp = stdout.trim();
      
      const browser = this.knownBrowsers.find(b => b.name === frontmostApp);
      if (!browser) return null;
      
      let windowTitle = '';
      try {
        const titleResult = await execPromise(`osascript -e 'tell application "${browser.name}" to get name of front window'`);
        windowTitle = titleResult.stdout.trim();
      } catch {}
      
      return {
        name: browser.name,
        bundleId: browser.bundleId,
        isActive: true,
        windowTitle
      };
    } catch {
      return null;
    }
  }

  async getCurrentURL(browserName: string): Promise<string | null> {
    try {
      let script = '';
      
      switch (browserName) {
        case 'Google Chrome':
        case 'Brave Browser':
        case 'Microsoft Edge':
          script = `tell application "${browserName}" to get URL of active tab of front window`;
          break;
        case 'Safari':
          script = `tell application "Safari" to get URL of front document`;
          break;
        case 'Firefox':
          // Firefox doesn't support AppleScript URL access directly
          return null;
        default:
          return null;
      }
      
      if (script) {
        const { stdout } = await execPromise(`osascript -e '${script}'`);
        return stdout.trim();
      }
    } catch (error) {
      logWithElapsed('BrowserDetection', `Failed to get URL: ${error}`);
    }
    return null;
  }

  async executeInBrowser(browserName: string, action: string): Promise<boolean> {
    try {
      // Simple browser automation commands
      switch (action) {
        case 'new-tab':
          await execPromise(`osascript -e 'tell application "${browserName}" to make new tab at end of tabs of front window'`);
          break;
        case 'refresh':
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "r" using command down'`);
          break;
        case 'back':
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "[" using command down'`);
          break;
        case 'forward':
          await execPromise(`osascript -e 'tell application "System Events" to keystroke "]" using command down'`);
          break;
        default:
          return false;
      }
      return true;
    } catch (error) {
      logWithElapsed('BrowserDetection', `Failed to execute browser action: ${error}`);
      return false;
    }
  }
}

// Export singleton instance
export const browserDetection = new BrowserDetectionService(); 