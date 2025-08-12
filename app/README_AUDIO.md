# Opus Audio Meeting Functionality

This document describes the enhanced audio/meeting functionality integrated from Clonely.

## Features

- **Real-time Transcription**: Uses Deepgram for live transcription with multi-channel support
- **Dual Audio Capture**: Captures both microphone (user) and system audio simultaneously
- **AI-Powered Suggestions**: Provides contextual suggestions during meetings based on conversation
- **Meeting Types**: Supports different contexts (interview, meeting, sales, exam, general)

## Setup

### 1. API Keys

You'll need to add the following to your `.env` file:

```env
# Existing OpenAI key
OPENAI_API_KEY=your_openai_api_key_here

# New Deepgram key for transcription
DEEPGRAM_API_KEY=your_deepgram_api_key_here
```

Get your Deepgram API key from: https://console.deepgram.com/

### 2. Audio Permissions

The app will request microphone and system audio permissions when you start conversation mode.

## Architecture

### Audio Flow

1. **Audio Capture Service** (`services/audioCapture.ts`)
   - Creates a hidden window that captures both mic and system audio
   - Combines audio streams into stereo (left: mic, right: system)
   - Sends audio chunks to main process

2. **Live Audio Service** (`services/LiveAudioService.ts`)
   - Manages Deepgram connection for transcription
   - Handles multi-channel audio (channel 0: mic, channel 1: system)
   - Deduplicates transcripts from both channels

3. **Conversation Monitor** (`ai/conversationMonitor.ts`)
   - Coordinates audio transcription with screen monitoring
   - Generates AI suggestions using GPT-4
   - Emits events for UI updates

### Key Differences from Original Opus

- **Transcription**: Switched from OpenAI Whisper to Deepgram for real-time streaming
- **Audio Capture**: Now captures system audio in addition to microphone
- **Multi-channel**: Distinguishes between user speech and system audio

## Usage

1. Click the microphone button (🎙️) to open the AI Assistant overlay
2. Select your meeting type in settings
3. Click "Start Listening" to begin audio capture
4. AI suggestions will appear based on the conversation context

## Technical Notes

- Audio is captured at 16kHz sample rate for optimal transcription
- Stereo audio format: Left channel (mic), Right channel (system)
- Deepgram Nova-2 model used for transcription
- Suggestions generated every utterance end (natural pause in speech) 