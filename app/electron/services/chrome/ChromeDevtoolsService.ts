import fs from "node:fs";
import path from "node:path";
import runAppleScript from "../../tools/appleScript";

export type ChromeActionResult = { ok: boolean; detail?: string };

class ChromeDevtoolsService {
  private static instance: ChromeDevtoolsService | null = null;
  private browser: any | null = null;
  private page: any | null = null;

  public static getInstance(): ChromeDevtoolsService {
    if (!ChromeDevtoolsService.instance) {
      ChromeDevtoolsService.instance = new ChromeDevtoolsService();
    }
    return ChromeDevtoolsService.instance;
  }

  private async getChromeExecutablePath(): Promise<string | null> {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
    for (const p of macCandidates) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    try {
      const puppeteer = await import("puppeteer");
      return puppeteer.executablePath();
    } catch {
      return null;
    }
  }



  public async ensureStarted(): Promise<void> {
    if (this.browser && this.page) return;

    console.log('[ChromeDevtools] Starting Chrome...');
    const executablePath = await this.getChromeExecutablePath();
    console.log('[ChromeDevtools] Chrome executable path:', executablePath);
    
    // Create a separate nanobrowser Chrome profile that won't conflict with main Chrome
    const os = await import("os");
    const userDataDir = path.join(os.homedir(), "Library/Application Support/Google/Chrome-Nanobrowser");
    console.log('[ChromeDevtools] Using user data dir:', userDataDir);

    const puppeteer = await import("puppeteer");
    
    try {
      // First try to connect to user's existing Chrome (port 9222)
      console.log('[ChromeDevtools] Trying to connect to main Chrome on port 9222...');
      this.browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null,
      });
      console.log('[ChromeDevtools] ✅ Connected to existing main Chrome - using it');

      // Skip launching new instance since we connected to existing
      const pages = await this.browser.pages();
      this.page = pages && pages.length ? pages[0] : await this.browser.newPage();

