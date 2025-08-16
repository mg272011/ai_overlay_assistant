import chrome from './ChromeDevtoolsService';
import { performAction } from '../../performAction';

// Parse flight commands to extract origin and destination
function parseFlightCommand(command: string): { origin: string; destination: string } {
  // Common patterns for flight searches
  const patterns = [
    // "flight from Toronto to San Francisco"
    /(?:flight|flights?)\s+from\s+([^to]+?)\s+to\s+(.+)/i,
    // "Toronto to San Francisco flight"
    /([^to]+?)\s+to\s+([^flight]+?)(?:\s+flight)/i,
    // "find flights Toronto San Francisco"
    /(?:find\s+)?(?:flight|flights?)\s+([a-zA-Z\s]+?)\s+([a-zA-Z\s]+?)(?:\s|$)/i,
    // "Toronto SF" or "Toronto San Francisco"
    /^([a-zA-Z\s]+?)\s+(?:to\s+)?([a-zA-Z\s]+?)$/i,
  ];
  
  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match) {
      const origin = match[1].trim();
      const destination = match[2].trim();
      
      // Skip if either is empty or contains common flight keywords
      if (origin && destination && 
          !/(flight|flights?|find|search|book)/i.test(origin) &&
          !/(flight|flights?|find|search|book)/i.test(destination)) {
        return { origin, destination };
      }
    }
  }
  
  // Fallback to Toronto -> San Francisco if parsing fails
  console.log(`[Flight Parser] Could not parse "${command}", using Toronto -> San Francisco`);
  return { origin: 'Toronto', destination: 'San Francisco' };
}

export type ChromeAction =
  | { type: 'navigate'; url: string; description?: string }
  | { type: 'waitForSelector'; selector: string; timeoutMs?: number; description?: string }
  | { type: 'click'; selector: string; description?: string }
  | { type: 'type'; selector: string; value: string; description?: string }
  | { type: 'pressEnter'; description?: string }
  | { type: 'key'; combo: string; description?: string }
  | { type: 'openApp'; appName: string; description?: string };

export type ActionPlan = {
  id: string;
  title: string;
  steps: ChromeAction[];
};

export function buildActionPlanFromCommand(command: string): ActionPlan {
  const lower = command.toLowerCase();
  const id = `plan-${Date.now()}`;

  // Parse flight search requests
  if (/(flight|flights)/.test(lower)) {
    // Extract origin and destination from the command
    const { origin, destination } = parseFlightCommand(command);
    
    return {
      id,
      title: `Search flights from ${origin} to ${destination}`,
      steps: [
        { type: 'navigate', url: 'https://www.google.com/travel/flights', description: 'Open Google Flights' },
        { type: 'waitForSelector', selector: 'input[aria-label="Where from?"]', description: 'Wait for From field' },
        { type: 'click', selector: 'input[aria-label="Where from?"]', description: 'Focus From field' },
        { type: 'type', selector: 'input[aria-label="Where from?"]', value: origin, description: `Type origin: ${origin}` },
        { type: 'pressEnter', description: 'Confirm origin' },
        { type: 'click', selector: 'input[aria-label="Where to?"]', description: 'Focus To field' },
        { type: 'type', selector: 'input[aria-label="Where to?"]', value: destination, description: `Type destination: ${destination}` },
        { type: 'pressEnter', description: 'Confirm destination' },
      ],
    };
  }

  // "open X" → open applications
  const openMatch = command.match(/^open\s+(.+)/i);
  if (openMatch) {
    const apps = openMatch[1];
    const steps: ChromeAction[] = [];
    
    // Parse applications from the command
    const appList = apps.split(/\s+and\s+|\s*,\s*|\s+/).filter(app => app.trim());
    
    for (const app of appList) {
      const appName = app.trim().toLowerCase();
      if (appName === 'chrome' || appName === 'google chrome') {
        // Chrome is already being opened by the nanobrowser system
        steps.push({ type: 'navigate', url: 'chrome://newtab/', description: 'Open Chrome new tab' });
      } else if (appName === 'opus') {
        steps.push({ type: 'openApp', appName: 'Opus', description: 'Open Opus application' });
      } else {
        // Generic app opening - capitalize first letter for proper app name
        const properAppName = app.trim().charAt(0).toUpperCase() + app.trim().slice(1).toLowerCase();
        steps.push({ type: 'openApp', appName: properAppName, description: `Open ${properAppName} application` });
      }
    }
    
    return {
      id,
      title: `Open ${apps}`,
      steps,
    };
  }

  // "search for X" → search Google
  const searchMatch = command.match(/^search(?:\s+for)?\s+(.+)/i);
  if (searchMatch) {
    const q = searchMatch[1];
    return {
      id,
      title: `Search Google for ${q}`,
      steps: [
        { type: 'navigate', url: 'https://www.google.com', description: 'Open Google' },
        { type: 'waitForSelector', selector: 'input[name=q]', description: 'Wait for search box' },
        { type: 'click', selector: 'input[name=q]', description: 'Focus search box' },
        { type: 'type', selector: 'input[name=q]', value: q, description: `Type query: ${q}` },
        { type: 'pressEnter', description: 'Search' },
      ],
    };
  }

  // Fallback: direct URL search
  return {
    id,
    title: 'Open search results',
    steps: [
      { type: 'navigate', url: `https://www.google.com/search?q=${encodeURIComponent(command)}`, description: 'Open Google results' },
    ],
  };
}

