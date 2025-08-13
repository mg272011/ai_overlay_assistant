import runAppleScript from "./tools/appleScript";
import runBashScript from "./tools/bash";
import click from "./tools/click";
import key from "./tools/key";
import { openUri } from "./tools/uri";
import { ActionResult, Element } from "./types";
import { logWithElapsed, execPromise } from "./utils/utils";
import { VirtualCursorWindow } from "./virtualCursor/VirtualCursorWindow";

// Global virtual cursor instance
let virtualCursor: VirtualCursorWindow | null = null;

export function getVirtualCursor(): VirtualCursorWindow {
  if (!virtualCursor) {
    virtualCursor = new VirtualCursorWindow();
  }
  return virtualCursor;
}

export async function performAction(
  action: string,
  bundleId: string,
  clickableElements: Element[],
  event: any,
  isAgentMode: boolean = false
): Promise<ActionResult | ActionResult[]> {
  logWithElapsed("performAction", `Performing action: ${action} (collab mode: ${isAgentMode})`);

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
        event,
        isAgentMode
      );
      if (Array.isArray(res)) results.push(...res);
      else results.push(res);
    }
    return results;
  }

  const match = action.match(/^(=\w+)[ \n]?(.*)$/s);
  const address = match ? match[1] : action;
  const body = match ? match[2] : "";

  // Handle collaborative cursor actions
  if (isAgentMode) {
    const cursor = getVirtualCursor();
    
    switch (address) {
      case "=CursorMove": {
        const coords = body.match(/(\d+),(\d+)/);
        if (coords) {
          const x = parseInt(coords[1]);
          const y = parseInt(coords[2]);
          await cursor.moveCursor({ x, y });
          event.sender.send("reply", {
            type: "action",
            message: `Moved cursor to (${x}, ${y})`,
          });
          return { type: "cursor-move", x, y };
        }
        break;
      }
      
      case "=CursorClick": {
        const coords = body.match(/(\d+),(\d+)/);
        if (coords) {
          const x = parseInt(coords[1]);
          const y = parseInt(coords[2]);
          await cursor.performClick({ x, y });
          event.sender.send("reply", {
            type: "action",
            message: `Clicked at (${x}, ${y})`,
          });
          return { type: "cursor-click", x, y };
        }
        break;
      }
      
      case "=CursorDragStart": {
        const coords = body.match(/(\d+),(\d+)/);
        if (coords) {
          const x = parseInt(coords[1]);
          const y = parseInt(coords[2]);
          cursor.startDrag({ x, y });
          event.sender.send("reply", {
            type: "action",
            message: `Started drag at (${x}, ${y})`,
          });
          return { type: "cursor-drag-start", x, y };
        }
        break;
      }
      
      case "=CursorDragMove": {
        const coords = body.match(/(\d+),(\d+)/);
        if (coords) {
          const x = parseInt(coords[1]);
          const y = parseInt(coords[2]);
          cursor.continueDrag({ x, y });
          return { type: "cursor-drag-move", x, y };
        }
        break;
      }
      
      case "=CursorDragEnd": {
        const coords = body.match(/(\d+),(\d+)/);
        if (coords) {
          const x = parseInt(coords[1]);
          const y = parseInt(coords[2]);
          cursor.endDrag({ x, y });
          event.sender.send("reply", {
            type: "action",
            message: `Ended drag at (${x}, ${y})`,
          });
          return { type: "cursor-drag-end", x, y };
        }
        break;
      }
      
      case "=CursorScroll": {
        const delta = body.match(/(-?\d+),(-?\d+)/);
        if (delta) {
          const x = parseInt(delta[1]);
          const y = parseInt(delta[2]);
          await cursor.performScroll({ x, y });
          event.sender.send("reply", {
            type: "action",
            message: `Scrolled by (${x}, ${y})`,
          });
          return { type: "cursor-scroll", x, y };
        }
        break;
      }

      // Vision-guided find and click by text label in collab mode (no AppleScript)
      case "=FindAndClickText": {
        const target = (body || '').trim();
        if (!target) break;
        const timestampFolder = `${process.cwd()}/logs/${Date.now()}-agent`;
        try {
          // 1) Try fast local OCR via Swift (no screenshot roundtrip)
          try {
            const { execPromise } = await import("./utils/utils");
            const { stdout } = await execPromise(`swift swift/ocr.swift ${JSON.stringify(target)}`);
            const data = JSON.parse(stdout || '{}');
            if (data?.found && Number.isFinite(data.x) && Number.isFinite(data.y)) {
              const x = Math.round(data.x); const y = Math.round(data.y);
              await cursor.moveCursor({ x, y });
              await new Promise(r => setTimeout(r, 80));
              await cursor.performClick({ x, y });
              event.sender.send("reply", { type: "action", message: `Clicked '${target}' at (${x}, ${y}) [local OCR]` });
              return { type: "cursor-click", x, y } as any;
            }
          } catch {}

          // 2) Fallback to Gemini vision using Electron screenshot
          const { takeAndSaveScreenshots } = await import("./utils/screenshots");
          const { geminiVision } = await import("./services/GeminiVisionService");
          const screenshot = await takeAndSaveScreenshots("Desktop", timestampFolder);
          const res = await geminiVision.analyzeScreenForElement(
            screenshot,
            `Clickable UI for text or label "${target}". Return FOUND: {x,y} for the clickable center.`
          );
          if (!res.found || res.x == null || res.y == null) {
            event.sender.send("reply", { type: "action", message: `Could not find ${target}` });
            return { type: "cursor-click", x: -1, y: -1, error: `Not found: ${target}` } as any;
          }
          const x = res.x, y = res.y;
          await cursor.moveCursor({ x, y });
          await new Promise(r => setTimeout(r, 120));
          await cursor.performClick({ x, y });
          event.sender.send("reply", { type: "action", message: `Clicked '${target}' at (${x}, ${y}) [gemini]` });
          return { type: "cursor-click", x, y };
        } catch (err: any) {
          event.sender.send("reply", { type: "action", message: `Vision click failed: ${String(err?.message || err)}` });
          return { type: "cursor-click", x: -1, y: -1, error: String(err?.message || err) } as any;
        }
      }

      // Type text via Swift key tool in collab mode (no AppleScript)
      case "=TypeText": {
        const text = body ?? '';
        const res = await key(text, bundleId);
        event.sender.send("reply", { type: "action", message: `Typed text (${text.length} chars)` });
        return res as any;
      }
    }
  }

  // Regular mode actions (existing implementation)
  // Block AppleScript entirely when in collab/agent mode
  if (isAgentMode && address === "=Applescript") {
    logWithElapsed("performAction", "Skipping AppleScript in collab mode");
    event.sender.send("reply", { type: "action", message: `Skipped AppleScript in collab mode` });
    return { type: "applescript", script: body, error: "blocked in collab" } as any;
  }
  switch (address) {
    case "=Applescript": {
      console.log(`[performAction] Executing Applescript in ${isAgentMode ? 'COLLAB' : 'REGULAR'} mode`);
      console.log(`[performAction] Applescript body: ${body.substring(0, 100)}...`);
      
      // In collaborative mode, skip redundant app activation if user already opened it
      if (isAgentMode) {
        try {
          const activateMatch = body.match(/tell application\s+"([^"]+)"[\s\S]*?activate/i);
          const openMatch = body.match(/activate application\s+"([^"]+)"/i);
          const targetApp = (activateMatch && activateMatch[1]) || (openMatch && openMatch[1]);
          if (targetApp) {
            const { stdout } = await execPromise(`osascript -e 'tell application "System Events" to name of first process whose frontmost is true'`);
            const frontmost = stdout.trim();
            if (frontmost === targetApp) {
              console.log(`[performAction] Skipping activate for ${targetApp} — already frontmost`);
              event.sender.send("reply", { type: "action", message: `${targetApp} already open` });
              return { type: "applescript", script: body, error: "" } as any;
            }
          }
        } catch {}
      }
      
      // In collab mode, show cursor movement to indicate action
      if (isAgentMode) {
        const cursor = getVirtualCursor();
        
        {
          // For other AppleScript commands, show circular motion
          const centerX = 960;
          const centerY = 540;
          for (let angle = 0; angle < 360; angle += 45) {
            const x = centerX + Math.cos(angle * Math.PI / 180) * 50;
            const y = centerY + Math.sin(angle * Math.PI / 180) * 50;
            await cursor.moveCursor({ x, y });
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          await cursor.moveCursor({ x: centerX, y: centerY });
        }
      }
      
      const res = await runAppleScript(body);
      if (res.error) {
        event.sender.send("reply", {
          type: "action",
          message: "Error when excecuting script: " + res.error,
        });
      } else {
        event.sender.send("reply", {
          type: "action",
          message: "Executed script",
        });
      }
      return res;
    }

    case "=URI": {
      // In collab mode, show cursor movement to indicate URI opening
      if (isAgentMode) {
        const cursor = getVirtualCursor();
        // Move cursor to top-center (address bar area)
        await cursor.moveCursor({ x: 960, y: 50 });
        await new Promise(resolve => setTimeout(resolve, 200));
        // Quick horizontal movement to simulate URL entry
        for (let x = 960; x < 1100; x += 20) {
          await cursor.moveCursor({ x, y: 50 });
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      
      const res = await openUri(body);
      event.sender.send("reply", {
        type: "action",
        message: `Opened URI ${body}`,
      });
      return res;
    }

    case "=Bash": {
      // In collab mode, show cursor movement to indicate command execution
      if (isAgentMode) {
        const cursor = getVirtualCursor();
        // Move cursor to bottom of screen (terminal area) and back
        await cursor.moveCursor({ x: 100, y: 900 });
        await new Promise(resolve => setTimeout(resolve, 200));
        for (let x = 100; x < 300; x += 20) {
          await cursor.moveCursor({ x, y: 900 });
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
      
      const res = await runBashScript(body);
      if (res.error) {
        event.sender.send("reply", {
          type: "action",
          message: "Error when excecuting script: " + res.error,
        });
      } else {
        event.sender.send("reply", {
          type: "action",
          message: "Executed script",
        });
      }
      return res;
    }

    case "=Key": {
      // In collab mode, show cursor movement for typing
      if (isAgentMode) {
        const cursor = getVirtualCursor();
        
        // Move cursor to indicate typing action
        // Try to find an input field or use center of screen
        const activeElement = clickableElements.find(el => 
          el.AXRole === "AXTextField" || 
          el.AXRole === "AXTextArea" ||
          el.AXRole === "AXSearchField" ||
          el.AXDescription?.includes("text")
        );
        
        if (activeElement && activeElement.AXFrame) {
          // Move to actual input field
          const frameMatch = activeElement.AXFrame.match(/x:(\d+) y:(\d+)/);
          if (frameMatch) {
            const x = parseInt(frameMatch[1]) + 20;
            const y = parseInt(frameMatch[2]) + 10;
            await cursor.moveCursor({ x, y });
            
            // Animate typing effect
            const chars = body.replace(/\^[a-z+]+/g, '').substring(0, 20);
            for (let i = 0; i < chars.length; i++) {
              await new Promise(resolve => setTimeout(resolve, 30));
              await cursor.moveCursor({ x: x + (i * 3), y });
            }
          }
        } else {
          // Default position if no input field found
          await cursor.moveCursor({ x: 960, y: 400 });
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      const res = await key(body, bundleId);
      event.sender.send("reply", {
        type: "action",
        message: `Sent key: ${res.keyString}`,
      });
      return res;
    }

    case "=Click": {
      // In collab mode, use virtual cursor for clicks on elements
      if (isAgentMode) {
        const element = clickableElements.find((el) => {
          if (typeof el === "object" && el !== null) {
            const rec = el as unknown as Record<string, unknown>;
            return String(rec.id) === body || String(rec.elementId) === body;
          }
          return false;
        });
        
        if (element && element.AXFrame) {
          // Extract coordinates from AXFrame - handle both formats
          let frameMatch = element.AXFrame.match(/x:(\d+) y:(\d+) w:(\d+) h:(\d+)/);
          if (!frameMatch) {
            // Fallback to simple x:y format
            frameMatch = element.AXFrame.match(/x:(\d+) y:(\d+)/);
          }
          
          if (frameMatch) {
            const x = parseInt(frameMatch[1]) + 10; // Click near the start of element
            const y = parseInt(frameMatch[2]) + 10;
            const width = frameMatch[3] ? parseInt(frameMatch[3]) : 100; // Default width if not provided
            const height = frameMatch[4] ? parseInt(frameMatch[4]) : 30; // Default height if not provided
            
            console.log(`[Click] Element ${body} (${element.AXTitle || element.AXDescription || 'Unknown'}) at (${x}, ${y}), size: ${width}x${height}`);
            
            const cursor = getVirtualCursor();
            
            // Check if element is visible on screen (rough estimate)
            const screenHeight = 1080; // Could get actual screen height
            const screenWidth = 1920;  // Could get actual screen width
            const isVisible = x >= 0 && y >= 0 && x < screenWidth && y < screenHeight;
            
            if (!isVisible || y > screenHeight - 200) {
              // Element might be off-screen or near bottom, scroll to make it visible
              console.log(`[Click] Element at (${x}, ${y}) might not be visible (screen: ${screenWidth}x${screenHeight}), scrolling first`);
              
              // Move cursor to center of screen and scroll
              await cursor.moveCursor({ x: screenWidth / 2, y: screenHeight / 2 });
              await new Promise(resolve => setTimeout(resolve, 300));
              
              // Scroll down to reveal the element (negative y scrolls up, positive scrolls down)
              const scrollAmount = Math.max(200, y - screenHeight / 2);
              console.log(`[Click] Scrolling by ${scrollAmount} pixels to reveal element`);
              await cursor.performScroll({ x: 0, y: scrollAmount });
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Update coordinates after scrolling (estimate)
              const newY = Math.max(100, y - scrollAmount);
              console.log(`[Click] Moving cursor to element at estimated new position (${x}, ${newY})`);
              
              // Move cursor to the element's new position
              await cursor.moveCursor({ x, y: newY });
              await new Promise(resolve => setTimeout(resolve, 200));
              
              // Click at the new position
              await cursor.performClick({ x, y: newY });
              
              event.sender.send("reply", {
                type: "action",
                message: `Scrolled to and clicked element with id ${body} at (${x}, ${newY})`,
                id: body,
                element: element || null,
              });
            } else {
              // Element is visible, proceed normally
              console.log(`[Click] Element is visible, clicking directly at (${x}, ${y})`);
              await cursor.moveCursor({ x, y });
            await new Promise(resolve => setTimeout(resolve, 200));
            await cursor.performClick({ x, y });
            
            event.sender.send("reply", {
              type: "action",
              message: `Clicked element with id ${body} at (${x}, ${y})`,
              id: body,
              element: element || null,
            });
            }
            
            return { type: "click", id: body, element: element || null };
          }
        } else {
          // Even if element not found or no frame, still show cursor movement
          // Try to use the regular click tool but show some cursor feedback
          const cursor = getVirtualCursor();
          
          // Move cursor to center of screen briefly to show activity
          await cursor.moveCursor({ x: 960, y: 540 });
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Perform regular click
          const res = await click(body, clickableElements, bundleId);
          
          // If click succeeded and we have element coordinates, show cursor there
          if (!res.error && res.element && res.element.AXFrame) {
            const frameMatch = res.element.AXFrame.match(/x:(\d+) y:(\d+)/);
            if (frameMatch) {
              const x = parseInt(frameMatch[1]) + 10;
              const y = parseInt(frameMatch[2]) + 10;
              await cursor.moveCursor({ x, y });
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          
          if (!res.error) {
            event.sender.send("reply", {
              type: "action",
              message:
                `Clicked element with id ${res.id}` +
                (res.element
                  ? `${
                      res.element.AXRole !== "" && res.element.AXRole
                        ? ` (${res.element.AXRole})`
                        : ""
                    }` +
                    `${
                      res.element.AXTitle !== "" && res.element.AXTitle
                        ? ` (title: ${res.element.AXTitle})`
                        : ""
                    }` +
                    `${
                      res.element.AXValue !== "" && res.element.AXValue
                        ? ` (value: ${res.element.AXValue})`
                        : ""
                    }` +
                    `${
                      res.element.AXHelp !== "" && res.element.AXHelp
                        ? ` (help: ${res.element.AXHelp})`
                        : ""
                    }` +
                    `${
                      res.element.AXDescription !== "" && res.element.AXDescription
                        ? ` (desc: ${res.element.AXDescription})`
                        : ""
                    }`
                  : ""),
              id: res.id,
              element: res.element || null,
            });
          } else {
            event.sender.send("reply", {
              type: "action",
              message: `Error when clicking: ${res.error}`,
            });
          }
          return res;
        }
      }
      
      // Fallback to regular click (non-collab mode)
      const res = await click(body, clickableElements, bundleId);
      if (!res.error) {
        event.sender.send("reply", {
          type: "action",
          message:
            `Clicked element with id ${res.id}` +
            (res.element
              ? `${
                  res.element.AXRole !== "" && res.element.AXRole
                    ? ` (${res.element.AXRole})`
                    : ""
                }` +
                `${
                  res.element.AXTitle !== "" && res.element.AXTitle
                    ? ` (title: ${res.element.AXTitle})`
                    : ""
                }` +
                `${
                  res.element.AXValue !== "" && res.element.AXValue
                    ? ` (value: ${res.element.AXValue})`
                    : ""
                }` +
                `${
                  res.element.AXHelp !== "" && res.element.AXHelp
                    ? ` (help: ${res.element.AXHelp})`
                    : ""
                }` +
                `${
                  res.element.AXDescription !== "" && res.element.AXDescription
                    ? ` (desc: ${res.element.AXDescription})`
                    : ""
                }`
              : ""),
          id: res.id,
          element: res.element || null,
        });
      } else {
        event.sender.send("reply", {
          type: "action",
          message: `Error clicking element with id ${res.id}`,
          id: res.id,
          element: res.element || null,
        });
      }
      return res;
    }
    default:
      console.log("Unknown tool: " + address);
      return {
        type: "unknown tool",
      };
  }

  // } else if (action.startsWith("key ")) {
  //   const keyString = action.slice(4);
  //   await execPromise(`swift swift/key.swift ${bundleId} "${keyString}"`);
  //   logWithElapsed("performAction", `Executed key: ${keyString}`);
  //   event.sender.send("reply", {
  //     type: "action",
  //     message: `Sent key: ${keyString}`,
  //   });
  //   return { type: "key", keyString };
  // } else {
  //   logWithElapsed("performAction", `Unknown action: ${action}`);
  //   return { type: "unknown" };
  // }
}
