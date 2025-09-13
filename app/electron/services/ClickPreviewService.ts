import { BrowserWindow, screen } from 'electron';

export class ClickPreviewService {
  private static win: BrowserWindow | null = null;

  private static async ensureWindow(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) return;

    const { width, height, x, y } = screen.getPrimaryDisplay().bounds;

    this.win = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    // Click-through, visible on all workspaces
    try { this.win.setIgnoreMouseEvents(true, { forward: true } as any); } catch {}
    try { this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any); } catch {}
    try { this.win.setAlwaysOnTop(true, 'screen-saver' as any); } catch {}

    const html = `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
  #root{position:fixed;inset:0;pointer-events:none}
  #dot{position:absolute;width:18px;height:18px;border-radius:50%;
       background: radial-gradient(circle at center, rgba(37,99,235,0.95) 0%, rgba(37,99,235,0.6) 40%, rgba(37,99,235,0.0) 70%);
       box-shadow: 0 0 16px rgba(37,99,235,0.85), 0 0 36px rgba(37,99,235,0.55);
       transform: translate(-50%, -50%);
  }
</style></head><body>
  <div id="root"><div id="dot" style="left:-1000px;top:-1000px"></div></div>
  <script>
    const { ipcRenderer } = require('electron');
    const dot = document.getElementById('dot');
    ipcRenderer.on('click-preview:show', (e, pos) => {
      if (!dot) return;
      dot.style.left = pos.x + 'px';
      dot.style.top = pos.y + 'px';
    });
  </script>
</body></html>`;

    await this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }

  static async showDot(x: number, y: number): Promise<void> {
    try {
      await this.ensureWindow();
      if (!this.win) return;

      // Determine the display that contains the point and align overlay to it
      const display = screen.getDisplayNearestPoint({ x, y });
      const bounds = display.bounds; // Window base origin (top-left of display)
      const workArea = display.workArea; // Excludes menu bar/dock
      const menuBarOffsetY = Math.max(0, workArea.y - bounds.y);

      // Ensure the overlay covers the correct display
      try { this.win.setBounds(bounds); } catch {}

      // Bring to front and show (persistent)
      try { this.win.setAlwaysOnTop(true, 'screen-saver' as any); } catch {}
      try { this.win.showInactive(); } catch {}
      try { (this.win as any)?.moveTop?.(); } catch {}

      // Rebase global screen coords to window-local coords and nudge for menu bar
      const localX = Math.round(x - bounds.x);
      const localY = Math.round(y - bounds.y - menuBarOffsetY);

      // Move the persistent dot to (localX, localY)
      this.win.webContents.send('click-preview:show', { x: localX, y: localY });
    } catch (err) {
      console.log('[ClickPreview] failed to show dot:', err);
    }
  }
} 