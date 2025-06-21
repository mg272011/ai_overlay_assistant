import "dotenv/config";
import { app, BrowserWindow, ipcMain, desktopCapturer, screen } from "electron";
import { fileURLToPath } from "node:url";
import { run } from "@openai/agents";
import { stepsAgent, scriptsAgent } from "./ai.ts";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execPromise = promisify(exec);

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
        height: 180,
        resizable: false,
        ...(process.platform === "darwin"
            ? {
                  autoHideMenuBar: true,
                  titleBarStyle: "hiddenInset",
                  frame: false,
              }
            : {}),
        webPreferences: {
            contextIsolation: true,
            preload: path.join(__dirname, "preload.mjs"),
        },
    });
    win.webContents.openDevTools({ mode: "detach" });

    // Test active push message to Renderer-process.
    win.webContents.on("did-finish-load", () => {
        win?.webContents.send(
            "main-process-message",
            new Date().toLocaleString(),
        );
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
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
    });
    let img = sources[0].thumbnail.toDataURL();

    const stepsOutput = (
        await run(stepsAgent, [
            {
                role: "user",
                content: [
                    { type: "input_text", text: msg },
                    { type: "input_image", image: img },
                ],
            },
        ])
    ).state._currentStep;
    console.log(stepsOutput);
    if (stepsOutput?.type != "next_step_final_output") return;

    const stepsString = stepsOutput?.output;
    const steps = stepsString.split("\n").filter((s) => s);
    console.log(steps);

    for (const step of steps) {
        img = sources[0].thumbnail.toDataURL();
        const scriptOutput = (
            await run(scriptsAgent, [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: step },
                        { type: "input_image", image: img },
                    ],
                },
            ])
        ).state._currentStep;
        if (scriptOutput?.type != "next_step_final_output") continue;
        const script = scriptOutput?.output;

        if (script) {
            try {
                const scriptWithEscapedQuotes = script.replace(/"/g, '\\"');
                console.log(
                    `osascript -e "${scriptWithEscapedQuotes.replace("\n", '" -e "')}"`,
                );
                const { stdout, stderr } = await execPromise(
                    `osascript -e "${scriptWithEscapedQuotes.replace("\n", '" -e "')}"`,
                );
                if (stderr) {
                    console.error(`stderr: ${stderr}`);
                }
                if (stdout) {
                    console.log(stdout);
                }
            } catch (e) {
                console.error("error executing script: ", e);
            }
        }
    }

    event.sender.send("reply", "Received: " + msg);
});
