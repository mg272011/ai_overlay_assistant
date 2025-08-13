// @ts-ignore
import { BrowserWindow, screen, ipcMain, app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execPromise = promisify(exec);

export interface CursorPosition {
  x: number;
  y: number;
  isDragging?: boolean;
}

export class VirtualCursorWindow {
  private window: InstanceType<typeof BrowserWindow> | null = null;
  private isVisible: boolean = false;
  private currentPosition: CursorPosition = { x: 0, y: 0 };
  private isDragging: boolean = false;

  constructor() {
    this.setupIpcHandlers();
  }

  private setupIpcHandlers() {
    // Handle cursor movement from the agent
    ipcMain.on("virtual-cursor-move", (_, position: CursorPosition) => {
      this.moveCursor(position);
    });

    // Handle cursor click from the agent
    ipcMain.on("virtual-cursor-click", (_, position: CursorPosition) => {
      this.performClick(position);
    });

    // Handle drag operations
    ipcMain.on("virtual-cursor-drag-start", (_, position: CursorPosition) => {
      this.startDrag(position);
    });

    ipcMain.on("virtual-cursor-drag-move", (_, position: CursorPosition) => {
      this.continueDrag(position);
    });

    ipcMain.on("virtual-cursor-drag-end", (_, position: CursorPosition) => {
      this.endDrag(position);
    });

    // Handle scroll operations
    ipcMain.on("virtual-cursor-scroll", (_, delta: { x: number; y: number }) => {
      this.performScroll(delta);
    });
  }

  async create(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      console.log('[VirtualCursorWindow] Window already exists, skipping creation');
      return;
    }

    const display = screen.getPrimaryDisplay();
    const { width, height } = display.bounds;
    
    console.log(`[VirtualCursorWindow] Creating cursor window with size: ${width}x${height}`);

    this.window = new BrowserWindow({
      width,
      height,
      x: 0,
      y: 0,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "dist-electron", "preload.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Make window click-through
    this.window.setIgnoreMouseEvents(true);
    this.window.setVisibleOnAllWorkspaces(true);
    // Use screen-saver level to stay above system overlays like Spotlight
    this.window.setAlwaysOnTop(true, 'screen-saver');

    // Load the cursor HTML
    const htmlPath = path.join(app.getAppPath(), "virtual-cursor.html");
    console.log(`[VirtualCursorWindow] Loading HTML from: ${htmlPath}`);
    
    try {
      await this.window.loadFile(htmlPath);
      console.log('[VirtualCursorWindow] HTML loaded successfully');
    } catch (error) {
      console.error('[VirtualCursorWindow] Failed to load HTML:', error);
    }

    this.window.on("closed", () => {
      console.log('[VirtualCursorWindow] Window closed');
      this.window = null;
      this.isVisible = false;
    });
    
    // Initially hide the window until we need it
    this.window.hide();
    this.isVisible = false;
  }

  async show(): Promise<void> {
    try {
      if (!this.window) {
        await this.create();
      }
      this.window?.show();
      this.window?.setAlwaysOnTop(true, 'screen-saver');
      this.window?.setVisibleOnAllWorkspaces(true);
      // Ensure mouse events are always ignored to prevent blocking main app
      this.window?.setIgnoreMouseEvents(true);
      this.isVisible = true;
      console.log('[VirtualCursorWindow] Cursor window shown and set to always on top (click-through enabled)');
    } catch (error) {
      console.error('[VirtualCursorWindow] Error showing cursor window:', error);
    }
  }

  bringToFront(): void {
    if (this.window) {
      this.window.setAlwaysOnTop(true, 'screen-saver');
      this.window.focus();
      this.window.show();
      console.log('[VirtualCursorWindow] Cursor brought to front above all windows');
    }
  }

  hide(): void {
    try {
      this.window?.hide();
      this.isVisible = false;
      console.log('[VirtualCursorWindow] Cursor window hidden');
    } catch (error) {
      console.error('[VirtualCursorWindow] Error hiding cursor window:', error);
    }
  }

  async moveCursor(position: CursorPosition): Promise<void> {
    if (!this.window) {
      console.log('[VirtualCursorWindow] No window, creating one');
      await this.create();
    }
    
    if (!this.isVisible) {
      console.log('[VirtualCursorWindow] Window not visible, showing it');
      await this.show();
    }
    
    // Always ensure cursor stays on top when moving (especially during Spotlight)
    this.window?.setAlwaysOnTop(true, 'screen-saver');
    this.window?.focus();
    
    console.log(`[VirtualCursorWindow] Moving cursor to (${position.x}, ${position.y})`);
    
    // Start smooth movement to the target position and wait for it
    await this.smoothMoveTo(position);
  }
  
  private async smoothMoveTo(targetPosition: CursorPosition): Promise<void> {
    if (!this.window) return;
    
    console.log(`[VirtualCursorWindow] Starting smooth move from (${this.currentPosition.x}, ${this.currentPosition.y}) to (${targetPosition.x}, ${targetPosition.y})`);
    
    const startX = this.currentPosition.x;
    const startY = this.currentPosition.y;
    const targetX = targetPosition.x;
    const targetY = targetPosition.y;
    
    // Calculate distance and duration
    const distance = Math.sqrt(
      Math.pow(targetX - startX, 2) + Math.pow(targetY - startY, 2)
    );
    
    // Duration based on distance (min 200ms, max 1000ms)
    const duration = Math.min(1000, Math.max(200, distance * 1.5));
    const steps = Math.max(Math.floor(duration / 16), 10); // ~60fps
    
    console.log(`[VirtualCursorWindow] Animation: distance=${distance}, duration=${duration}, steps=${steps}`);
    
    try {
      // Animate the visual cursor only - don't move the real mouse
      for (let i = 0; i <= steps; i++) {
        if (!this.window || this.window.isDestroyed()) {
          console.log('[VirtualCursorWindow] Window destroyed during animation, stopping');
          return;
        }
        
        const progress = i / steps;
        // Use easing function for natural movement
        const easedProgress = this.easeInOutCubic(progress);
        
        const currentX = startX + (targetX - startX) * easedProgress;
        const currentY = startY + (targetY - startY) * easedProgress;
        
        this.currentPosition = {
          x: Math.round(currentX),
          y: Math.round(currentY),
          isDragging: targetPosition.isDragging
        };
        
        // Update visual position
        if (this.window && !this.window.isDestroyed()) {
          this.window.webContents.send("update-cursor-position", this.currentPosition);
        }
        
        // Wait for next frame
        if (i < steps) {
          await new Promise(resolve => setTimeout(resolve, 16));
        }
      }
      
      // Ensure we end at exact target position
      this.currentPosition = targetPosition;
      console.log(`[VirtualCursorWindow] Final position: (${this.currentPosition.x}, ${this.currentPosition.y})`);
      
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("update-cursor-position", this.currentPosition);
        
        // Ensure cursor stays on top
        this.window.setAlwaysOnTop(true, 'screen-saver');
        this.window.focus();
      }
    } catch (error) {
      console.error('[VirtualCursorWindow] Error in smoothMoveTo animation:', error);
      
      // Fallback to instant positioning
      this.currentPosition = targetPosition;
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("update-cursor-position", this.currentPosition);
      }
    }
  }
  
  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  async performClick(position: CursorPosition): Promise<void> {
    if (!this.window) return;

    console.log(`[VirtualCursorWindow] performClick called at (${position.x}, ${position.y}) - VISUAL ONLY`);
    
    // Ensure cursor is visible above everything (especially Spotlight)
    this.bringToFront();

    // Show click animation (visual only)
    this.window.webContents.send("show-click-animation", position);

    // DO NOT perform actual click - the virtual cursor is only for visual feedback
    // The actual clicking is handled by the AgentVisionService using Swift tools
    console.log(`[VirtualCursorWindow] Visual click animation shown, no actual click performed`);
  }

  // Visual click animation only (no actual clicking)
  async showClickAnimation(position: CursorPosition): Promise<void> {
    if (!this.window) return;
    this.window.webContents.send("show-click-animation", position);
  }

  private async performClickWithSwift(position: CursorPosition): Promise<void> {
    try {
      console.log(`[VirtualCursorWindow] Performing Swift click at (${position.x}, ${position.y})`);
      
      // Use the dedicated Swift script for clicking
      const swiftScriptPath = path.join(app.getAppPath(), "swift", "clickAtCoordinates.swift");
      
      console.log(`[VirtualCursorWindow] Using Swift script: ${swiftScriptPath}`);
      
      // Execute the Swift script with coordinates as arguments
      const { stdout, stderr } = await execPromise(`swift ${swiftScriptPath} ${position.x} ${position.y}`);
      
      if (stdout) {
        console.log(`[VirtualCursorWindow] Swift output:`, stdout.trim());
      }
      if (stderr) {
        console.error(`[VirtualCursorWindow] Swift stderr:`, stderr.trim());
      }
      
      console.log(`[VirtualCursorWindow] Click execution completed`);
    } catch (error) {
      console.error("[VirtualCursorWindow] Error performing Swift click:", error);
      
      // Try using cliclick as fallback (if installed)
      try {
        console.log(`[VirtualCursorWindow] Attempting cliclick fallback`);
        // First check if cliclick is available
        await execPromise(`which cliclick`);
        // If available, use it
        await execPromise(`cliclick c:${position.x},${position.y}`);
        console.log(`[VirtualCursorWindow] cliclick fallback succeeded`);
      } catch (cliclickError) {
        // Last resort: try to install and use cliclick
        try {
          console.log(`[VirtualCursorWindow] Installing cliclick for fallback`);
          const tempDir = path.join(os.tmpdir(), 'cliclick');
          
          // Create temp directory
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          
          // Download and compile cliclick
          await execPromise(`cd ${tempDir} && curl -O https://github.com/BlueM/cliclick/archive/refs/tags/5.1.tar.gz && tar -xzf 5.1.tar.gz && cd cliclick-5.1 && make`);
          
          // Use the compiled cliclick
          await execPromise(`${tempDir}/cliclick-5.1/cliclick c:${position.x},${position.y}`);
          console.log(`[VirtualCursorWindow] Installed and used cliclick successfully`);
        } catch (finalError) {
          console.error("[VirtualCursorWindow] All click methods failed:", finalError);
          console.error("[VirtualCursorWindow] Please ensure the app has accessibility permissions in System Settings > Privacy & Security > Accessibility");
        }
      }
    }
  }

  startDrag(position: CursorPosition): void {
    this.isDragging = true;
    this.moveCursor({ ...position, isDragging: true });
    console.log(`[VirtualCursorWindow] Started drag at (${position.x}, ${position.y})`);
  }

  continueDrag(position: CursorPosition): void {
    if (this.isDragging) {
      this.moveCursor({ ...position, isDragging: true });
    }
  }

  async endDrag(position: CursorPosition): Promise<void> {
    if (this.isDragging) {
      await this.moveCursor({ ...position, isDragging: false });
      await this.performMouseUp(position);
      this.isDragging = false;
      console.log(`[VirtualCursorWindow] Ended drag at (${position.x}, ${position.y})`);
    }
  }

  // Removed unused mouse functions: _performMouseDown, _performMouseMove

  private async performMouseUp(position: CursorPosition): Promise<void> {
    const swiftScript = `
      import Cocoa
      let point = CGPoint(x: ${position.x}, y: ${position.y})
      let mouseUp = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
      )
      mouseUp?.post(tap: .cghidEventTap)
    `;
    await execPromise(`echo '${swiftScript}' | swift -`);
  }

  async performScroll(delta: { x: number; y: number }): Promise<void> {
    try {
      // Use Swift to perform scroll
      const swiftScript = `
        import Cocoa
        
        let scrollEvent = CGEvent(
          scrollWheelEvent2Source: nil,
          units: .pixel,
          wheelCount: 2,
          wheel1: Int32(${-delta.y}),
          wheel2: Int32(${-delta.x}),
          wheel3: 0
        )
        
        scrollEvent?.post(tap: .cghidEventTap)
      `;
      
      await execPromise(`echo '${swiftScript}' | swift -`);
    } catch (error) {
      console.error("Error performing scroll:", error);
    }
  }

  destroy(): void {
    if (this.window) {
      this.window.close();
      this.window = null;
    }
  }
} 