export async function executeActionPlan(plan: ActionPlan, event: any, channel = 'chrome-agent:progress'): Promise<void> {
  const send = (payload: any) => event.reply(channel, payload);
  send({ type: 'plan', plan: { id: plan.id, title: plan.title, steps: plan.steps.map(s => ({ type: s.type, description: (s as any).description })) } });

  let chromeInitialized = false;

  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      send({ type: 'step_start', index: i, step });
      try {
        if (step.type === 'navigate') {
          await chrome.navigate(step.url);
          chromeInitialized = true; // Mark that Chrome is working
        } else if (step.type === 'waitForSelector') {
          await chrome.waitForSelector(step.selector, step.timeoutMs || 10000);
        } else if (step.type === 'click') {
          await chrome.click(step.selector);
        } else if (step.type === 'type') {
          await chrome.type(step.selector, step.value);
        } else if (step.type === 'pressEnter') {
          await chrome.pressEnter();
        } else if (step.type === 'key') {
          await performAction(`=Key\n${step.combo}`, 'com.google.Chrome', [], event);
        } else if (step.type === 'openApp') {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execPromise = promisify(exec);
          await execPromise(`open -a "${(step as any).appName}"`);
        }
        send({ type: 'step_success', index: i });
      } catch (err) {
        console.error('[Executor] Step failed:', i, String(err));
        send({ type: 'step_error', index: i, error: String(err) });
        
        // If Chrome failed to initialize and we're in fullscreen, exit fullscreen
        if (!chromeInitialized && i === 0) {
          console.log('[Executor] Chrome failed to initialize, attempting to exit fullscreen mode...');
          try {
            const runAppleScript = (await import('../../tools/appleScript')).default;
            await runAppleScript(`
              tell application "System Events" 
                -- Try to exit fullscreen for any app that might be fullscreen
                keystroke "f" using {command down, shift down}
                delay 0.3
                -- Also try escape key to exit fullscreen
                key code 53
              end tell
            `);
            console.log('[Executor] ✅ Attempted to exit fullscreen mode');
          } catch (recoverError) {
            console.error('[Executor] ❌ Failed to exit fullscreen mode:', recoverError);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('[Executor] Action plan execution failed:', err);
    send({ type: 'plan_error', error: String(err) });
  }

  send({ type: 'done', planId: plan.id });
} 