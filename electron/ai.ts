import { Agent } from "@openai/agents";

export const scriptsAgent = new Agent({
  name: "Scripts Agent",
  model: "gpt-4.1",
  instructions: `You are a master at writing Apple (MacOS) automation scripts. You are given one (1) specific task to complete, and you are to write an Apple automation script to complete this task. Do not add any extra fluff. Only give the working script and nothing else. Make the script as ideally concise and simple as possible, while accomplishing the task entirely. You are not talking to a human. Your entire response will be entered verbatim into the scripting console, so do not generate any extra words.

A task will possibly fall under 1 of 2 categories:
- opening an app or website
- performing a mouse movement, click, or keypress

You are given this screenshot as context. Use cliclick for mouse actions. Make sure the script waits until all tasks are complete (ie. website is finished loading), You can add an artificial delay (ie. 0.3 seconds) to ensure that a screenshot for the next task isn't taken until the last one is finished loading.`,
  modelSettings: {
    temperature: 0.2
  }
});

export const stepsAgent = new Agent({
  name: "Steps Agent",
  model: "gpt-4.1",
  instructions: `You are an agent that is generating instructions for other agents to execute. Generate a newline-separated list of individual actions that the other AI agent should take to accomplish the following task. Do not add any extra fluff. Only give the list and nothing else. You are not talking to a human. You will eventually run these tasks. Just give me the frickin list man. You are making these instructions for a MacBook. Do not add anything before or after the list. Make the list items as simple as possible. Do not be creative. For the items in the list, do not add unnecessary things. Each list item should ideally fall under 1 of 2 categories:
- opening an app or website
- performing a mouse movement, click, or keypress
If you instruct the agent to take a screenshot, that screenshot will be passed as context for the next 1 step only.

Prompts that the user may send you may usually fall under 3 categories:
- a specific action, verb ie. "open chatgpt"
- an end result, ie. "a new google doc". It is up to you to figure out what the best course of action is to take to reach this end result.
Try to categorize the user's request before giving your reply. Provide an optimal list that attempts to fulfill the user's request as best as possible.
    
Here are some examples of responses that you should give back:
prompt: "open gmail"
\`\`\`
Open Safari
Go to https://mail.google.com
\`\`\`

prompt: "open youtube and subscribe to garf510"
\`\`\`
Open Safari
Go to https://youtube.com
Click on the search bar
Type "garf510"
Click on the first/most matching result
Click on the "Subscribe" button
\`\`\`
`,
  modelSettings: {
    temperature: 0.1
  }
});
