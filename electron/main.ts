import "dotenv/config";
import { app, BrowserWindow, ipcMain, screen, Notification } from "electron";
import { fileURLToPath } from "node:url";
import { run } from "@openai/agents";
import { stepsAgent, scriptsAgent } from "./ai.ts";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs, { writeFile } from "fs";
import { Jimp } from "jimp";

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
    height: 198,
    resizable: false,
    trafficLightPosition: { x: -100, y: -100 },
    // alwaysOnTop: true,
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
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  console.log(width, height);
  console.log("getting steps");

  const folderName = `screenshots/${Date.now()}-${msg.replaceAll(" ", "-")}`;
  try {
    if (!fs.existsSync(folderName)) {
      fs.mkdirSync(folderName);
      console.log("created folder");
    }
  } catch (err) {
    console.log("did not create folder");
    console.error(err);
  }

  let stepHistory = "";
  while (true) {
    console.log("taking screenshot");

    // const tmpPath = path.join(os.tmpdir(), "temp_screenshot.png");
    const tmpPath = path.join(__dirname, `${Date.now}-screenshot.png`);

    await execPromise(`screencapture -C -x "${tmpPath}"`);
    const image = await Jimp.read(tmpPath);
    image.resize({ w: width, h: height });
    console.log(image.width, image.height);

    const dotColor = 0x00ff00ff; // red with full alpha
    const radius = 5;

    for (let y = 0; y < image.bitmap.height; y += 100) {
      for (let x = 0; x < image.bitmap.width; x += 100) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const dist = dx * dx + dy * dy;
            if (dist <= radius * radius) {
              image.setPixelColor(dotColor, x + dx, y + dy);
            }
          }
        }
      }
    }

    const img = await image.getBase64("image/png");
    fs.unlink(tmpPath, (err) => {
      if (err) console.error(err);
    });

    const stepsOutput = (
      await run(stepsAgent, [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Initial task request: ${msg}

  All previous steps taken so far:
  ${stepHistory}
  `,
            },
            { type: "input_image", image: img },
          ],
        },
      ])
    ).state._currentStep;
    console.log(stepsOutput);
    if (stepsOutput?.type != "next_step_final_output") return;
    const stepString = stepsOutput?.output;
    stepHistory += "\n" + stepString;
    if (stepString == "stop") break;
    new Notification({ title: "Running Step", body: stepString }).show();

    console.log(`${Date.now()} - ${stepString}`);

    const base64Data = img.replace(/^data:image\/png;base64,/, "");

    writeFile(
      `${folderName}/${Date.now()}-${stepString
        .replaceAll(" ", "-")
        .replaceAll(",", "")
        .replaceAll("/", "")}.png`,
      base64Data,
      "base64",
      function (err) {
        if (err) console.log("error" + err);
        //   console.log(typeof img, img);
      }
    );

    const scriptOutput = (
      await run(scriptsAgent, [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Instruction to execute: ${stepString}

Dimensions of window: ${width}x${height}`,
            },
            { type: "input_image", image: img },
          ],
        },
      ])
    ).state._currentStep;
    if (scriptOutput?.type != "next_step_final_output") continue;
    let script = scriptOutput?.output;

    if (script) {
      script = script.replaceAll("```applescript", "").replaceAll("```", "");
      try {
        // const scriptWithEscapedQuotes = script.replace(/"/g, '\\"');
        console.log(script);
        writeFile("./temp/script.scpt", script, (err) => {
          if (err) console.error(err);
        });
        const { stdout, stderr } = await execPromise(
          `osascript ./temp/script.scpt`
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
  new Notification({ title: "Task complete", body: "we are done" }).show();

  event.sender.send("reply", "Received: " + msg);
});
