import { createClient } from '@deepgram/sdk';
import OpenAI from 'openai';

interface SttCallbacks {
  onTranscriptionComplete: (speaker: string, text: string) => void;
  onStatusUpdate: (status: string) => void;
}

interface AudioChunk {
  speaker: 'me' | 'them';
  audio: Float32Array;
  timestamp: number;
}

export class SttService {
  private callbacks: SttCallbacks | null = null;
  private isListening: boolean = false;
  private audioBuffer: AudioChunk[] = [];
  private processingTimer: NodeJS.Timeout | null = null;
  private deepgramClient: any = null;
  private openaiClient: OpenAI | null = null;
  private currentProvider: 'deepgram' | 'openai' = 'deepgram';

  constructor() {
    this.initializeClients();
    console.log('[Glass-SttService] Service initialized');
  }

  private initializeClients() {
    // Initialize Deepgram if API key exists
    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramKey) {
      this.deepgramClient = createClient(deepgramKey);
      console.log('[Glass-SttService] Deepgram client initialized');
    }

    // Initialize OpenAI if API key exists
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.openaiClient = new OpenAI({ apiKey: openaiKey });
      console.log('[Glass-SttService] OpenAI client initialized');
    }

    // Set default provider based on availability
    if (this.deepgramClient) {
      this.currentProvider = 'deepgram';
    } else if (this.openaiClient) {
      this.currentProvider = 'openai';
    } else {
      console.warn('[Glass-SttService] No STT provider configured');
    }
  }

  setCallbacks(callbacks: SttCallbacks) {
    this.callbacks = callbacks;
  }

  async startListening() {
    if (this.isListening) {
      console.warn('[Glass-SttService] Already listening');
      return;
    }

    this.isListening = true;
    this.audioBuffer = [];
    
    // Start processing audio chunks periodically
    this.startProcessingTimer();
    
    console.log('[Glass-SttService] Started listening');
    this.callbacks?.onStatusUpdate('Listening...');
  }

  async stopListening() {
    if (!this.isListening) {
      return;
    }

    this.isListening = false;
    
    // Stop processing timer
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    
    // Process any remaining audio
    await this.processAudioBuffer();
    
    console.log('[Glass-SttService] Stopped listening');
    this.callbacks?.onStatusUpdate('Stopped');
  }

  private startProcessingTimer() {
    // Process audio chunks every 2 seconds
    this.processingTimer = setInterval(() => {
      if (this.audioBuffer.length > 0) {
        this.processAudioBuffer();
      }
    }, 2000);
  }

  // Called from the renderer process with audio data
  async addAudioChunk(speaker: 'me' | 'them', audioData: Float32Array) {
    if (!this.isListening) {
      return;
    }

    this.audioBuffer.push({
      speaker,
      audio: audioData,
      timestamp: Date.now()
    });

    // Process immediately if buffer is getting large
    if (this.audioBuffer.length > 10) {
      await this.processAudioBuffer();
    }
  }

  private async processAudioBuffer() {
    if (this.audioBuffer.length === 0) {
      return;
    }

    // Group chunks by speaker
    const speakerChunks: Map<string, AudioChunk[]> = new Map();
    
    for (const chunk of this.audioBuffer) {
      if (!speakerChunks.has(chunk.speaker)) {
        speakerChunks.set(chunk.speaker, []);
      }
      speakerChunks.get(chunk.speaker)!.push(chunk);
    }

    // Clear buffer
    this.audioBuffer = [];

    // Process each speaker's audio
    for (const [speaker, chunks] of speakerChunks.entries()) {
      const combinedAudio = this.combineAudioChunks(chunks);
      
      try {
        const transcription = await this.transcribeAudio(combinedAudio);
        
        if (transcription && transcription.trim().length > 0) {
          this.callbacks?.onTranscriptionComplete(speaker, transcription);
        }
      } catch (error) {
        console.error(`[Glass-SttService] Error transcribing ${speaker} audio:`, error);
      }
    }
  }

  private combineAudioChunks(chunks: AudioChunk[]): Float32Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.audio.length, 0);
    const combined = new Float32Array(totalLength);
    
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk.audio, offset);
      offset += chunk.audio.length;
    }
    
    return combined;
  }

  private async transcribeAudio(audioData: Float32Array): Promise<string> {
    if (this.currentProvider === 'deepgram' && this.deepgramClient) {
      return this.transcribeWithDeepgram(audioData);
    } else if (this.currentProvider === 'openai' && this.openaiClient) {
      return this.transcribeWithWhisper(audioData);
    }
    
    throw new Error('No STT provider available');
  }

  private async transcribeWithDeepgram(audioData: Float32Array): Promise<string> {
    try {
      // Convert Float32Array to Buffer
      const buffer = this.float32ToBuffer(audioData);
      
      const response = await this.deepgramClient.listen.prerecorded.transcribeFile(
        buffer,
        {
          punctuate: true,
          language: 'en',
          model: 'nova-2',
          smart_format: true,
          mimetype: 'audio/wav'
        }
      );
      
      const transcript = response.result?.results?.channels[0]?.alternatives[0]?.transcript || '';
      return transcript;
    } catch (error) {
      console.error('[Glass-SttService] Deepgram transcription error:', error);
      throw error;
    }
  }

  private async transcribeWithWhisper(_audioData: Float32Array): Promise<string> {
    try {
      // For now, return empty string if using Whisper - can be implemented later
      console.warn('[Glass-SttService] Whisper transcription not fully implemented');
      return '';
    } catch (error) {
      console.error('[Glass-SttService] Whisper transcription error:', error);
      throw error;
    }
  }

  private float32ToBuffer(float32Array: Float32Array): Buffer {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return Buffer.from(int16Array.buffer);
  }


} 