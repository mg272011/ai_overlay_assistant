import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export interface TranscriptionResult {
  transcript: string;
  channel: number;
  isFinal: boolean;
  words?: any[];
  start?: number;
  end?: number;
}

export class TranscribeHelper {
  private deepgram: ReturnType<typeof createClient>;
  private connection: any | null = null;
  private apiKey: string;

  constructor() {
    console.log('[TranscribeHelper] Initializing...');
    console.log('[TranscribeHelper] Looking for .env file at:', path.resolve(__dirname, '../../../.env'));
    console.log('[TranscribeHelper] Current __dirname:', __dirname);
    
    // Log all env vars starting with DEEPGRAM (without exposing the full key)
    Object.keys(process.env).forEach(key => {
      if (key.includes('DEEPGRAM')) {
        console.log(`[TranscribeHelper] Found env var ${key}:`, process.env[key] ? `${process.env[key].substring(0, 10)}...` : 'undefined');
      }
    });
    
    this.apiKey = process.env.DEEPGRAM_API_KEY || '';
    if (!this.apiKey) {
      console.warn('[TranscribeHelper] ❌ Deepgram API Key not found. Please set DEEPGRAM_API_KEY in your .env file.');
      // Create a dummy client to prevent crashes
      this.deepgram = null as any;
      return;
    }
    console.log('[TranscribeHelper] ✅ Deepgram API Key found:', this.apiKey.substring(0, 10) + '...');
    this.deepgram = createClient(this.apiKey);
  }

  public async start(
    onTranscript: (res: TranscriptionResult) => void, 
    onUtteranceEnd?: () => void
  ): Promise<void> {
    if (!this.apiKey || !this.deepgram) {
      console.warn('Cannot start Deepgram transcription: API Key is missing.');
      return Promise.resolve(); // Resolve instead of reject to prevent crashes
    }

    if (this.connection) {
      console.warn('Deepgram connection already active. Stopping existing connection before starting a new one.');
      this.finish();
    }

    return new Promise<void>((resolve, reject) => {
      try {
        console.log('[TranscribeHelper] Attempting to connect to Deepgram...');
        console.log('[TranscribeHelper] Using API key:', this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'MISSING');
        console.log('[TranscribeHelper] Creating live connection with params:');
        console.log('[TranscribeHelper] - model: nova-2');
        console.log('[TranscribeHelper] - language: en-US');
        console.log('[TranscribeHelper] - encoding: linear16');
        console.log('[TranscribeHelper] - sample_rate: 16000');
        console.log('[TranscribeHelper] - channels: 2');
        
        this.connection = this.deepgram.listen.live({
          model: 'nova-2',
          language: 'en-US',
          smart_format: true,
          encoding: 'linear16',
          sample_rate: 16000,
          channels: 2,
          multichannel: true,
          interim_results: true,  // Enable interim results for real-time display
          utterance_end_ms: 1000, // Faster utterance detection
          vad_events: true,       // Voice activity detection
        });
        
        console.log('[TranscribeHelper] Connection object created:', !!this.connection);

        // Check connection state periodically and resolve when OPEN
        let connectionResolved = false;
        const stateChecker = setInterval(() => {
          if (this.connection && !connectionResolved) {
            const state = this.connection.getReadyState();
            console.log(`[TranscribeHelper] WebSocket state: ${state} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
            
            // If WebSocket is OPEN but Open event didn't fire, manually resolve
            if (state === 1) { // WebSocket.OPEN
              console.log('[TranscribeHelper] ✅ WebSocket is OPEN! Manually resolving (Open event not fired)');
              connectionResolved = true;
              clearTimeout(connectionTimeout);
              clearInterval(stateChecker);
              resolve();
            }
          }
        }, 1000); // Check every second

        // Add timeout for connection
        const connectionTimeout = setTimeout(() => {
          if (!connectionResolved) {
            console.error('[TranscribeHelper] ❌ CONNECTION TIMEOUT after 10 seconds');
            console.error('[TranscribeHelper] WebSocket never opened - likely network or API issue');
            console.error('[TranscribeHelper] Final state:', this.connection?.getReadyState());
            connectionResolved = true;
            clearInterval(stateChecker);
            if (this.connection) {
              this.connection.removeAllListeners();
              this.connection = null;
            }
            reject(new Error('Deepgram connection timeout'));
          }
        }, 10000);

        this.connection.on(LiveTranscriptionEvents.Open, () => {
          if (!connectionResolved) {
            console.log('[TranscribeHelper] ✅ Deepgram connection SUCCESSFULLY opened! (via Open event)');
            console.log('[TranscribeHelper] Connection is ready to receive audio');
            connectionResolved = true;
            clearTimeout(connectionTimeout);
            clearInterval(stateChecker);
            resolve();
          }
        });

        this.connection.on(LiveTranscriptionEvents.Close, () => {
          console.log('Deepgram connection closed.');
          this.connection = null;
        });

        this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
          const alt = data.channel.alternatives[0];
          if (!alt?.transcript) return;
          const channelIndex = data.channel_index[0];
          const result: TranscriptionResult = {
            transcript: alt.transcript as string,
            words: (alt.words || []).map((w: any) => ({
              ...w,
              speaker: channelIndex,
            })),
            channel: channelIndex,
            isFinal: data.is_final as boolean,
            start: data.start,
            end: data.start + data.duration,
          };
          console.log(`[Deepgram Transcript] Channel: ${result.channel}, IsFinal: ${result.isFinal}, Transcript: "${result.transcript}"`);
          onTranscript(result);
        });

        this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
          console.log('[TranscribeHelper] Utterance end');
          onUtteranceEnd?.();
        });

        this.connection.on(LiveTranscriptionEvents.Metadata, (_meta: any) => {
          // Metadata events can be logged if needed
        });

        this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
          if (!connectionResolved) {
            console.error('[TranscribeHelper] ❌ DEEPGRAM CONNECTION ERROR:', err);
            console.error('[TranscribeHelper] Error details:', JSON.stringify(err, null, 2));
            console.error('[TranscribeHelper] Error type:', typeof err);
            console.error('[TranscribeHelper] Error message:', err?.message);
            console.error('[TranscribeHelper] Error code:', err?.code);
            console.error('[TranscribeHelper] This will cause auto-stop!');
            connectionResolved = true;
            clearTimeout(connectionTimeout);
            clearInterval(stateChecker);
            this.connection = null;
            reject(err);
          }
        });

      } catch (error) {
        console.error('[TranscribeHelper] ❌ FAILED TO ESTABLISH DEEPGRAM CONNECTION (SYNC ERROR):', error);
        console.error('[TranscribeHelper] Sync error details:', JSON.stringify(error, null, 2));
        console.error('[TranscribeHelper] Error type:', typeof error);
        console.error('[TranscribeHelper] Error message:', (error as any)?.message);
        console.error('[TranscribeHelper] Error stack:', (error as any)?.stack);
        console.error('[TranscribeHelper] This will cause auto-stop!');
        this.connection = null;
        reject(error);
      }
    });
  }

  public sendChunk(chunk: Buffer): void {
    if (!this.connection || !this.deepgram) {
      return; // Silently ignore if no connection or API key
    }
    if (this.connection.getReadyState() === 1) { // WebSocket.OPEN
      this.connection.send(chunk);
    } else {
      console.warn('Deepgram connection not open. Cannot send audio chunk.');
    }
  }

  public finish(): void {
    if (this.connection && this.deepgram) {
      console.log('Closing Deepgram connection.');
      this.connection.finish();
      this.connection = null;
    } else {
      console.warn('No active Deepgram connection to close.');
    }
  }
} 