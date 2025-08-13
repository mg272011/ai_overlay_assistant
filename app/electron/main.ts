import "dotenv/config";
import { app, BrowserWindow, Notification, nativeImage, screen, globalShortcut } from "electron";

// Debug: Check if API keys are loaded
console.log("🔍 Environment check:");
console.log("OPENAI_API_KEY exists:", !!process.env.OPENAI_API_KEY);
console.log("OPENAI_API_KEY length:", process.env.OPENAI_API_KEY?.length || 0);
console.log("OPENAI_API_KEY starts with sk-:", process.env.OPENAI_API_KEY?.startsWith('sk-') || false);
console.log("GROQ_API_KEY exists:", !!process.env.GROQ_API_KEY);
console.log("GROQ_API_KEY length:", process.env.GROQ_API_KEY?.length || 0);
console.log("GROQ_API_KEY starts with gsk_:", process.env.GROQ_API_KEY?.startsWith('gsk_') || false);
console.log("DEEPGRAM_API_KEY exists:", !!process.env.DEEPGRAM_API_KEY);
console.log("DEEPGRAM_API_KEY length:", process.env.DEEPGRAM_API_KEY?.length || 0);
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { setupMainHandlers } from "./mainProcessHandlers.ts";
// import { execFile } from "node:child_process"; // Unused
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APP_ROOT = path.join(__dirname, "..");

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
export const ENV = process.env.ENV && process.env.ENV == "DEV" ? "DEV" : "PROD";
export const TMPDIR = path.join(os.tmpdir(), "opus");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "click.png"),
    width: 1400,
    height: 700,
    x: (screen.getPrimaryDisplay().workAreaSize.width - 1400) / 2,
    y: 20,
    resizable: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: false, // Set true during meeting mode via handler
    frame: false,
    skipTaskbar: false,
    movable: true,
    minimizable: true,
    closable: true,
    maximizable: false,
    ...(process.platform === "darwin"
      ? {
          autoHideMenuBar: true,
          titleBarStyle: "hiddenInset",
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.mjs"),
    },
  });
  
  // Make overlay always-on-top and click-through by default
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true } as any);
    win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setFullScreenable(false);
    win.setIgnoreMouseEvents(true, { forward: true } as any);
    // Track initial hidden state (click-through) on the window instance
    (win as any).__opusHidden = true;
  } catch {}
  
  // Hide macOS traffic lights (close/minimize/zoom) if available
  if (process.platform === 'darwin') {
    try { win.setWindowButtonVisibility?.(false); } catch {}
  }
  
  // win.webContents.openDevTools({ mode: "detach" });

    win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
    
    // 🎨 Using CSS-based glass effects (more reliable across different systems)
    console.log('[Glass] Using CSS backdrop-filter effects for cross-platform compatibility');
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  // Reinforce hidden traffic lights after load
  win?.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin' && win) {
      try { win.setWindowButtonVisibility?.(false); } catch {}
    }
  });

  setupMainHandlers({ win });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(() => {
  // Remove virtual display creation - this was causing the blocking issue
  // if (ENV == "DEV") {
  //   execFile(
  //     "./swift/virtualdisplay/DerivedData/virtualdisplay/Build/Products/Debug/virtualdisplay",
  //     ["dev"]
  //   );
  //   console.log("virtual display");
  // }
  // TODO: prod version
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(
      path.join(process.env.VITE_PUBLIC, "click.png")
    );
    app.dock.setIcon(icon);
  }
  if (!fs.existsSync(TMPDIR)) fs.mkdirSync(TMPDIR);
  new Notification({
    title: "Hello from Opus",
    body: "Opus is ready! Type a prompt and run your first task.",
  }).show();
  createWindow();

  // Register global shortcut to toggle Hide (click-through) state
  const toggleHide = () => {
    if (!win || win.isDestroyed()) return;
    const currentlyHidden = !!(win as any).__opusHidden;
    try {
      if (currentlyHidden || !win.isVisible()) {
        // Show: make interactive and bring to front
        win.show();
        try { (win as any).setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
        try { win.setFullScreenable(false); } catch {}
        (win as any).moveTop?.();
        try { win.focus(); } catch {}
        try { win.setIgnoreMouseEvents(false); } catch {}
        (win as any).__opusHidden = false;
      } else {
        // Hide completely
        win.hide();
        (win as any).__opusHidden = true;
      }
    } catch {}
  };

  // Prefer Command+Backspace on macOS, fall back to Command+Delete if needed
  const accelerators = process.platform === 'darwin'
    ? [ 'Command+Backspace', 'Command+Delete' ]
    : [ 'Control+Backspace' ];
  for (const acc of accelerators) {
    try { globalShortcut.register(acc, toggleHide); } catch {}
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});
