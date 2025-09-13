import runAppleScript from "./tools/appleScript";
import runBashScript from "./tools/bash";
import click from "./tools/click";
import key from "./tools/key";
import { openUri } from "./tools/uri";
import { searchOnBrowser } from "./tools/search";
import { hoverAt, rightClickAt, middleClickAt, doubleClickAt, dragAndDrop, scrollAt } from "./tools/mouse";
import { ActionResult, Element } from "./types";
import { logWithElapsed } from "./utils/utils";

export async function performAction(
  action: string,
  bundleId: string,
  clickableElements: Element[],
  event: any
): Promise<ActionResult | ActionResult[]> {
  logWithElapsed("performAction", `Performing action: ${action} (agent mode removed)`);

  // Split into commands: lines starting with =
  const commandRegex = /(^=\w+[ \n][^=]*)/gms;
  const matches = action.match(commandRegex);
  if (matches && matches.length > 1) {
    const results: ActionResult[] = [];
    for (const cmd of matches) {
      // Recursively call performAction for each command
      // Remove leading/trailing whitespace
      const res = await performAction(
        cmd.trim(),
        bundleId,
        clickableElements,
        event
      );
      if (Array.isArray(res)) results.push(...res);
      else results.push(res);
    }
    return results;
  }

  const match = action.match(/^(=\w+)[ \n]?(.*)$/s);
  const address = match ? match[1] : action;
  const body = match ? match[2] : "";

  // Agent mode removed - all collaborative cursor actions disabled
  if (address.startsWith("=Cursor") || address === "=FindAndClickText" || address === "=TypeText" || address === "=OpenApp") {
    event.sender.send("reply", { 
      type: "action", 
      message: "Agent mode has been disabled. Collaborative actions are no longer available." 
    });
    return { 
      type: "error", 
      message: "Agent mode disabled"
    } as any;
  }

  switch (address) {
    case "=Applescript": {
      console.log(`[performAction] Executing Applescript`);
      const res = await runAppleScript(body);
      return res as any;
    }

    case "=URI": {
      const res = await openUri(body);
      return res as any;
    }

    case "=Search": {
      const res = await searchOnBrowser(body.trim());
      return res as any;
    }

    case "=Bash": {
      const res = await runBashScript(body);
      return res as any;
    }

    case "=Key": {
      const res = await key(body, bundleId);
      return res as any;
    }

    case "=Click": {
      const res = await click(body.trim(), clickableElements, bundleId);
      return res as any;
    }

    // New mouse primitives
    case "=Hover": {
      const [xStr, yStr, durStr] = body.trim().split(/\s+/);
      const x = Number(xStr), y = Number(yStr), dur = Number(durStr || '200');
      console.log(`[COORDINATES] 🎯 Hover at coordinates: (${x}, ${y}) duration: ${dur}ms`);
      await hoverAt(x, y, dur);
      return { type: "cursor-move", x, y } as any;
    }
    case "=RightClick": {
      const [xStr, yStr] = body.trim().split(/\s+/);
      const x = Number(xStr), y = Number(yStr);
      console.log(`[COORDINATES] 🖱️ Right click at coordinates: (${x}, ${y})`);
      await rightClickAt(x, y);
      return { type: "cursor-click", x, y } as any;
    }
    case "=MiddleClick": {
      const [xStr, yStr] = body.trim().split(/\s+/);
      const x = Number(xStr), y = Number(yStr);
      console.log(`[COORDINATES] 🖱️ Middle click at coordinates: (${x}, ${y})`);
      await middleClickAt(x, y);
      return { type: "cursor-click", x, y } as any;
    }
    case "=DoubleClick": {
      const [xStr, yStr] = body.trim().split(/\s+/);
      const x = Number(xStr), y = Number(yStr);
      console.log(`[COORDINATES] 🖱️ Double click at coordinates: (${x}, ${y})`);
      await doubleClickAt(x, y);
      return { type: "cursor-click", x, y } as any;
    }
    case "=Scroll": {
      const [xStr, yStr, dxStr, dyStr] = body.trim().split(/\s+/);
      const x = Number(xStr), y = Number(yStr), dx = Number(dxStr || '0'), dy = Number(dyStr || '-120');
      console.log(`[COORDINATES] 🔄 Scroll at coordinates: (${x}, ${y}) delta: (${dx}, ${dy})`);
      await scrollAt(x, y, dx, dy);
      return { type: "cursor-scroll", x, y } as any;
    }
    case "=DragDrop": {
      const [sx, sy, ex, ey, dur] = body.trim().split(/\s+/);
      const startX = Number(sx), startY = Number(sy), endX = Number(ex), endY = Number(ey), duration = Number(dur || '200');
      console.log(`[COORDINATES] ↔️ Drag from coordinates: (${startX}, ${startY}) to (${endX}, ${endY}) duration: ${duration}ms`);
      await dragAndDrop(startX, startY, endX, endY, duration);
      return { type: "cursor-drag-end", x: endX, y: endY } as any;
    }

    // Clipboard
    case "=ClipboardWrite": {
      // Body can be JSON with { text?, html?, imageBase64? }
      // This action should be invoked from renderer via preload clipboard API; no-op here
      return { type: "unknown tool" } as any;
    }

    default: {
      logWithElapsed("performAction", `Unknown action: ${action}`);
      return { type: "unknown" } as any;
    }
  }
}
