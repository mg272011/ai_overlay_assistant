import { EndSensitivity, GoogleGenAI, Modality, StartSensitivity } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set. Ensure it exists in .env file.');
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

interface LiveSession {
  sendRealtimeInput: (input: any) => void;
  close: () => void;
}

interface ChatChunk { text?: string; reset?: boolean }

// Meeting-focused system prompt from Clonely
const GEMINI_SYSTEM_PROMPT = `You are a real-time meeting assistant. Your primary job is to:
1. Listen to System Audio (Channel 1) for interview questions or meeting discussions
2. Suggest exact phrases the user should say in response
3. Help the user sound confident and knowledgeable in meetings/interviews

You respond only in plain text and must follow one of these formats:

1. If you are adding to your previous message because more of the user's question just arrived, begin your reply with:
<APPEND/>

2. If no help is needed, respond with exactly:
<NONE/>

3. For all other responses, reply normally — your text will be shown as a new message. DO NOT include any control tag.

---

### 🎧 Audio Input Labels

You receive two audio streams:
- **Microphone Audio (Channel 0)** — the user speaking (you hear this as raw audio)
- **System/Device Audio (Channel 1)** — interview questions, meeting participants, video calls, etc. (you receive this as text transcription)

**YOUR ROLE**: Listen to the System Audio for interview questions or meeting context, then suggest what the user should say in response. You are helping the user respond to questions asked by others in meetings/interviews.

---

### 💡 General Behavior

- Always speak in the **user's voice**, as if they are saying the words.
- **Never explain what a good answer would be** — just give the answer directly.
- Do not refer to the question itself — respond as though you're the user, answering it out loud.
- Prefer being helpful over staying silent, especially in interviews, problem-solving situations, or any work-related task.
- If the user's question arrives in parts, revise your response using <APPEND/>.

---

### ✅ Examples

**System Audio (Interviewer): "Why should we hire you?"**

✅ Good response (what you suggest the user should say):
I bring a strong mix of adaptability, technical expertise, and a consistent track record of delivering results under pressure. I'm confident I'll make an immediate impact here.

🚫 Bad response (don't explain how to answer):
A strong answer to "Why should we hire you?" would highlight your relevant skills and how they align with the job.

---

**System Audio (Interviewer): "What are your strengths and weaknesses?"**

✅ Good response (suggest this exact wording for the user):
One of my strengths is staying organized under pressure — I consistently hit deadlines.  
A weakness I've worked on is delegation — I used to try doing everything myself, but I've improved by trusting my team and focusing on communication.

---

### 🧠 Rules

- NEVER describe what a good answer would be.
- NEVER refer to the question itself — just give the user the answer they should say.
- ALWAYS speak in first-person, as the user.
- NEVER narrate what is happening.
- NEVER summarize unless explicitly asked.
- Use Markdown formatting.
- Use LaTeX for math and \`backticks\` for code.
- Never cut responses short — use <APPEND/> if needed.

Be helpful, confident, and specific. The user is likely under pressure — your job is to give them usable words, instantly.`;

export class GeminiLiveHelper {
  private session: LiveSession | null = null;
  private readonly modelName = 'gemini-2.0-flash-exp';
  private closePending = false;
  private turnJustCompleted = false;
  private apiKey: string;

  constructor() {
    this.apiKey = GEMINI_API_KEY;
    if (!this.apiKey) {
      console.error('GEMINI_API_KEY not found. Please set GEMINI_API_KEY in your .env file.');
    }
  }

