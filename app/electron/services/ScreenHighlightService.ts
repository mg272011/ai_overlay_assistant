import { BrowserWindow, screen } from "electron";
// Removed unused imports: dialog, app, fs, path, execPromise

export class ScreenHighlightService {
  private highlightWindow: BrowserWindow | null = null;
  // private mainWindow: BrowserWindow | null = null; // Unused

  constructor(_mainWindow: BrowserWindow) {
    // this.mainWindow = mainWindow; // Unused
  }

  async startScreenHighlight(): Promise<void> {
    try {
      console.log('[ScreenHighlight] Starting simple screen selection');
      
      // Clean up any existing overlay window first
      this.cleanup();
      
      // Create simple transparent overlay for selection - no screenshots needed!
      await this.createSimpleSelectionOverlay();
      
    } catch (error) {
      console.error('[ScreenHighlight] Error starting highlight mode:', error);
      throw error;
    }
  }



  private async createSimpleSelectionOverlay(): Promise<void> {
    // Aggressive cleanup before creating new window
    if (this.highlightWindow && !this.highlightWindow.isDestroyed()) {
      console.log('[ScreenHighlight] Closing existing highlight window');
      this.highlightWindow.close();
      this.highlightWindow = null;
    }
    
    // Also close any orphaned windows that might match our pattern
    const allWindows = BrowserWindow.getAllWindows();
    allWindows.forEach(window => {
      if (window.getTitle() === 'Screen Highlight' && !window.isDestroyed()) {
        console.log('[ScreenHighlight] Closing orphaned highlight window');
        window.close();
      }
    });
    
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height, x, y } = primaryDisplay.bounds;
    
    console.log('[ScreenHighlight] Creating simple selection overlay:', { width, height, x, y });
    
