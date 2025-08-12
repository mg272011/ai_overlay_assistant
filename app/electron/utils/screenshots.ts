import { desktopCapturer } from "electron";
import { execPromise, logWithElapsed } from "./utils";
import { Window } from "../types";

import * as fs from "node:fs";
import * as path from "node:path";

export async function takeAndSaveScreenshots(
  appName: string,
  stepFolder: string
) {
  logWithElapsed(
    "takeAndSaveScreenshots",
    `Taking screenshot of app window for app: ${appName}`
  );
  const { stdout: swiftWindowsStdout } = await execPromise(
    `swift swift/windows.swift`
  );
  logWithElapsed("takeAndSaveScreenshots", `Got swift windows`);
  const swiftWindows = JSON.parse(swiftWindowsStdout).filter(
    (window: Window) => window.app === appName
  );
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 1920, height: 1080 },
  });
  logWithElapsed("takeAndSaveScreenshots", `Got desktop sources`);
  const matchingPairs: Array<{ window: Window; source: any }> = [];
  for (const window of swiftWindows) {
    const source = sources.find(
      (s) => typeof s.name === "string" && s.name === window.name
    );
    if (source) {
      matchingPairs.push({ window, source });
    }
  }
  let screenshotBase64: string | undefined;
  for (const { window, source } of matchingPairs) {
    const image = source.thumbnail;
    if (!image.isEmpty()) {
      const screenshotPath = path.join(
        stepFolder,
        `screenshot-${encodeURI(window.name)}.png`
      );
      fs.writeFileSync(screenshotPath, image.toPNG());
      logWithElapsed(
        "takeAndSaveScreenshots",
        `Saved screenshot: ${screenshotPath}`
      );
      if (!screenshotBase64) {
        screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
      }
    }
  }

  // Fallback: capture entire screen (useful for appName 'Desktop' or when no window thumbnail found)
  if (!screenshotBase64) {
    try {
      const screenSources = await desktopCapturer.getSources({
        types: ["screen"],
        fetchWindowIcons: false,
        thumbnailSize: { width: 1920, height: 1080 },
      });
      const primary = screenSources[0];
      if (primary && !primary.thumbnail.isEmpty()) {
        const screenshotPath = path.join(stepFolder, `screenshot-Desktop.png`);
        fs.writeFileSync(screenshotPath, primary.thumbnail.toPNG());
        logWithElapsed(
          "takeAndSaveScreenshots",
          `Saved screen screenshot: ${screenshotPath}`
        );
        screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
      }
    } catch (e) {
      // ignore here; will throw below if still empty
    }
  }

  if (!screenshotBase64) {
    throw new Error(`No screenshot available for ${appName}`);
  }

  return screenshotBase64;
}
