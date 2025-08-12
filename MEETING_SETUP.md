# Meeting/Live Audio Setup Guide

## What's Been Implemented

We've ported the meeting/live audio functionality from Clonely to Opus, which includes:

1. **Dual Transcription System**:
   - Deepgram for audio transcription (both microphone and system audio)
   - Gemini Live for AI responses during meetings

2. **LiveAudioService** - The main service that:
   - Manages both Deepgram and Gemini connections
   - Handles stereo audio (left channel = mic, right channel = system audio)
   - Sends mic audio to Gemini for AI processing
   - Sends system audio transcripts to Gemini as context

3. **Updated UI Handlers**:
   - Live transcripts show in the transcript pane
   - Gemini responses appear as live actions/suggestions
   - Proper event handling for both services

## Setup Instructions

### 1. Install Gemini SDK (Required for full functionality)

```bash
cd app
npm install @google/genai
```

### 2. Set up API Keys

Create a `.env` file in the `app` directory with:

```env
# Deepgram API Key (already set up)
DEEPGRAM_API_KEY=your_deepgram_api_key

# Gemini API Key (new)
GEMINI_API_KEY=your_gemini_api_key
```

### 3. Update GeminiLiveHelper.ts

Once you have the `@google/genai` package installed, update the `GeminiLiveHelper.ts` file with the full implementation from Clonely. The current version is a placeholder that simulates the connection.

## How It Works

1. **Click the microphone button** to start live mode
2. **Audio Capture**: 
   - Your microphone audio is captured (channel 0)
   - System audio is captured (channel 1)
3. **Transcription**: 
   - Both channels are sent to Deepgram for transcription
   - Transcripts appear in the UI labeled as "You" (mic) or "System" (desktop audio)
4. **AI Processing**:
   - Mic audio is streamed to Gemini for AI analysis
   - System audio transcripts are sent to Gemini as text context
   - Gemini's responses appear as live suggestions

## Current Status

- ✅ Core architecture ported from Clonely
- ✅ LiveAudioService with Gemini integration
- ✅ UI handlers for transcripts and Gemini responses
- ✅ IPC handlers for all live audio features
- ✅ GeminiLiveHelper with full implementation
- ✅ Deepgram transcription is fully functional
- ✅ @google/genai package installed
- ✅ @deepgram/sdk package installed
- ✅ Gemini API key configured
- ✅ All compilation errors fixed

## ✅ SETUP COMPLETE!

The meeting functionality is now fully operational! You can:

1. **Click the microphone button** to start live mode
2. **Speak into your microphone** - Gemini will hear and respond
3. **Play any audio** (videos, music, calls) - Gemini will receive transcripts as context
4. **View live transcripts** in the UI
5. **See AI responses** as live suggestions

The system will:
- Transcribe both microphone and system audio via Deepgram
- Stream microphone audio to Gemini Live for real-time AI interaction
- Send system audio transcripts to Gemini as contextual information
- Display everything in the UI with proper channel labeling 