import { BrowserWindow, screen } from 'electron';

export class AgentOverlayService {
  // Use a shared window across instances so pulses don't spawn multiple overlays
  private static win: BrowserWindow | null = null;

  async ensure(): Promise<void> {
    if (AgentOverlayService.win && !AgentOverlayService.win.isDestroyed()) return;
    const { width, height } = screen.getPrimaryDisplay().bounds;
    AgentOverlayService.win = new BrowserWindow({
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      focusable: false,
      show: true,
      skipTaskbar: true,
    });
    AgentOverlayService.win.setIgnoreMouseEvents(true, { forward: true } as any);
    AgentOverlayService.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any);
    // Ensure overlay appears above EVERYTHING including Dock and fullscreen windows
    try { AgentOverlayService.win.setAlwaysOnTop(true, 'floating' as any); } catch {}
    // Force to front in pulse method too
    AgentOverlayService.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any);
    await AgentOverlayService.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(this.html()));
  }

  private html(): string {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;}
  #root{position:fixed;inset:0;pointer-events:none;}

  /* Hidden glow - no visual effect */
  .glow{position:absolute;inset:0;border-radius:18px;opacity:0;transform:scale(0.95);}
  .glow:before{content:"";position:absolute;inset:0;border-radius:18px;
    box-shadow: none;
    filter: none;
    -webkit-mask: none;
  }

  /* Show animation - no visual effect */
  .glow.show{
    opacity:0;
    transform:scale(1);
  }

  /* No pulse animation */
  .burst{}

  /* No animations */

  *{user-select:none;-webkit-user-select:none;cursor:default}
</style></head>
<body>
  <div id="root">
    <div id="halo" class="glow"></div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const el = document.getElementById('halo');
    ipcRenderer.on('agent-overlay:show',()=>{
      el.classList.add('show');
    });
    ipcRenderer.on('agent-overlay:pulse',()=>{
      el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst');
    });
    ipcRenderer.on('agent-overlay:hide',()=>{
      el.classList.remove('show');
    });
  </script>
</body></html>`;
  }

  async show(): Promise<void> {
    await this.ensure();
    try { AgentOverlayService.win?.setAlwaysOnTop(true, 'floating' as any); } catch {}
    try { AgentOverlayService.win?.showInactive(); } catch {}
    try { (AgentOverlayService.win as any)?.moveTop?.(); } catch {}
    try {
      AgentOverlayService.win?.webContents.send('agent-overlay:show');
      console.log('[AgentOverlay] Show animation triggered');
    } catch (error) {
      console.log('[AgentOverlay] Failed to show overlay:', error);
    }
  }

  async pulse(): Promise<void> {
    await this.ensure();
    try { AgentOverlayService.win?.setAlwaysOnTop(true, 'floating' as any); } catch {}
    try { AgentOverlayService.win?.showInactive(); } catch {}
    try { (AgentOverlayService.win as any)?.moveTop?.(); } catch {}
    try {
      AgentOverlayService.win?.webContents.send('agent-overlay:pulse');
      console.log('[AgentOverlay] Pulse sent to overlay window');
    } catch (error) {
      console.log('[AgentOverlay] Failed to send pulse:', error);
    }
  }

  async hide(): Promise<void> {
    try { 
      AgentOverlayService.win?.webContents.send('agent-overlay:hide');
      // Give animation time to complete before hiding window
      setTimeout(() => {
        AgentOverlayService.win?.hide();
      }, 400);
    } catch {}
  }

  async destroy(): Promise<void> {
    try {
      if (AgentOverlayService.win && !AgentOverlayService.win.isDestroyed()) {
        AgentOverlayService.win.close();
      }
    } catch {}
    AgentOverlayService.win = null;
  }
} 