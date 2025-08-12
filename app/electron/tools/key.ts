import { logWithElapsed } from "../utils/utils";

export interface KeyReturnType {
  type: "key";
  keyString: string;
}
import { spawn } from "node:child_process";
import runAppleScript from "./appleScript";

function buildAppleScriptFromKeyString(keyString: string): string {
  const tokens = keyString.trim().split(/\s+/).filter(Boolean);
  const modifierMap: Record<string, string> = {
    command: 'command down', cmd: 'command down',
    shift: 'shift down',
    option: 'option down', opt: 'option down', alt: 'option down',
    control: 'control down', ctrl: 'control down', ctl: 'control down'
  };
  const specialKeyCode: Record<string, string> = {
    escape: 'key code 53', esc: 'key code 53',
    left: 'key code 123', right: 'key code 124', down: 'key code 125', up: 'key code 126',
    delete: 'key code 51', backspace: 'key code 51'
  };
  const specialKeystrokeWord: Record<string, string> = {
    enter: 'return', ret: 'return', return: 'return',
    tab: 'tab',
    space: 'space'
  };
  const esc = (s: string) => s.replace(/"/g, '\\"');

  const lines: string[] = [];
  let textBuffer = '';
  const flushText = () => {
    if (textBuffer.length > 0) {
      lines.push(`keystroke "${esc(textBuffer)}"`);
      textBuffer = '';
    }
  };

  for (const token of tokens) {
    if (token.startsWith('^')) {
      flushText();
      const body = token.slice(1); // strip ^
      const parts = body.split('+');
      const mods: string[] = [];
      let key: string | null = null;
      for (const p of parts) {
        const lower = p.toLowerCase();
        if (modifierMap[lower]) {
          if (!mods.includes(modifierMap[lower])) mods.push(modifierMap[lower]);
        } else if (!key) {
          key = p;
        }
      }
      const usingPart = mods.length ? ` using {${mods.join(', ')}}` : '';
      if (!key) continue;
      const lowerKey = key.toLowerCase();
      if (specialKeystrokeWord[lowerKey]) {
        lines.push(`keystroke ${specialKeystrokeWord[lowerKey]}${usingPart}`);
      } else if (specialKeyCode[lowerKey]) {
        lines.push(`${specialKeyCode[lowerKey]}${usingPart}`);
      } else if (key.length === 1) {
        const k = key.length === 1 ? key.toLowerCase() : key;
        lines.push(`keystroke "${esc(k)}"${usingPart}`);
      }
    } else {
      textBuffer += (textBuffer ? ' ' : '') + token;
    }
  }
  flushText();

  if (lines.length === 0) {
    // Fallback: type the whole string
    return `tell application "System Events" to keystroke "${esc(keyString)}"`;
  }
  return `tell application "System Events"
${lines.map(l => '  ' + l).join('\n')}
end tell`;
}

export default async function key(
  body: string,
  bundleId: string
): Promise<KeyReturnType> {
  const keyString = body;
  
  // Use spawn instead of exec to avoid shell escaping issues
  return new Promise((resolve, reject) => {
    const child = spawn('swift', ['swift/key.swift', bundleId, keyString], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', async (code) => {
      if (code === 0) {
        logWithElapsed("performAction", `Executed key: ${keyString}`);
        resolve({ type: "key", keyString });
      } else {
        // AppleScript fallback for collaborative reliability
        try {
          const script = buildAppleScriptFromKeyString(keyString);
          const res = await runAppleScript(script);
          if (!res.error) {
            logWithElapsed("performAction", `Executed key via AppleScript fallback: ${keyString}`);
            resolve({ type: "key", keyString });
            return;
          }
        } catch {}
        reject(new Error(`Key execution failed with code ${code}: ${stderr}`));
      }
    });
    
    child.on('error', async (error) => {
      // AppleScript fallback if spawn fails
      try {
        const script = buildAppleScriptFromKeyString(keyString);
        const res = await runAppleScript(script);
        if (!res.error) {
          logWithElapsed("performAction", `Executed key via AppleScript fallback: ${keyString}`);
          resolve({ type: "key", keyString });
          return;
        }
      } catch {}
      reject(error);
    });
  });
}
