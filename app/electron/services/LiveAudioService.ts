import { EventEmitter } from 'events';
import { TranscribeHelper, TranscriptionResult } from './TranscribeHelper.js';
import { GeminiLiveHelper } from './GeminiLiveHelper.js';
import { performance } from 'perf_hooks';

export interface LiveAudioCallbacks {
  onGeminiChunk?: (chunk: { text?: string; reset?: boolean }) => void;
  onTranscript?: (res: TranscriptionResult) => void;
  onUtteranceEnd?: () => void;
}

/**
 * High-level wrapper that orchestrates both Gemini Live and Deepgram live transcription
 * in tandem. Handles multi-channel audio (microphone + system audio).
 */
export class LiveAudioService extends EventEmitter {
  private readonly gemini = new GeminiLiveHelper();
  private readonly transcribe = new TranscribeHelper();
  private active = false;
  private geminiAudioMuted = false; // New flag to control Gemini audio
  private transcriptDebounceTimer: NodeJS.Timeout | null = null;
  private bufferedTranscript: TranscriptionResult | null = null;

  isActive(): boolean {
    return this.active;
  }

  /**
   * Connect to both Gemini and Deepgram. Resolves once BOTH are ready to receive data.
   */
  async start(callbacks: LiveAudioCallbacks): Promise<void> {
    const tStart = performance.now();
    console.log('[LiveAudioService] Start called');
    
    // Prevent duplicate or concurrent start attempts
    if (this.active) {
      console.warn('[LiveAudioService] Already active, ignoring start()');
      return;
    }

    // Optimistically mark active to block re-entry while we connect
    this.active = true;
    console.log('[LiveAudioService] Service marked as active');

    const { onGeminiChunk, onTranscript, onUtteranceEnd } = callbacks;

    try {
      await Promise.all([
        this.gemini.startSession((chunk: { text?: string; reset?: boolean }) => {
          onGeminiChunk?.(chunk);
          console.warn('Gemini chunk:', chunk);
        }),
        this.transcribe.start(
        (res: TranscriptionResult) => {
          // Send ALL transcripts (both interim and final) to UI for real-time display
          console.log(`[LiveAudioService] Transcript - Channel: ${res.channel}, IsFinal: ${res.isFinal}, Text: "${res.transcript}"`);
          
          // Always send transcript to UI for real-time display
          onTranscript?.(res);
          
          // Only process final transcripts for Gemini
          if (!res.isFinal) {
            return; // Skip further processing for interim transcripts
          }

          // Debounce logic for final transcripts only
          if (this.bufferedTranscript) {
            clearTimeout(this.transcriptDebounceTimer!);
            const buffered = this.bufferedTranscript;
            this.bufferedTranscript = null;

            // Prioritize channel 1 (system audio) as the cleaner source
            let winner = buffered; // Default to the one that arrived first
            if (res.channel === 1 && buffered.channel !== 1) {
              winner = res; // The new one is channel 1, and the buffered one wasn't
            }

            console.log(`[LiveAudioService] Debounced pair. Chose Ch${winner.channel} from Buffered(Ch${buffered.channel}) & Current(Ch${res.channel}).`);
            this.processFinalTranscript(winner, () => {}); // Process for Gemini but don't send again to UI

          } else {
            // This is the first transcript of a potential pair. Buffer it and set a timer
            this.bufferedTranscript = res;
            this.transcriptDebounceTimer = setTimeout(() => {
              if (this.bufferedTranscript) {
                console.log(`[LiveAudioService] Processing single transcript after timeout.`);
                this.processFinalTranscript(this.bufferedTranscript, () => {}); // Process for Gemini but don't send again to UI
                this.bufferedTranscript = null;
              }
            }, 200); // Wait 200ms for a potential duplicate
          }
        },
        () => {
            console.log('[LiveAudioService] Utterance end, calling gemini.finishTurn()');
            this.gemini.finishTurn();
          onUtteranceEnd?.();
          this.emit('utterance-end');
        }
        )
      ]);
      
      console.log('[perf] live-audio-ready', (performance.now() - tStart).toFixed(1), 'ms');
      this.emit('ready');
    } catch (err) {
      // Roll back active flag if we fail to connect
      console.error('[LiveAudioService] ❌ FAILED TO START:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[LiveAudioService] Error details:', errorMessage);
      console.log('[LiveAudioService] Rolling back active flag to false');
      this.active = false;
      throw err;
    }
  }

