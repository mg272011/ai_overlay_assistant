import runAppleScript from "./tools/appleScript";
import runBashScript from "./tools/bash";
import click from "./tools/click";
import key from "./tools/key";
import { openUri } from "./tools/uri";
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

    default: {
      logWithElapsed("performAction", `Unknown action: ${action}`);
      return { type: "unknown" } as any;
    }
  }
}
