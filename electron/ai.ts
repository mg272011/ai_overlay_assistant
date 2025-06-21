import { Agent } from "@openai/agents";

export const scriptsAgent = new Agent({
  name: "Scripts Agent",
  instructions:
    "Make an apple automation script that does the following task, given the screenshot. Use cliclick for "
});
