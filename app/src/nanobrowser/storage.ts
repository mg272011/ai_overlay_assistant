// Storage mock for nanobrowser components
// Replaces @extension/storage dependencies with Electron-compatible alternatives

export enum Actors {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  PLANNER = 'PLANNER',
  NAVIGATOR = 'NAVIGATOR',
  VALIDATOR = 'VALIDATOR',
}

export interface Message {
  actor: string;
  content: string;
  timestamp: number;
}

export interface FavoritePrompt {
  id: number;
  title: string;
  content: string;
  createdAt: number;
}

// Mock storage implementations
export const chatHistoryStore = {
  async createSession(title: string) {
    const id = `session_${Date.now()}`;
    const session = { id, title, createdAt: Date.now() };
    
    // Store in localStorage
    const sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
    sessions.push(session);
    localStorage.setItem('chat_sessions', JSON.stringify(sessions));
    
    return session;
  },

  async addMessage(sessionId: string, message: Message) {
    const messages = JSON.parse(localStorage.getItem(`messages_${sessionId}`) || '[]');
    messages.push(message);
    localStorage.setItem(`messages_${sessionId}`, JSON.stringify(messages));
  },

  async getSession(sessionId: string) {
    const sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
    const session = sessions.find((s: any) => s.id === sessionId);
    if (!session) return null;
    
    const messages = JSON.parse(localStorage.getItem(`messages_${sessionId}`) || '[]');
    return { ...session, messages };
  },

  async getSessionsMetadata() {
    return JSON.parse(localStorage.getItem('chat_sessions') || '[]');
  },

  async deleteSession(sessionId: string) {
    const sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
    const filtered = sessions.filter((s: any) => s.id !== sessionId);
    localStorage.setItem('chat_sessions', JSON.stringify(filtered));
    localStorage.removeItem(`messages_${sessionId}`);
  },

  async loadAgentStepHistory(_sessionId: string) {
    // Mock implementation - returns null for now
    return null;
  }
};

export const agentModelStore = {
  async getConfiguredAgents() {
    // Always return configured for Electron app
    return ['Navigator'];
  }
};

export const generalSettingsStore = {
  async getSettings() {
    return {
      replayHistoricalTasks: false
    };
  }
};

const favoritesStorage = {
  async getAllPrompts(): Promise<FavoritePrompt[]> {
    const prompts = localStorage.getItem('favorite_prompts');
    return prompts ? JSON.parse(prompts) : [];
  },

  async addPrompt(title: string, content: string): Promise<void> {
    const prompts = await this.getAllPrompts();
    const newPrompt: FavoritePrompt = {
      id: Date.now(),
      title,
      content,
      createdAt: Date.now()
    };
    prompts.push(newPrompt);
    localStorage.setItem('favorite_prompts', JSON.stringify(prompts));
  },

  async removePrompt(id: number): Promise<void> {
    const prompts = await this.getAllPrompts();
    const filtered = prompts.filter(p => p.id !== id);
    localStorage.setItem('favorite_prompts', JSON.stringify(filtered));
  },

  async updatePromptTitle(id: number, title: string): Promise<void> {
    const prompts = await this.getAllPrompts();
    const prompt = prompts.find(p => p.id === id);
    if (prompt) {
      prompt.title = title;
      localStorage.setItem('favorite_prompts', JSON.stringify(prompts));
    }
  },

  async reorderPrompts(draggedId: number, targetId: number): Promise<void> {
    const prompts = await this.getAllPrompts();
    const draggedIndex = prompts.findIndex(p => p.id === draggedId);
    const targetIndex = prompts.findIndex(p => p.id === targetId);
    
    if (draggedIndex !== -1 && targetIndex !== -1) {
      const [removed] = prompts.splice(draggedIndex, 1);
      prompts.splice(targetIndex, 0, removed);
      localStorage.setItem('favorite_prompts', JSON.stringify(prompts));
    }
  }
};

export default favoritesStorage; 