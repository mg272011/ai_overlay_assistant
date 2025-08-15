import { execPromise, logWithElapsed } from "./utils";
import * as fs from "node:fs";
import * as path from "node:path";
import os from "node:os";

let cachedAppNames: string[] | null = null;

function normalize(text: string): string {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function scanApplications(): string[] {
  if (cachedAppNames) return cachedAppNames;
  const roots = [
    "/Applications",
    "/System/Applications",
    path.join(os.homedir(), "Applications"),
  ];
  const results: Set<string> = new Set();

  const visit = (dir: string, depth: number = 0) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name.endsWith(".app")) {
        const display = e.name.replace(/\.app$/i, "");
        results.add(display);
      } else if (e.isDirectory()) {
        visit(full, depth + 1);
      }
    }
  };

  for (const r of roots) visit(r, 0);
  cachedAppNames = Array.from(results.values());
  return cachedAppNames;
}

export async function getAppName(userPrompt: string) {
  logWithElapsed(
    "getAppName",
    `Start getAppName with userPrompt: ${userPrompt}`
  );

  // 1) Respect explicit app mentions first (deterministic mapping)
  const text = (userPrompt || "").toLowerCase();
  const explicitMap: Array<{ pattern: RegExp; app: string }> = [
    { pattern: /\bgoogle\s*chrome\b|\bchrome\b/, app: "Google Chrome" },
    { pattern: /\bsafari\b/, app: "Safari" },
    { pattern: /\bfirefox\b/, app: "Firefox" },
    { pattern: /\barc\b/, app: "Arc" },
    { pattern: /\bedge\b|\bmicrosoft\s*edge\b/, app: "Microsoft Edge" },
    { pattern: /\bbrave\b/, app: "Brave Browser" },
    { pattern: /\bopera\b/, app: "Opera" },
  ];
  for (const { pattern, app } of explicitMap) {
    if (pattern.test(text)) {
      logWithElapsed("getAppName", `Explicit app mention detected → ${app}`);
      return app;
    }
  }

  // 2) Try to match ANY installed app deterministically
  try {
    const installed = scanApplications();
    const nPrompt = normalize(userPrompt);

    // Find the longest matching installed app name inside the prompt
    let best: { app: string; score: number } | null = null;
    for (const app of installed) {
      const nApp = normalize(app);
      if (!nApp || nApp.length < 3) continue;
      if (nPrompt.includes(nApp)) {
        const score = nApp.length; // prefer longer (more specific) names
        if (!best || score > best.score) best = { app, score };
      }
    }
    if (best) {
      logWithElapsed("getAppName", `Matched installed app → ${best.app}`);
      return best.app;
    }
  } catch (e) {
    // Non-fatal; will fall back to undefined
  }

  // 3) No agent fallback - return undefined for unrecognized requests
  logWithElapsed("getAppName", "No app match found - agent functionality removed");
  return undefined;
}

export async function getBundleId(appName: string) {
  logWithElapsed("getBundleId", `Getting bundle id for app: ${appName}`);
  const { stdout } = await execPromise(`osascript -e 'id of app "${appName}"'`);
  logWithElapsed("getBundleId", `Bundle id result: ${stdout.trim()}`);
  return stdout.trim();
}
