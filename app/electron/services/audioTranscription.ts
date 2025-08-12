import OpenAI from "openai";
import { EventEmitter } from "events";
import { logWithElapsed } from "../utils/utils";
import * as fs from "fs";
import * as path from "path";
import { TMPDIR } from "../main";

export class AudioTranscriptionService extends EventEmitter {
  private openai: OpenAI;
  private isRecording: boolean = false;
  private audioChunks: Buffer[] = [];
  private recordingStartTime: number = 0;
  
  constructor() {
    super();
    this.openai = new OpenAI();
  }

  async transcribeAudioBuffer(audioBuffer: Buffer, format: string = "webm"): Promise<string> {
    try {
      // Save buffer to temporary file
      const tempFile = path.join(TMPDIR, `audio-${Date.now()}.${format}`);
      fs.writeFileSync(tempFile, audioBuffer);
      
      // Create a readable stream from the file
      const audioStream = fs.createReadStream(tempFile);
      
      // Transcribe using Whisper
      const transcription = await this.openai.audio.transcriptions.create({
        file: audioStream,
        model: "whisper-1",
        language: "en",
        response_format: "text"
      });
      
      // Clean up temp file
      fs.unlinkSync(tempFile);
      
      logWithElapsed("AudioTranscription", `Transcribed: ${transcription}`);
      return transcription;
      
    } catch (error) {
      logWithElapsed("AudioTranscription", `Transcription error: ${error}`);
      throw error;
    }
  }

  async transcribeWithSpeakerDiarization(
    audioBuffer: Buffer, 
    format: string = "webm"
  ): Promise<{ speaker: string; text: string; timestamp: number }[]> {
    try {
      // For now, just transcribe without speaker detection
      // In production, you'd use a service like AssemblyAI or Deepgram for diarization
      const transcription = await this.transcribeAudioBuffer(audioBuffer, format);
      
      return [{
        speaker: "unknown",
        text: transcription,
        timestamp: Date.now()
      }];
      
    } catch (error) {
      logWithElapsed("AudioTranscription", `Diarization error: ${error}`);
      throw error;
    }
  }

  startRecording() {
    this.isRecording = true;
    this.audioChunks = [];
    this.recordingStartTime = Date.now();
    this.emit("recording-started");
  }

  stopRecording(): Buffer {
    this.isRecording = false;
    const audioBuffer = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.emit("recording-stopped", { duration: Date.now() - this.recordingStartTime });
    return audioBuffer;
  }

  addAudioChunk(chunk: Buffer) {
    if (this.isRecording) {
      this.audioChunks.push(chunk);
    }
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }
} 