    // Create transparent overlay window
    this.highlightWindow = new BrowserWindow({
      width,
      height,
      x,
      y,
      title: 'Screen Highlight', // Add title for identification
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: true, // Allow focus so it can receive keyboard events
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    // Make window interactive so it can receive mouse events for selection
    this.highlightWindow.setIgnoreMouseEvents(false);
    try { (this.highlightWindow as any).setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    try { this.highlightWindow.setAlwaysOnTop(true, 'screen-saver' as any); } catch {}
    try { this.highlightWindow.setFullScreenable(false); } catch {}
    try { this.highlightWindow.focus(); } catch {}

    // Create simple selection HTML
    const selectionHTML = this.createSimpleSelectionHTML();
    
    // Load the overlay content
    await this.highlightWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(selectionHTML)}`);
    
    // Set up event handlers
    this.highlightWindow.on('closed', () => {
      this.highlightWindow = null;
    });

    console.log('[ScreenHighlight] Simple selection overlay ready');
  }

  private createSimpleSelectionHTML(): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          width: 100vw;
          height: 100vh;
          cursor: crosshair;
          user-select: none;
          overflow: hidden;
          background: transparent; /* Fully transparent - no blocking */
          pointer-events: auto; /* Allow mouse events for selection */
        }
        
        /* Enable mouse events only for interactive elements */
        .interactive {
          pointer-events: auto;
        }
        
        #selection {
          position: fixed;
          border: 3px solid #007AFF;
          background: rgba(0, 122, 255, 0.15);
          display: none;
          pointer-events: none;
          z-index: 20;
        }
        
        #ui-container {
          position: fixed;
          top: 50px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 16px;
          z-index: 1000;
          pointer-events: auto;
        }
        
        #instructions {
          background: rgba(0, 0, 0, 0.3);
          backdrop-filter: blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg);
          border: 0.5px solid rgba(255, 255, 255, 0.3);
          color: white;
          padding: 8px 16px;
          border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 14px;
          font-weight: 500;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
          pointer-events: auto; /* Make instructions clickable */
          white-space: nowrap;
        }
        
        #controls {
          display: flex;
          flex-direction: row;
          gap: 8px;
          pointer-events: auto; /* Make controls clickable */
        }
        
        .control-btn {
          background: rgba(0, 0, 0, 0.3);
          backdrop-filter: blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg);
          border: 0.5px solid rgba(255, 255, 255, 0.3);
          color: white;
          padding: 10px 16px;
          border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          min-width: 100px;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
        }
        
        .control-btn:hover {
          background: rgba(0, 0, 0, 0.5);
          transform: translateY(-1px);
        }
        
        .control-btn.primary {
          background: rgba(0, 122, 255, 0.4);
          backdrop-filter: blur(20px) saturate(180%) contrast(120%) brightness(110%) hue-rotate(5deg);
          border: 0.5px solid rgba(0, 122, 255, 0.5);
        }
        
        .control-btn.primary:hover {
          background: rgba(0, 86, 204, 0.6);
        }
      </style>
    </head>
    <body>
      <div id="selection"></div>
      <div id="ui-container">
        <div id="instructions">Drag to select area • ESC to cancel</div>
        <div id="controls">
          <button id="captureBtn" class="control-btn primary" style="display: none;">Capture</button>
          <button id="cancelBtn" class="control-btn">Cancel</button>
        </div>
      </div>
      
 
       
 
 
       <script>
         const { ipcRenderer } = require('electron');
         
         let isSelecting = false;
         let startX, startY, endX, endY;
         const selection = document.getElementById('selection');
         const captureBtn = document.getElementById('captureBtn');
         const instructions = document.getElementById('instructions');
         const cancelBtn = document.getElementById('cancelBtn');

         // Wire buttons
         if (captureBtn) captureBtn.addEventListener('click', () => captureSelection());
         if (cancelBtn) cancelBtn.addEventListener('click', () => cancelHighlight());
         
         // Start selection
         document.addEventListener('mousedown', (e) => {
           // Don't start selection if clicking on control buttons
           if (e.target.closest('#controls')) return;
           
           console.log('[Selection] Mouse down at:', e.clientX, e.clientY);
           isSelecting = true;
           startX = e.clientX;
           startY = e.clientY;
           selection.style.left = startX + 'px';
           selection.style.top = startY + 'px';
           selection.style.width = '0px';
           selection.style.height = '0px';
           selection.style.display = 'block';
           instructions.textContent = 'Drag to select area...';
           captureBtn.style.display = 'none'; // Hide capture button when starting new selection
         });
        
        // Update selection
        document.addEventListener('mousemove', (e) => {
          if (!isSelecting) return;
          
          endX = e.clientX;
          endY = e.clientY;
          
          const left = Math.min(startX, endX);
          const top = Math.min(startY, endY);
          const width = Math.abs(endX - startX);
          const height = Math.abs(endY - startY);
          
          selection.style.left = left + 'px';
          selection.style.top = top + 'px';
          selection.style.width = width + 'px';
          selection.style.height = height + 'px';
          
          // Show real-time size feedback
          if (width > 10 && height > 10) {
            instructions.textContent = \`Size: \${width}x\${height}px - Keep dragging...\`;
          }
        });
        
        // Finish selection
        document.addEventListener('mouseup', (e) => {
          if (!isSelecting) return;
          
          isSelecting = false;
          endX = e.clientX;
          endY = e.clientY;
          
          const width = Math.abs(endX - startX);
          const height = Math.abs(endY - startY);
          
          console.log('[Selection] Completed:', { 
            width, height, 
            startX, startY, 
            endX, endY,
            validSize: width >= 30 && height >= 30
          });
          
          if (width >= 30 && height >= 30) {
            captureBtn.style.display = 'block';
            instructions.textContent = \`Perfect! \${width}x\${height}px - Click Capture\`;
          } else if (width < 10 && height < 10) {
            // Small click - just reset
            selection.style.display = 'none';
            instructions.textContent = 'Drag to select area • ESC to cancel';
          } else {
            instructions.textContent = \`Too small: \${width}x\${height}px (need 30x30 minimum)\`;
            selection.style.display = 'none';
            setTimeout(() => {
              instructions.textContent = 'Drag to select area • ESC to cancel';
            }, 2000);
          }
        });
        
        // ESC key handler
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            console.log('[Selection] ESC pressed, canceling');
            cancelHighlight();
          }
        });
        
        function cancelHighlight() {
          // Send cancel event to main window
          ipcRenderer.send('screen-highlight-cancelled');
          window.close();
        }
        
        async function captureSelection() {
          if (startX !== undefined && startY !== undefined && endX !== undefined && endY !== undefined) {
            const left = Math.min(startX, endX);
            const top = Math.min(startY, endY);
            const width = Math.abs(endX - startX);
            const height = Math.abs(endY - startY);
            
            console.log('[Selection] Capturing area:', { left, top, width, height });
            
            // Hide the selection box and UI elements before capture
            selection.style.display = 'none';
            document.getElementById('instructions').style.display = 'none';
            document.getElementById('controls').style.display = 'none';
            
            // Wait a moment for UI to hide, then capture
            setTimeout(() => {
              // Take screenshot of just the selected area
              ipcRenderer.send('capture-screen-area-for-prompt', {
                x: left,
                y: top,
                width: width,
                height: height
              });
              
              // Close after capture
              setTimeout(() => {
                window.close();
              }, 200);
            }, 100);
          }
        }
        
        console.log('[Selection] Simple selection overlay loaded');
      </script>
    </body>
    </html>
    `;
  }



  cleanup(): void {
    console.log('[ScreenHighlight] Starting cleanup...');
    
    // Close our tracked window
    if (this.highlightWindow && !this.highlightWindow.isDestroyed()) {
      console.log('[ScreenHighlight] Closing tracked highlight window');
      this.highlightWindow.close();
    }
    this.highlightWindow = null;
    
    // Also force close any orphaned highlight windows
    const allWindows = BrowserWindow.getAllWindows();
    let closedCount = 0;
    allWindows.forEach(window => {
      if (!window.isDestroyed() && window.getTitle() === 'Screen Highlight') {
        console.log('[ScreenHighlight] Force closing orphaned highlight window');
        window.close();
        closedCount++;
      }
    });
    
    console.log('[ScreenHighlight] Cleanup complete. Closed', closedCount, 'orphaned windows');
  }
}

let screenHighlightService: ScreenHighlightService | null = null;

export function initScreenHighlightService(mainWindow: BrowserWindow): void {
  // Clean up existing service if it exists
  if (screenHighlightService) {
    screenHighlightService.cleanup();
  }
  // Create new service instance
  screenHighlightService = new ScreenHighlightService(mainWindow);
}

export function getScreenHighlightService(): ScreenHighlightService | null {
  return screenHighlightService;
} 