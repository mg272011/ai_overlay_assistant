import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export interface TaskStep {
  action: 'navigate' | 'search' | 'click' | 'analyze' | 'extract' | 'compare';
  description: string;
  details: string;
  website?: string;
  query?: string;
  reasoning: string;
}

export interface IntelligentPlan {
  task: string;
  approach: string;
  websites: string[];
  steps: TaskStep[];
  expectedOutcome: string;
}

export class IntelligentPlannerService {
  
  async createTaskPlan(userTask: string): Promise<IntelligentPlan> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `You are an expert web automation strategist. Create a smart plan for this task:

TASK: "${userTask}"

Analyze the task and create an intelligent multi-step plan. Consider:
- What websites would be most helpful?
- What information needs to be gathered?
- What comparisons or analysis should be done?
- How to get the best results for the user?

Respond with a JSON plan:
{
  "task": "Clear restatement of the task",
  "approach": "Your strategic approach and reasoning",
  "websites": ["list", "of", "relevant", "websites"],
  "steps": [
    {
      "action": "navigate|search|click|analyze|extract|compare",
      "description": "What this step accomplishes",
      "details": "Specific details about how to execute this step",
      "website": "Which website if applicable",
      "query": "Search query if applicable", 
      "reasoning": "Why this step is important"
    }
  ],
  "expectedOutcome": "What the user should expect to get from this plan"
}

EXAMPLES:

For "find me a hotel in Paris":
- Navigate to multiple hotel booking sites
- Search for hotels in Paris with good ratings
- Compare prices and amenities
- Extract top 3-5 options with details
- Provide summary with recommendations

For "search for software engineer jobs in Toronto":
- Use LinkedIn, Indeed, and other job sites
- Search with relevant keywords
- Filter by location and experience level
- Extract job details, companies, salaries
- Summarize opportunities and application tips

Create a comprehensive plan that gets the best results:`;

    try {
      const result = await model.generateContent(prompt);
      const response = result.response.text();
      
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in planner response');
      }
      
      const plan = JSON.parse(jsonMatch[0]);
      console.log('[IntelligentPlanner] Created plan:', plan);
      return plan;
      
    } catch (error) {
      console.error('[IntelligentPlanner] Planning failed:', error);
      
      // Create a basic fallback plan
      return {
        task: userTask,
        approach: "Search and analyze approach due to planning system error",
        websites: ["google.com"],
        steps: [
          {
            action: "navigate",
            description: "Search for information about the task",
            details: "Use Google to find relevant information",
            website: "google.com",
            query: userTask,
            reasoning: "Start with a broad search to understand available options"
          },
          {
            action: "analyze", 
            description: "Review search results",
            details: "Look at the top results to find the most relevant websites",
            reasoning: "Identify the best sources for this type of task"
          },
          {
            action: "extract",
            description: "Gather key information",
            details: "Extract the most important details from the results",
            reasoning: "Provide useful information to the user"
          }
        ],
        expectedOutcome: "Basic information and next steps for the task"
      };
    }
  }

  async createContextualAction(currentUrl: string, pageContent: string, userGoal: string): Promise<TaskStep> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `You are analyzing a webpage to determine the next best action.

CURRENT URL: ${currentUrl}
USER GOAL: ${userGoal}
PAGE CONTENT: ${pageContent.substring(0, 2000)}

Based on the current page content and the user's goal, what should be the next action?

Respond with JSON:
{
  "action": "navigate|search|click|analyze|extract|compare",
  "description": "What this action will accomplish",
  "details": "Specific instructions for execution",
  "reasoning": "Why this is the best next step"
}`;

    try {
      const result = await model.generateContent(prompt);
      const response = result.response.text();
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in action response');
      }
      
      return JSON.parse(jsonMatch[0]);
      
    } catch (error) {
      console.error('[IntelligentPlanner] Contextual action failed:', error);
      
      return {
        action: "analyze",
        description: "Analyze current page",
        details: "Review the current page content and determine next steps",
        reasoning: "Fallback action due to planning error"
      };
    }
  }

  async extractPageInsights(pageContent: string, taskContext: string): Promise<string> {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    const prompt = `Extract key insights from this webpage content.

TASK CONTEXT: ${taskContext}
PAGE CONTENT: ${pageContent.substring(0, 3000)}

What are the most important findings related to the user's task? 
Provide a clear, organized summary of useful information.`;

    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error('[IntelligentPlanner] Extraction failed:', error);
      return "Unable to extract insights from this page.";
    }
  }
} 