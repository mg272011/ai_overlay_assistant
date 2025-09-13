import { execPromise } from "../utils/utils";

export interface SearchBrowserReturnType {
  type: "search";
  query: string;
  error: string;
}

export async function searchOnBrowser(query: string): Promise<SearchBrowserReturnType> {
  try {
    // Command+L to focus address bar
    await execPromise(`osascript -e 'tell application "System Events" to keystroke "l" using {command down}'`);
    
    // Small delay to ensure address bar is focused
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Clear existing text with Command+A then type the search query
    await execPromise(`osascript -e 'tell application "System Events" to keystroke "a" using {command down}'`);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Type the search query
    const escapedQuery = query.replace(/'/g, "\\'").replace(/"/g, '\\"');
    await execPromise(`osascript -e 'tell application "System Events" to keystroke "${escapedQuery}"'`);
    
    // Small delay before pressing Return
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Press Return to search
    await execPromise(`osascript -e 'tell application "System Events" to key code 36'`); // 36 is Return key
    
    return { type: "search", query, error: "" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { type: "search", query, error: errorMessage };
  }
} 