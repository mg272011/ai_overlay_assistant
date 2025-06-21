import "dotenv/config";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { run } from "@openai/agents";
import { stepsAgent } from "./ai.ts";
import path from "node:path";
import { exec } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "electron-vite.svg"),
    width: 500,
    height: 100,
    resizable: false,
    ...(process.platform === "darwin"
      ? {
          autoHideMenuBar: true,
          titleBarStyle: "hiddenInset",
          frame: false
        }
      : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.mjs")
    }
  });
  win.webContents.openDevTools({ mode: "detach" });

  // Test active push message to Renderer-process.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady().then(createWindow);

ipcMain.on("message", async (event, msg) => {
  console.log("Got message:", msg);
  win?.setSize(500, 500);

  const stepsOutput = (
    await run(stepsAgent, [
      { type: "reasoning", content: [{ type: "input_text", text: msg }] }
    ])
  ).state._currentStep;
  if (stepsOutput?.type != "next_step_final_output") return;

  const stepsString = stepsOutput?.output;
  const steps = stepsString.split("\n");
  console.log(steps);

  for (const step of steps) {
    if (step) {
      exec(`osascript -e '${step}'`, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          return;
        }
        if (stderr) {
          console.error(`stderr: ${stderr}`);
        }
        console.log(stdout);
      });
    }
  }

  event.sender.send("reply", "Received: " + msg);
});