  // Start a new live session. If an old one is still open, close it first so we start fresh.
  // Ensure `turnJustCompleted` is true so that the very first chunk we receive in a fresh session
  // is treated as the start of a new turn (UI reset).
  async startSession(onMessage: (chunk: ChatChunk) => void): Promise<void> {
    if (!this.apiKey) {
      console.error('Cannot start Gemini session: API Key is missing.');
      return Promise.reject(new Error('Gemini API Key is missing.'));
    }

    // Treat the upcoming first chunk as a new turn so downstream consumers get a reset flag.
    this.turnJustCompleted = true;
    if (this.session) {
      try {
        this.session.close();
      } catch (err) {
        console.warn('[GeminiLive] close previous session err', err);
      }
      this.session = null;
    }
    // If a session is already running, return early.
    // This check should be after closing potentially old sessions.
    if (this.session) return;

    let resolveConnection: () => void;
    let rejectConnection: (e: any) => void;
    const connectionPromise = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });

    const responseQueue: any[] = [];

    const waitMessage = async () => {
      while (responseQueue.length === 0) {
        await new Promise((res) => setTimeout(res, 50));
      }
      return responseQueue.shift();
    };

    const handleTurn = async () => {
      const turns: any[] = [];
      let done = false;
      while (!done) {
        const message = await waitMessage();
        turns.push(message);
        if (message?.serverContent?.turnComplete) {
          done = true;
        }
      }
      return turns;
    };

    console.log('[GeminiLive] 🚀 Attempting to connect to Gemini with model:', this.modelName);
    console.log('[GeminiLive] API Key length:', this.apiKey.length);
    
    this.session = (await genAI.live.connect({
      model: this.modelName,
      callbacks: {
        onopen: () => {
          console.log('[GeminiLive] ✅ Connection opened successfully');
          resolveConnection(); // Resolve the promise when connection opens
        },
        onmessage: (m) => {
          console.log('[GeminiLive] 📨 Received message:', m);
          responseQueue.push(m);
          const tText = (m as any).text;
          if (tText) {
            if (this.turnJustCompleted) {
              onMessage({ reset: true, text: tText });
              this.turnJustCompleted = false;
            } else {
              onMessage({ text: tText });
            }
          }
          if (m?.serverContent?.turnComplete) {
            this.turnJustCompleted = true;
            // Clear the response queue to prevent reprocessing old messages if the session somehow re-emits them
            while(responseQueue.length > 0) responseQueue.pop();
          }
          if (m?.serverContent?.turnComplete && this.closePending && this.session) {
            this.session.close();
            this.session = null;
            this.closePending = false;
          }
        },
        onerror: (e) => {
          console.error('[GeminiLive] error', e);
          rejectConnection(e); // Reject the promise on error
        },
        onclose: (e) => console.warn('[GeminiLive] closed', e.reason),
      },
      config: { 
        responseModalities: [Modality.TEXT], 
        systemInstruction: GEMINI_SYSTEM_PROMPT, 
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false, // default
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 10,
            silenceDurationMs: 5,
          }
        }
      }
    })) as unknown as LiveSession;

    // detach async listener to forward text
    (async () => {
      const turns = await handleTurn();
      for (const t of turns) {
        const text = (t as any).text;
        if (text) {
          onMessage({ text });
        }
      }
    })();

    return connectionPromise; // Return the promise that resolves on connection open
  }

  // Stream an audio chunk (called every ~250 ms)
  sendAudioChunk(chunk: Buffer): void {
    if (!this.session) {
      console.log('[GeminiLiveHelper] ❌ No session, cannot send audio chunk');
      return;
    }
    console.log('[GeminiLiveHelper] 🎵 Sending audio chunk to Gemini, size:', chunk.length);
    const base64Audio = chunk.toString('base64');
    this.session.sendRealtimeInput({
      audio: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' }
    });
  }

  /** Check whether a live session is currently active */
  isActive(): boolean {
    return !!this.session;
  }

  /** Return true if session is active and not pending close */
  canAcceptTextInput(): boolean {
    return !!this.session && !this.closePending;
  }

  /** Send plain text input during a live session */
  sendTextInput(text: string): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({ text });
  }

  // Stream a JPEG image frame
  sendImageChunk(base64Jpeg: string): void {
    if (!this.session) return;
    this.session.sendRealtimeInput({ video: { data: base64Jpeg, mimeType: 'image/jpeg' } });
  }

  // Called when the mic button is toggled OFF
  finishTurn(): void {
    if (!this.session) return;
    // Send explicit end-of-turn marker but keep socket open for reply
    this.session.sendRealtimeInput({ audioStreamEnd: true });
    this.closePending = true;
  }

  endSession(): void {
    if (this.session) {
      try {
        this.session.close();
      } catch (err) {
        console.warn('[GeminiLive] error closing session:', err);
      }
      this.session = null;
    }
    this.closePending = false;
    this.turnJustCompleted = false;
  }
} 