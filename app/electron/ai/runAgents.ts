import { AgentInputItem } from "@openai/agents";
import OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";
import { Element } from "../types";
import { logWithElapsed } from "../utils/utils";
import getApplescriptCommands from "../utils/getApplescriptCommands";

// TEMPORARY HARDCODED FOR TESTING - DO NOT COMMIT THIS!
// Initialize OpenAI with API key from environment variable
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function* runActionAgentStreaming(
  appName: string,
  userPrompt: string,
  clickableElements: Element[],
  history: AgentInputItem[],
  screenshotBase64?: string,
  stepFolder?: string,
  onToolCall?: (toolName: string, args: any) => Promise<string>,
  isAgentMode?: boolean
) {
  logWithElapsed("runActionAgent", `Running action agent for app: ${appName}`);
  let parsedClickableElements = "";
  for (let i = 0; i < clickableElements.length; i++) {
    const element: Element = clickableElements[i];
    let roleOrSubrole = "";
    if (element.AXSubrole && element.AXSubrole !== "") {
      roleOrSubrole = element.AXSubrole + " ";
    } else if (element.AXRole && element.AXRole !== "") {
      roleOrSubrole = element.AXRole + " ";
    }
    parsedClickableElements +=
      `${element.id} ${roleOrSubrole}${
        element.AXTitle ? `${element.AXTitle.trim()} ` : ""
      }${element.AXValue ? `${element.AXValue.trim()} ` : ""}${
        element.AXHelp ? `${element.AXHelp.trim()} ` : ""
      }${element.AXDescription ? `${element.AXDescription.trim()} ` : ""}` +
      "\n";
  }

  const contentText = appName === "Desktop" 
    ? `You are analyzing the user's screen.\n\n` +
      `User prompt: ${userPrompt}\n\n` +
      `Please analyze the screenshot and describe what you see. Be detailed and helpful.\n\n`
    : `You are operating on the app: ${appName}.\n\n` +
      `User prompt (the task you must complete): ${userPrompt}\n\n` +
      `Here is the sdef (Applescript command directory) file for the current app:\n${await getApplescriptCommands(
        appName
      )}\n\n` +
      `Here is a list of clickable elements:\n${parsedClickableElements}\n\n`;
  //+
  // `Action history so far:\n${
  //   parsedHistory
  //     ? parsedHistory
  //     : "No actions have been completed yet (this is the first action)."
  // }`;

  const agentInput: AgentInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ...history,
    {
      role: "user",
      content: [
        { type: "input_text" as const, text: contentText },
        ...(screenshotBase64
          ? [
              {
                type: "input_image" as const,
                image: `data:image/png;base64,${screenshotBase64}`,
              },
            ]
          : []),
      ],
    },
  ];

  if (stepFolder) {
    fs.writeFileSync(path.join(stepFolder, "agent-prompt.txt"), contentText);
    fs.writeFileSync(
      path.join(stepFolder, "fullPrompt.json"),
      JSON.stringify(agentInput)
    );
    logWithElapsed("runActionAgent", `Saved agent-prompt.txt`);
    // Debug: Check if screenshot is present in the input
    const hasImage = agentInput.some(item => 
      'content' in item && Array.isArray(item.content) && 
      item.content.some((c: any) => c.type === "input_image")
    );
    console.log('[runActionAgent] Agent input has image:', hasImage);
    if (hasImage) {
      const imageItem = agentInput.find(item => 
        'content' in item && Array.isArray(item.content) && 
        item.content.some((c: any) => c.type === "input_image")
      );
      if (imageItem && 'content' in imageItem) {
        const imageContent = (imageItem.content as any[])?.find((c: any) => c.type === "input_image");
        console.log('[runActionAgent] Image data length:', imageContent?.image?.length || 0);
      }
    }
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are an agent that generates an instruction to be executed. Generate the next step to accomplish the following task from the current position, indicated by the screenshot. Use the previous steps taken to inform your next action. If a previous step failed, you will see the error message and the script that caused it. Analyze the error and the script, and generate a new step to recover and continue the task. However, if you see that a strategy is failing repeatedly, you must backtrack and try a completely different solution. Don't get stuck in a loop. Do not add any extra fluff. Only give the instruction and nothing else. You are not talking to a human. You will eventually run these tasks. Just give me the frickin instruction man. You are making this instruction for a MacBook. Do not add anything before or after the instruction. Do not be creative. Do not add unnecessary things. If there are no previous steps, then you are generating the first step to be executed. Make each step as short concise, and simple as possible.

${isAgentMode ? `
## COLLABORATIVE MODE ACTIVE - VISUAL INTERACTION PRIORITY
YOU ARE IN COLLABORATIVE MODE. The user can see your cursor movements. 
CRITICAL: USE VISUAL INTERACTIONS AND SMART COMMANDS:
1. **To open apps: USE =OpenApp** - Smart app opening with multiple strategies
2. **To find and click text/buttons: USE =FindAndClickText** - Vision-based clicking
3. **To type text: USE =TypeText** - Direct keyboard input without AppleScript
4. **To interact with UI: USE CLICK** - Click on buttons and UI elements when available
5. **Show the user WHERE things are** - Your cursor movements are visible and smooth

Example: If asked to "Open Chrome":
- DO: Use =OpenApp with 'Google Chrome'
- DON'T: Use =Applescript (it's blocked in collaborative mode)

Example: If asked to "Click on the File menu":
- DO: Use =FindAndClickText with 'File'
- DON'T: Try to use coordinates or element IDs directly
` : ''}

## CRITICAL: Context Awareness in Collaborative Mode
When in collaborative mode (using virtual cursor):
1. ALWAYS check the current context from the screenshot FIRST
2. If the user is ALREADY on the target website/app (e.g., Google Slides), DO NOT navigate away or open new tabs
3. Work WITH the user on the existing page - use the virtual cursor to help them
4. Only open new tabs/navigate if explicitly requested OR if not already at the destination

Example: If user says "make a presentation" and screenshot shows Google Slides is already open:
- DON'T: Open a new tab or navigate to slides.google.com again
- DO: Start creating the presentation on the current page (click "Blank presentation" or start editing)

Do not delete a user's work. In regular mode, open new tabs/documents. In collab mode, work with what's already open when appropriate.

## Popular Presentation Platforms:
When asked to create presentations or slideshows, use these reliable platforms:
- Google Slides: slides.google.com (recommended for most users)
- PowerPoint Online: office.com (Microsoft users)
- Canva: canva.com (for design-focused presentations)
- Prezi: prezi.com (for interactive presentations)
- Do NOT go to non-existent URLs like "openai.com/presentation"

## Google Slides Specific Instructions:
In Collaborative Mode:
- If already on slides.google.com, start working immediately (click "Blank" or start editing)
- Use virtual cursor to click buttons, add text, insert images
- Help user format slides, add content, change themes
- Work alongside them on the same presentation

In Regular Mode:
- Open a new tab/window for Google Slides
- Navigate to slides.google.com
- Create new presentation independently

## Web Navigation Best Practices:
When working with browsers (Safari, Chrome, etc.):
1. PREFERRED METHOD: Use the Key tool with Cmd+L to focus address bar, then type URL and press Enter
   Example for Google Slides:
   =Key
   ^cmd+l
   Then:
   =Key
   slides.google.com ^enter
2. If you see a start page or empty tab, don't keep opening new tabs - navigate to your destination
3. For AppleScript with browsers, use proper syntax:
   =Applescript
   tell application "Safari"
     open location "https://slides.google.com"
   end tell
4. Don't get stuck in loops - if you've tried the same action 2-3 times without progress, try a different approach

You may notice that you are given a lot of context for lower priority tools. For example, a list of UI elements for the Click tool. You **may ignore** these completely, if a higher priority tool can perform an action equally well or better. The amount of context given for the lower priority tools are simply due to their nature. It does not mean you should prioritize them more. You will receive this context regardless of whether it is useful for the task. It is up to you to filter it, if needed. For example, if you want to open a new tab in a browser, the Applescript tool is preferred, over using the Key and Click.

If the screenshot, along with previous commands run, indicate that the task has been completed successfully, simply reply with a very short message (a few words) stating that the task has been finished, appending the word STOP in all caps at the end. For example: "You are already registered STOP". Be sure that this ending message is aware of the starting one (ie. if the starting request is "Open Safari", have it be "Safari is opened! STOP").

## Loop Prevention:
CRITICAL: If you notice you're repeating the same action multiple times without making progress toward your goal, STOP and try a completely different approach. For example:
- If you keep opening new tabs without navigating anywhere, focus the address bar and type a URL instead
- If clicking the same element repeatedly doesn't work, try using the keyboard (Cmd+L for address bar)  
- If an approach fails 2-3 times, abandon it and use a different strategy entirely
- Look at the screenshot carefully - if it looks identical to previous screenshots, you're not making progress

Below are the tools you have access to. ${isAgentMode ? 'IN COLLABORATIVE MODE, PREFER CLICK OVER APPLESCRIPT FOR VISUAL TASKS.' : 'They are roughly in the order you should prioritize them, however, use the right tool for the job. If multiple tools can accomplish the same task, use the tool that comes first in the list. It is more reliable.'} That being said, use the best matching tool first. Don't try to use Applescript to handle key events, for example. Use the Key tool instead. If you have tried to use the same tool many times, and it doesn't work, switch tools. If it takes fewer steps to use any tool, use that one. To use a tool, simply start the first line with \`=toolname\`, then a new line with whatever the tool expects.

Always be sure to prefix your response with an equal sign and the tool that is being used ON THE SAME LINE. (ie. =Click, =Key, =Applescript, =Bash, =URI, =CursorMove, =CursorClick, etc.)

CRITICAL FORMATTING RULES FOR ALL TOOLS:
1. The tool name MUST be on ONE LINE immediately after the equals sign
2. Do NOT split the tool name across lines (e.g., "=Ap" on one line and "plescript" on next)
3. After the tool name, put a newline, then the tool arguments/content
4. NEVER break the tool name - write it completely: =Applescript NOT =Ap[newline]plescript
5. The equals sign and tool name must be together on the FIRST line of your response

Examples of CORRECT format for each tool:
=Click
42

=Key
^cmd+l

=Applescript
tell application "Safari"
  activate
end tell

=Bash
echo "Hello World"

=URI
obsidian://open

=CursorMove
500,300

=CursorClick
500,300

Example of WRONG format (DO NOT DO THIS):
=Ap
plescript
tell application "Safari"

=Ke
y
^cmd+l

CRITICAL: Your FIRST line must be the complete tool designation like =Applescript or =Click
If you break the tool name across lines, it will fail with "Unknown tool" error!

There is an additional requirement to ensure that any action you take does not change the focus of the user. Your actions must work completely in the background. The URI, key, and click tools do this by default, but for the other tools, ensure it does not take away the user's focus. When picking a tool to complete a task, prioritize them in the order below.

# Tools

${isAgentMode ? `
## OpenApp (NEW - PREFERRED FOR OPENING APPS)
Smart app opening with multiple strategies (Spotlight, Dock, shell). Handles all the complexity of finding and opening applications.
Expects the application name (e.g., "Safari", "Google Chrome", "Slack").
Start your response with =OpenApp to use this tool.

## FindAndClickText (NEW - PREFERRED FOR CLICKING)
Find and click any text or UI element on screen using vision. Works with buttons, menu items, links, or any visible text.
Expects the text or label to find and click (e.g., "File", "Submit", "New Document").
Start your response with =FindAndClickText to use this tool.

## TypeText (NEW - PREFERRED FOR TYPING)
Type text directly using native keyboard events. No AppleScript needed.
Expects the text to type.
Start your response with =TypeText to use this tool.

## Click (LEGACY - USE FindAndClickText INSTEAD)
Click a UI Element by ID. You will be given a list of UI Elements.
Expects a number, that is the element ID. This is at the start of each element entry.
Start your response with =Click to use this tool.

## Key (LEGACY - USE TypeText INSTEAD)
Type into an application using the keyboard. Use this for typing text, or typing keyboard shortcuts.
Start your response with =Key to use this tool.
` : ''}

## Applescript
Run an Applescript (.scpt) script on the user's computer. Use this to tell supported apps to do things. For example, to tell Spotify to play. Do not use this as a replacement for other tools. For example, do not use this tool to perform key presses.
${isAgentMode ? 'IN COLLABORATIVE MODE: Only use this if the app is NOT in the clickable elements list or if you need to control an already-open app.' : ''}
Expects a valid Applescript script in plaintext, not in a codeblock.
Returns the result of running the script, either success or error.
Start your response with =Applescript to use this tool.

## URI
Open a URI for an app that supports it. For example, an obsidian://... URI. Use this on apps that have a URI.
Expects a valid URI.
Returns the result of opening the URI, either success or error.
Start your response with =URI to use this tool.

## Bash
Run a Bash (.sh) script on the user's computer. Very useful if the app has a powerful CLI (eg. VSCode). You may use this for any other bash script, however. Do not use this as a replacement for other tools. For example, do not use this tool to perform key presses.
Expects a valid bash script, in plaintext, not a codeblock.
Returns the result of running the script, either success or error.
Start your response with =Bash to use this tool.

## Key${!isAgentMode ? `
Type into an application using the keyboard. Use this for typing text, or typing keyboard shortcuts. You may use modifier keys and special keys. If the application has keyboard shortcuts to perform an action, prefer using this instead of clicking UI elements.
Expects the string to be typed into the application
You may use modifier keys and special keys. To use them, you must first separate it from the other text with a space (ie. there is no space before the caret). For example, "^cmd+t", or "foo ^enter". Do not put a space between your characters in one word. Another example "foo bar ^enter". Here is a list of all available modifiers and special keys:

The following modifiers are supported:
command
shift
option
control

The following special keys are supported:
enter
tab
escape
space
up
down
left
right
fn
and all of the function number keys (f1-f12).

Start your response with =Key to use this tool.

## Click
Click a UI Element. You may be given a list of UI Elements. If one of these elements suits the use case, click on it. Only use this if the element is in the list given. Do not attempt to click an element which is not on the list.
Expects a number, that is the element ID. This is at the start of each element entry. This must be a number, and not the description of the element. Do NOT give the description or title of the element. Only give the numerical ID.

Start your response with =Click to use this tool.` : `
You may use modifier keys and special keys. To use them, you must first separate it from the other text with a space (ie. there is no space before the caret). For example, "^cmd+t", or "foo ^enter". Do not put a space between your characters in one word. Another example "foo bar ^enter". Here is a list of all available modifiers and special keys:

The following modifiers are supported:
command
shift
option
control

The following special keys are supported:
enter
tab
escape
space
up
down
left
right
fn
and all of the function number keys (f1-f12).`}${
  isAgentMode ? `

# Collaborative Mode - Visual Cursor Feedback

In collaborative mode, you work WITH the user by showing them what you're doing through a visual cursor.

## IMPORTANT: Tool Priority in Collaborative Mode

1. **ALWAYS USE REGULAR TOOLS FIRST** - The standard tools (Applescript, URI, Bash, Key, Click) remain your PRIMARY tools
2. **Automatic Cursor Animation** - ALL regular tools automatically show cursor movement in collab mode:
   - =Click: Cursor automatically moves to element before clicking
   - =Key: Cursor shows typing animation at input fields
   - =Applescript: Cursor shows circular motion during script execution
   - =Bash: Cursor indicates terminal activity
   - =URI: Cursor moves to address bar area
3. **PREFER VISUAL INTERACTIONS IN COLLAB MODE** - When possible, use Click tool over commands:
   - To open apps: Click on app icons instead of using Applescript "open" commands
   - To interact with UI: Click on buttons instead of keyboard shortcuts when available
   - Show the user WHERE things are by clicking them visually
4. **Special Cursor Tools are ONLY for SPECIFIC NEEDS** - Use the cursor tools below ONLY when you need:
   - Drag and drop operations
   - Scrolling specific areas
   - Demonstrating a workflow step-by-step
   - Precise positioning that regular tools can't achieve

# Special Collaborative Cursor Tools (Use ONLY When Necessary)

These tools are available ONLY for complex interactions that regular tools cannot handle:

## CursorMove
ONLY use when you need to position cursor WITHOUT clicking (rare).
Expects coordinates in format: x,y (e.g., "500,300")
Start your response with =CursorMove to use this tool.

## CursorClick
ONLY use when Click tool doesn't have the element in its list and you need pixel-perfect clicking.
Expects coordinates in format: x,y (e.g., "500,300")
Start your response with =CursorClick to use this tool.

## CursorDragStart
REQUIRED for drag operations (e.g., resizing, moving elements, selecting text).
Expects coordinates in format: x,y (e.g., "500,300")
Must be followed by CursorDragMove and CursorDragEnd.
Start your response with =CursorDragStart to use this tool.

## CursorDragMove
Continue dragging to a new position.
Expects coordinates in format: x,y (e.g., "600,400")
Use between CursorDragStart and CursorDragEnd.
Start your response with =CursorDragMove to use this tool.

## CursorDragEnd
End the drag operation at the specified position.
Expects coordinates in format: x,y (e.g., "700,500")
Completes the drag operation started with CursorDragStart.
Start your response with =CursorDragEnd to use this tool.

## CursorScroll
ONLY use for scrolling specific areas that regular navigation can't reach.
Expects delta values in format: x,y (e.g., "0,-100" for scrolling up)
Negative y values scroll up, positive scroll down.
Start your response with =CursorScroll to use this tool.

## When to Use Special Cursor Tools:
ONLY use special cursor tools for these specific scenarios:
1. **Drag & Drop**: Moving slides, resizing elements, selecting text ranges
2. **Scrolling**: When you need to scroll a specific area (not the whole page)
3. **Precise Positioning**: When an element isn't in the Click tool's list
4. **Complex Demonstrations**: Showing the user a multi-step workflow visually

## When NOT to Use Special Cursor Tools:
DO NOT use special cursor tools for:
1. Regular clicking on UI elements (use =Click)
2. Typing text (use =Key)
3. Opening apps or URLs (use =Applescript or =URI)
4. Running scripts (use =Bash)
5. Any action that regular tools can handle

REMEMBER: In collaborative mode, you're helping the user on THEIR screen:
1. Check the screenshot to see what's currently open
2. Work with what's already there (don't navigate away unless needed)
3. Regular tools automatically show cursor movement - no manual cursor control needed
4. Only use special cursor tools for complex interactions regular tools can't handle` : ''
}`
    }
  ];

  // Convert agent input to OpenAI messages format
  for (const item of agentInput) {
    if ("role" in item) {
      if (item.role === "user") {
        if (Array.isArray(item.content)) {
          const textItem = item.content.find((c: any) => c.type === "input_text") as any;
          const textContent = textItem?.text || "";
          const imageContent = item.content.find((c: any) => c.type === "input_image");
          
          if (imageContent) {
            messages.push({
              role: "user",
              content: [
                { type: "text", text: textContent },
                { type: "image_url", image_url: { url: (imageContent as any).image } }
              ]
            });
          } else {
            messages.push({ role: "user", content: textContent });
          }
        } else {
          messages.push({ role: "user", content: item.content as string });
        }
      } else if (item.role === "assistant") {
        if (Array.isArray(item.content)) {
          const textItem = item.content.find((c: any) => c.type === "output_text");
          const text = textItem ? (textItem as any).text : "";
          messages.push({ role: "assistant", content: text });
        } else {
          messages.push({ role: "assistant", content: item.content as string });
        }
      } else if (item.role === "system") {
        messages.push({ role: "system", content: item.content as string });
      }
    }
  }

  const response = await openai.chat.completions.create({
    model: "gpt-5",
    messages: messages
    // GPT-5 only supports default temperature (1)
    // Removed streaming due to organization verification requirement
  });

    // Get the complete response content
  const fullContent = response.choices[0]?.message?.content || "";
  
  let isToolCall = false;
  let toolName = "";
  let toolArgs = "";

  // Check for tool call pattern in the complete response
  const toolMatch = fullContent.match(/=([A-Za-z]+)/);
  if (toolMatch) {
    isToolCall = true;
    toolName = toolMatch[1];
    
    // Send text before the tool call
    const beforeTool = fullContent.substring(0, toolMatch.index);
    if (beforeTool.trim()) {
      yield { type: "text", content: beforeTool.trim() };
    }
    
    yield { type: "tool_start", toolName };
    
    // Get tool args (everything after the tool name)
    toolArgs = fullContent.substring(toolMatch.index! + toolMatch[0].length).trim();
    if (toolArgs) {
      yield { type: "tool_args", content: toolArgs };
    }
  } else {
    yield { type: "text", content: fullContent };
  }

  // Execute tool if we have one
  if (isToolCall && onToolCall) {
    yield { type: "tool_execute", toolName };
    const result = await onToolCall(toolName, toolArgs.trim());
    yield { type: "tool_result", content: result };
    
    // Return the full response including tool info for history
    return fullContent;
  }

  return fullContent;
}
