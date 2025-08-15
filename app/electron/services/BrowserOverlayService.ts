import { EventEmitter } from "events";

export interface BrowserWindow {
  name: string;
  bundleId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class BrowserOverlayService extends EventEmitter {
  private overlayActive = false;
  private overlayWindow: any = null;
  private monitoringInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    super();
  }

  async startOverlay(): Promise<void> {
    if (this.overlayActive) return;
    
    console.log('[BrowserOverlay] Starting browser overlay...');
    this.overlayActive = true;
    
    // Only start monitoring if we don't have an interval already
    // We'll handle showing/hiding based on browser detection events
    console.log('[BrowserOverlay] Overlay ready - will show when browser is detected');
  }

  async stopOverlay(): Promise<void> {
    if (!this.overlayActive) return;
    
    console.log('[BrowserOverlay] FORCE STOPPING browser overlay...');
    this.overlayActive = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('[BrowserOverlay] Cleared overlay interval');
    }
    
    // Hide overlay and clear all listeners
    await this.hideOverlay();
    this.removeAllListeners();
    console.log('[BrowserOverlay] Overlay stopped and listeners cleared');
  }

  // Emergency stop method
  forceStop() {
    console.log('[BrowserOverlay] EMERGENCY STOP called');
    this.overlayActive = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    // Force close overlay window
    if (this.overlayWindow) {
      try {
        this.overlayWindow.close();
        this.overlayWindow = null;
      } catch (e) {
        console.log('[BrowserOverlay] Error closing overlay window:', e);
      }
    }
    
    this.removeAllListeners();
    console.log('[BrowserOverlay] Emergency stop completed');
  }

  // Public method to show overlay for a specific browser
  async showOverlayForBrowser(browserInfo: any): Promise<void> {
    if (!this.overlayActive) {
      console.log('[BrowserOverlay] Overlay not active, skipping');
      return;
    }
    
    console.log('[BrowserOverlay] Attempting to show overlay for browser:', browserInfo);
    
    try {
      const browserWindow = await this.getBrowserWindowBounds(browserInfo);
      console.log('[BrowserOverlay] Got browser window bounds:', browserWindow);
      
      if (browserWindow) {
        await this.showOverlay(browserWindow);
        console.log('[BrowserOverlay] Overlay should be visible now');
      } else {
        console.log('[BrowserOverlay] No browser window bounds found');
      }
    } catch (error) {
      console.error('[BrowserOverlay] Error showing overlay for browser:', error);
    }
  }

  // Public method to hide overlay
  async hideOverlayForBrowser(): Promise<void> {
    try {
      await this.hideOverlay();
    } catch (error) {
      console.error('[BrowserOverlay] Error hiding overlay:', error);
    }
  }

  private async getBrowserWindowBounds(browserInfo: any): Promise<BrowserWindow | null> {
    try {
      console.log('[BrowserOverlay] Getting window bounds for:', browserInfo.name);
      
      // Use screen size and position Chrome roughly in center
      const { screen } = await import('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      
      // Default Chrome window size/position (rough estimate)
      const chromeWidth = Math.min(1200, screenWidth * 0.8);
      const chromeHeight = Math.min(800, screenHeight * 0.8);
      const chromeX = (screenWidth - chromeWidth) / 2;
      const chromeY = (screenHeight - chromeHeight) / 2;
      
      const result = {
        name: browserInfo.name,
        bundleId: browserInfo.bundleId,
        x: chromeX,
        y: chromeY,
        width: chromeWidth,
        height: chromeHeight
      };
      
      console.log('[BrowserOverlay] Using estimated Chrome bounds:', result);
      return result;
    } catch (error) {
      console.error('[BrowserOverlay] Error getting browser bounds:', error);
      return null;
    }
  }



  private async showOverlay(browserWindow: BrowserWindow): Promise<void> {
    try {
      // Create an overlay window that will show the blue glow
      if (!this.overlayWindow) {
        const { BrowserWindow } = await import('electron');
        
        // Create a transparent overlay window
        this.overlayWindow = new BrowserWindow({
          x: browserWindow.x - 10,
          y: browserWindow.y - 10,
          width: browserWindow.width + 20,
          height: browserWindow.height + 20,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          closable: false,
          focusable: false,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
          }
        });

        // Ensure overlay never intercepts mouse events (pass clicks to windows below)
        try { this.overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch {}

        // Load the overlay content with blue glow CSS
        await this.overlayWindow.loadURL(`data:text/html;charset=utf-8,
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                margin: 0;
                padding: 0;
                background: transparent;
                overflow: hidden;
                width: 100vw;
                height: 100vh;
                pointer-events: none;
              }
              
              .glow-border {
                position: absolute;
                top: 10px;
                left: 10px;
                right: 10px;
                bottom: 10px;
                border: 3px solid #00a6fb;
                border-radius: 8px;
                box-shadow: 
                  0 0 20px #00a6fb,
                  0 0 40px #00a6fb,
                  0 0 60px #00a6fb,
                  inset 0 0 20px rgba(0, 166, 251, 0.1);
                animation: pulse 2s ease-in-out infinite;
                pointer-events: none;
              }
              
              @keyframes pulse {
                0%, 100% {
                  opacity: 0.8;
                  box-shadow: 
                    0 0 20px #00a6fb,
                    0 0 40px #00a6fb,
                    0 0 60px #00a6fb,
                    inset 0 0 20px rgba(0, 166, 251, 0.1);
                }
                50% {
                  opacity: 1;
                  box-shadow: 
                    0 0 30px #00a6fb,
                    0 0 60px #00a6fb,
                    0 0 90px #00a6fb,
                    inset 0 0 30px rgba(0, 166, 251, 0.2);
                }
              }
            </style>
          </head>
          <body>
            <div class="glow-border"></div>
          </body>
          </html>
        `);

        // Make window click-through
        this.overlayWindow.setIgnoreMouseEvents(true);
      }

      // Update overlay position to match browser window
      this.overlayWindow.setBounds({
        x: browserWindow.x - 10,
        y: browserWindow.y - 10,
        width: browserWindow.width + 20,
        height: browserWindow.height + 20
      });

      // Show the overlay
      this.overlayWindow.show();
      console.log('[BrowserOverlay] Overlay window shown at position:', {
        x: browserWindow.x - 10,
        y: browserWindow.y - 10,
        width: browserWindow.width + 20,
        height: browserWindow.height + 20
      });
      
      // Emit event for UI feedback
      this.emit('overlay-active', browserWindow);
      
    } catch (error) {
      console.error('[BrowserOverlay] Error showing overlay:', error);
    }
  }

  private async hideOverlay(): Promise<void> {
    try {
      // Hide the overlay window
      if (this.overlayWindow) {
        this.overlayWindow.hide();
        this.overlayWindow.close();
        this.overlayWindow = null;
      }
      
      // Emit event for UI feedback
      this.emit('overlay-inactive');
    } catch (error) {
      console.error('[BrowserOverlay] Error hiding overlay:', error);
    }
  }

  isActive(): boolean {
    return this.overlayActive;
  }
}

// Singleton instance
export const browserOverlay = new BrowserOverlayService(); 