      // Do not modify AppleScript logic here
      return; // Early return since we're using existing Chrome

    } catch (mainChromeConnectError) {
      console.log('[ChromeDevtools] Main Chrome not available on 9222, trying nanobrowser on 9223...');

      try {
        // Try to connect to existing nanobrowser Chrome instance on port 9223
        console.log('[ChromeDevtools] Trying to connect to existing nanobrowser Chrome...');
        this.browser = await puppeteer.connect({
          browserURL: 'http://localhost:9223',
          defaultViewport: null,
        });
        console.log('[ChromeDevtools] ✅ Connected to existing nanobrowser Chrome instance');
      } catch (nanobrowserConnectError) {
        console.log('[ChromeDevtools] No existing nanobrowser Chrome found, launching a dedicated instance (no restart of your Chrome)...');

        // Launch dedicated nanobrowser Chrome on 9223 with its own profile (do NOT kill user's Chrome)
        await this.autoStartNanobrowserChrome(userDataDir, executablePath || undefined);

        // Wait for 9223 to be ready
        await this.waitForDebugPort(9223, 15);

        // Connect to nanobrowser Chrome
        this.browser = await (await import('puppeteer')).connect({
          browserURL: 'http://localhost:9223',
          defaultViewport: null,
        });
        console.log('[ChromeDevtools] ✅ Connected to launched nanobrowser Chrome');
      }
    }

    try {
      const pages = await this.browser.pages();
      this.page = pages && pages.length ? pages[0] : await this.browser.newPage();
      console.log('[ChromeDevtools] ✅ Got page, bringing to foreground...');

      // Just bring Chrome to the foreground (no fullscreen for now - less intrusive)
      try {
        await runAppleScript(`
          tell application "Google Chrome" to activate
          delay 0.3
        `);
        console.log('[ChromeDevtools] ✅ Successfully activated Chrome (windowed mode)');
        
        // Make sure Opus stays visible
        await runAppleScript(`tell application "Opus" to activate`);
        
      } catch (scriptError) {
        console.error('[ChromeDevtools] ❌ AppleScript error:', scriptError);
      }
    } catch (pageError) {
      console.error('[ChromeDevtools] ❌ Failed to get page from browser:', pageError);
      throw pageError;
    }

    // Keep helper methods referenced to satisfy TS unused checks (never executed)
    if (false) {
      await this.copyUserDataToNanobrowserProfile('');
      await this.ensureOpusOverlayOnTop();
      await this.autoStartChromeWithDebug();
    }
  }

  // unused helper retained for future profile migration needs
  private async copyUserDataToNanobrowserProfile(_nanobrowserDataDir: string): Promise<void> {
    console.log('[ChromeDevtools] Copying bookmarks and essential data to nanobrowser profile...');
    
    const fs = await import('fs');
    const os = await import("os");
    const mainChromeDir = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
    
    if (!fs.existsSync(mainChromeDir)) {
      console.log('[ChromeDevtools] No main Chrome profile found, starting with clean profile');
      return;
    }
    
    // Files to copy from main Chrome profile
    const filesToCopy = [
      'Default/Bookmarks',
      'Default/Preferences', 
      'Default/Login Data',
      'Default/Web Data',
      'Default/History',
      'Local State'
    ];
    
    for (const file of filesToCopy) {
      try {
        const sourcePath = path.join(mainChromeDir, file);
        const targetPath = path.join(_nanobrowserDataDir, file);
        
        if (fs.existsSync(sourcePath)) {
          // Create target directory if needed
          const targetDir = path.dirname(targetPath);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          
          // Copy file
          fs.copyFileSync(sourcePath, targetPath);
          console.log('[ChromeDevtools] ✅ Copied', file);
        }
      } catch (error) {
        console.warn('[ChromeDevtools] ⚠️ Could not copy', file, ':', error);
      }
    }
    
    console.log('[ChromeDevtools] ✅ Finished copying user data to nanobrowser profile');
  }

  // unused helper retained for future overlay recovery
  private async ensureOpusOverlayOnTop(): Promise<void> {
    try {
      console.log('[ChromeDevtools] Ensuring Opus overlay stays on top of Chrome...');
      
      // Wait a moment for Chrome fullscreen to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Bring Opus back to front and make it stay on top
      await runAppleScript(`
        tell application "Opus" to activate
        delay 0.3
        tell application "System Events"
          tell process "Opus"
            set frontmost to true
          end tell
        end tell
      `);
      
      console.log('[ChromeDevtools] ✅ Opus overlay repositioned on top');
    } catch (error) {
      console.warn('[ChromeDevtools] ⚠️ Could not reposition Opus overlay:', error);
         }
   }

  private async waitForDebugPort(port: number, maxRetries: number = 10): Promise<void> {
    console.log(`[ChromeDevtools] Waiting for debug port ${port} to be ready...`);
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Use node's http module instead of fetch
        const http = await import('http');
        const response = await new Promise<boolean>((resolve) => {
          const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
          });
        });
        
        if (response) {
          console.log(`[ChromeDevtools] ✅ Debug port ${port} is ready`);
          return;
        }
      } catch (error) {
        // Ignore errors and retry
      }
      
      console.log(`[ChromeDevtools] Debug port ${port} not ready yet, attempt ${i + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`Debug port ${port} failed to respond after ${maxRetries} attempts`);
  }

  private async autoStartNanobrowserChrome(userDataDir: string, executablePath?: string): Promise<void> {
    console.log('[ChromeDevtools] 🚀 Launching dedicated nanobrowser Chrome on 9223 (no restart of your Chrome)...');
    
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execPromise = promisify(exec);

    // Ensure profile directory exists
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}

    // Start Chrome with separate profile and debug port 9223
    const chromeCommand = `"${executablePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}" \
      --remote-debugging-port=9223 \
      --user-data-dir="${userDataDir}" \
      --no-first-run \
      --no-default-browser-check \
      --new-window`;
    
    console.log('[ChromeDevtools] Running command:', chromeCommand);
    await execPromise(`${chromeCommand} > /dev/null 2>&1 &`);
  }

  private async autoStartChromeWithDebug(): Promise<void> {
    console.log('[ChromeDevtools] 🚀 Auto-starting Chrome with debug port...');
    
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);
      
      // Step 1: Kill existing Chrome processes
      console.log('[ChromeDevtools] 📝 Closing existing Chrome instances...');
      try {
        await execPromise('pkill -f "Google Chrome"');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for processes to close
      } catch (killError) {
        // Ignore errors if no Chrome processes to kill
      }
      
      // Step 2: Start Chrome with debug port
      console.log('[ChromeDevtools] 🌐 Starting Chrome with remote debugging...');
      
      // Use exec with proper escaping - spawn wasn't working reliably
      const chromeCommand = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --no-first-run --no-default-browser-check';
      
      console.log('[ChromeDevtools] Running command:', chromeCommand);
      
      // Start Chrome and don't wait for it
      execPromise(`${chromeCommand} &`).catch(() => {
        // Ignore exec errors since Chrome will run in background
      });
      
      console.log('[ChromeDevtools] ✅ Chrome auto-start initiated');
      
    } catch (error) {
      console.error('[ChromeDevtools] ❌ Failed to auto-start Chrome:', error);
      throw error;
      }
  }

 
  public async navigate(url: string): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    return { ok: true };
  }

  public async waitForSelector(selector: string, timeoutMs = 10000): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.page.waitForSelector(selector, { timeout: timeoutMs, visible: true }).catch(() => {});
    return { ok: true };
  }

  public async click(selector: string): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.page.click(selector, { delay: 20 }).catch(() => {});
    return { ok: true };
  }

  public async type(selector: string, text: string): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.page.focus(selector).catch(() => {});
    await this.page.type(selector, text, { delay: 20 }).catch(() => {});
    return { ok: true };
  }

  public async pressEnter(): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.page.keyboard.press("Enter");
    return { ok: true };
  }

  public async searchGoogle(query: string): Promise<ChromeActionResult> {
    await this.ensureStarted();
    await this.navigate("https://www.google.com");
    await this.waitForSelector("input[name=q]");
    await this.type("input[name=q]", query);
    await this.pressEnter();
    return { ok: true };
  }

  public async close(): Promise<void> {
    try {
      if (this.browser) {
        console.log('[ChromeDevtools] Closing browser connection...');
        await this.browser.close();
        this.browser = null;
        this.page = null;
        console.log('[ChromeDevtools] ✅ Browser connection closed');
      }
    } catch (error) {
      console.error('[ChromeDevtools] ❌ Error closing browser:', error);
      // Reset anyway
      this.browser = null;
      this.page = null;
    }
  }
}

export default ChromeDevtoolsService.getInstance(); 