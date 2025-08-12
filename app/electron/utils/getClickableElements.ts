import * as fs from "node:fs";
import * as path from "node:path";
import { execPromise, logWithElapsed } from "./utils";
import { Element } from "../types";

function parseJsonArrayLoose(stdout: string): any[] {
  try {
    // Try direct parse first
    return JSON.parse(stdout) as any[];
  } catch {}
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = stdout.slice(start, end + 1).trim();
    try { return JSON.parse(slice) as any[]; } catch {}
  }
  throw new Error("Could not parse JSON array from stdout");
}

export async function getClickableElements(
  bundleId: string,
  stepFolder: string
): Promise<{ clickableElements: Element[] }> {
  logWithElapsed(
    "getClickableElements",
    `Getting clickable elements for bundleId: ${bundleId}`
  );
  const { stdout } = await execPromise(`swift swift/click.swift ${bundleId}`);
  let clickableElements: any[];
  try {
    clickableElements = parseJsonArrayLoose(stdout);
    logWithElapsed("getClickableElements", `Parsed clickable elements`);
  } catch (err) {
    logWithElapsed("getClickableElements", `JSON parse error: ${stdout}`);
    throw new Error(`Could not parse clickable elements JSON for ${bundleId}`);
  }
  if (
    typeof clickableElements === "string" &&
    (clickableElements as any).match?.(/App not running|Error|not found|failed/i)
  ) {
    logWithElapsed(
      "getClickableElements",
      `Error in clickable elements: ${clickableElements}`
    );
    throw new Error(clickableElements as any);
  }

  // Special-case: the Dock has no normal windows. Do not attempt window-moving logic.
  if (bundleId === "com.apple.dock") {
    fs.writeFileSync(
      path.join(stepFolder, "clickableElements.json"),
      JSON.stringify(clickableElements, null, 2)
    );
    logWithElapsed("getClickableElements", `Saved clickableElements.json (dock)`);
    return { clickableElements: clickableElements as Element[] };
  }

  if (
    (clickableElements as any[]).length < 5
  ) {
    console.log("Could not get elements. Enabling accessibility");
    await execPromise(`swift swift/manualAccessibility.swift ${bundleId}`);
    const { stdout: windowStdout } = await execPromise(
      `swift swift/windows.swift ${bundleId}`
    );
    const windows = JSON.parse(windowStdout);
    const window = windows[0];
    if (!window) {
      console.log("no windows found");
      return { clickableElements: clickableElements as Element[] };
    }
    // TODO: multi window support
    // for (const window of windows) {
    const { stdout: coordsStdout } = await execPromise(
      `swift swift/moveToOpusDisplay.swift ${window.pid} "${window.name}"`
    );
    console.log("moved window");
    // fetch elements again
    const { stdout } = await execPromise(`swift swift/click.swift ${bundleId}`);
    try {
      clickableElements = parseJsonArrayLoose(stdout);
      logWithElapsed("getClickableElements", `Parsed clickable elements`);
    } catch (err) {
      logWithElapsed("getClickableElements", `JSON parse error: ${stdout}`);
      throw new Error(`Could not parse clickable elements JSON for ${bundleId}`);
    }
    if (
      typeof clickableElements === "string" &&
      (clickableElements as any).match?.(/App not running|Error|not found|failed/i)
    ) {
      logWithElapsed(
        "getClickableElements",
        `Error in clickable elements: ${clickableElements}`
      );
      throw new Error(clickableElements as any);
    }
    await execPromise(
      `swift swift/moveToCoords.swift ${window.pid} "${window.name}" ${coordsStdout}`
    );
    console.log("moved back");
    // }
  }

  fs.writeFileSync(
    path.join(stepFolder, "clickableElements.json"),
    JSON.stringify(clickableElements, null, 2)
  );
  logWithElapsed("getClickableElements", `Saved clickableElements.json`);
  return { clickableElements: clickableElements as Element[] };
}