  /**
   * Forward a PCM 16k stereo chunk to Deepgram, and left (mic) channel to Gemini.
   * Expected format: 16-bit PCM, 16kHz sample rate, stereo (2 channels)
   * Channel 0: Microphone audio
   * Channel 1: System audio
   */
  sendAudioChunk(chunk: Buffer): void {
    if (!this.active) {
      console.log('[LiveAudioService] Ignoring audio chunk - service not active');
      return;
    }
    console.log('[LiveAudioService] 🎧 Processing audio chunk, size:', chunk.length);
    
    // Send mic-only (left channel) to Gemini if not muted
    if (!this.geminiAudioMuted) {
      const left = LiveAudioService.extractLeftChannel(chunk);
      if (left) {
        console.log('[LiveAudioService] 🎤 Sending LEFT channel (mic) to Gemini, size:', left.length);
        this.gemini.sendAudioChunk(left);
      } else {
        console.log('[LiveAudioService] ❌ Failed to extract left channel from audio');
      }
    } else {
      console.log('[LiveAudioService] 🔇 Gemini audio is muted, skipping');
    }
    // Send full stereo to Deepgram
    console.log('[LiveAudioService] 📝 Sending STEREO audio to Deepgram for transcription');
    this.transcribe.sendChunk(chunk);
  }

  /**
   * Gracefully end both streams and reset
   */
  stop(): void {
    if (!this.active) {
      return;
    }
    
    // Clear any pending timers
    if (this.transcriptDebounceTimer) {
      clearTimeout(this.transcriptDebounceTimer);
      this.transcriptDebounceTimer = null;
    }
    
    this.gemini.endSession();
    this.transcribe.finish();
    this.active = false;
    this.emit('stopped');
  }

  /** Signal end of current user turn but keep connection open */
  finishTurn(): void {
    if (!this.active) {
      return;
    }
    this.gemini.finishTurn();
  }

  /** Send a video frame (JPEG base64) to Gemini only */
  sendImageChunk(base64Jpeg: string): void {
    if (!this.active) {
      return;
    }
    this.gemini.sendImageChunk(base64Jpeg);
  }

  /** Relay a text input to Gemini if allowed */
  sendTextInput(text: string): void {
    if (this.gemini.canAcceptTextInput()) {
      this.gemini.sendTextInput(text);
    }
  }

  /** Toggle whether audio is sent to Gemini */
  toggleGeminiAudio(mute: boolean): void {
    this.geminiAudioMuted = mute;
    console.warn(`Gemini audio muted: ${this.geminiAudioMuted}`);
  }

  /**
   * Extract the LEFT channel (mic) from an interleaved Int16 stereo buffer.
   * Returns a new Buffer containing left-channel 16-bit PCM samples.
   */
  static extractLeftChannel(stereo: Buffer): Buffer | null {
    if (stereo.length % 4 !== 0) return null; // expect 4 bytes per stereo frame
    const sampleCount = stereo.length / 4;
    const left = Buffer.allocUnsafe(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      // Copy little-endian 16-bit left sample (bytes 0 & 1 of each 4-byte frame)
      left[i * 2] = stereo[i * 4];
      left[i * 2 + 1] = stereo[i * 4 + 1];
    }
    return left;
  }

  /**
   * Extract the RIGHT channel (system audio) from an interleaved Int16 stereo buffer.
   */
  static extractRightChannel(stereo: Buffer): Buffer | null {
    if (stereo.length % 4 !== 0) return null; // expect 4 bytes per stereo frame
    const sampleCount = stereo.length / 4;
    const right = Buffer.allocUnsafe(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      // Copy little-endian 16-bit right sample (bytes 2 & 3 of each 4-byte frame)
      right[i * 2] = stereo[i * 4 + 2];
      right[i * 2 + 1] = stereo[i * 4 + 3];
    }
    return right;
  }

  private processFinalTranscript(
    res: TranscriptionResult, 
    onTranscript: (res: TranscriptionResult) => void
  ): void {
    // Label the transcript with its source
    const labeledTranscript = {
      ...res,
      speaker: res.channel === 0 ? 'user' : 'system'
    };
    
    onTranscript(labeledTranscript);
    
    // Emit event for other parts of the system
    this.emit('transcript', labeledTranscript);
    
    // If this is from device channel (1), feed to Gemini as text.
    if (res.channel === 1 && this.gemini.canAcceptTextInput()) {
      const start = res.start?.toFixed(2) || 'undefined';
      const end = res.end?.toFixed(2) || 'undefined';
      console.warn(`[LiveAudioService] Sending text to Gemini (Device Channel): "Device Audio Transcript [${start}-${end}]: ${res.transcript}"`);
      this.gemini.sendTextInput(`Device Audio Transcript [${start}-${end}]: ${res.transcript}`);
    }
  }
} 