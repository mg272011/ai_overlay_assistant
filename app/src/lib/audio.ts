// Keep a global reference to the audio context
let audioContext: AudioContext | null = null;

export type AudioCaptureStreams = {
  combinedStream: MediaStream;
  micStream: MediaStream;
  systemStream: MediaStream;
};

/**
 * Starts capturing both microphone and system audio and combines them into a single stream.
 *
 * @returns A promise that resolves to an object containing the combined stream and the original source streams for cleanup.
 */
export async function startAudioCapture(): Promise<AudioCaptureStreams> {
  try {
    console.log('[AudioCapture] Starting audio capture...');
    
    // For meeting mode, use microphone-only and let the Glass meeting service handle system audio
    const isMeetingMode = localStorage.getItem('opus-meeting-mode') === 'true';
    const micOnlyMode = isMeetingMode || localStorage.getItem('opus-mic-only-mode') === 'true';
    
    if (isMeetingMode) {
      console.log('[AudioCapture] Meeting mode detected - using microphone only (system audio handled by Glass meeting service)');
    } else if (micOnlyMode) {
      console.log('[AudioCapture] ⚠️ Running in MICROPHONE-ONLY mode (no system audio)');
    }
    
    // 1. Get or create an AudioContext
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext();
    }

    // 2. Capture microphone input
    console.log('[AudioCapture] Requesting microphone access...');
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[AudioCapture] ✅ Microphone access granted');
    } catch (micError) {
      console.error('[AudioCapture] ❌ Microphone access failed:', micError);
      throw new Error('Microphone access denied. Please grant permission in System Preferences.');
    }
    const micSource = audioContext.createMediaStreamSource(micStream);

    // 3. Capture system audio loopback (skip in mic-only mode or meeting mode)
    let systemStream: MediaStream;
    let systemSource: MediaStreamAudioSourceNode | null = null;
    
    if (!micOnlyMode && !isMeetingMode) {
      console.log('[AudioCapture] Requesting system audio access...');
      try {
        // Enable system audio loopback first (Clonely-style)
        // @ts-ignore - enableLoopback is added at runtime
        await window.ipcRenderer.enableLoopback();
        console.log('[AudioCapture] ✅ Loopback enabled');
        
        // Use simple Clonely-style getDisplayMedia call
        systemStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        console.log('[AudioCapture] ✅ System audio access granted');
        // Keep video track for potential screen frames
        systemSource = audioContext.createMediaStreamSource(systemStream);
      } catch (systemError) {
        console.error('[AudioCapture] ❌ System audio access failed:', systemError);
        console.error('[AudioCapture] Error details:', systemError);
        
        // More specific error handling
        if (systemError instanceof Error) {
          if (systemError.name === 'NotAllowedError') {
            throw new Error('Screen Recording permission denied. Please grant permission and restart the app.');
          } else if (systemError.name === 'NotSupportedError') {
            throw new Error('Screen recording not supported on this system.');
          }
        }
        
        throw new Error('Failed to capture system audio: ' + (systemError instanceof Error ? systemError.message : String(systemError)));
      }
    } else {
      // Create a dummy stream for mic-only mode or meeting mode
      systemStream = micStream.clone();
      if (!isMeetingMode) {
        console.log('[AudioCapture] ⚠️ Skipping system audio capture (mic-only mode)');
      }
    }

    // 4. Combine streams into **stereo** (L = mic, R = system)
    const merger = audioContext.createChannelMerger(2);
    // Connect mic to left (input 0)
    micSource.connect(merger, 0, 0);
    
    // Check if we're in mic-only mode
    if (!micOnlyMode && !isMeetingMode && systemSource) {
      // Connect system audio to right (input 1)
      systemSource.connect(merger, 0, 1);
    } else {
      // In mic-only mode or meeting mode, duplicate mic to both channels
      micSource.connect(merger, 0, 1);
    }

    const destination = audioContext.createMediaStreamDestination();
    merger.connect(destination);

    const combinedStream = destination.stream;

    console.log('[AudioCapture] ✅ Audio streams combined successfully');
    return { combinedStream, micStream, systemStream };
  } catch (err) {
    console.error('[AudioCapture] ❌ Error starting audio capture:', err);
    // Best-effort cleanup if something goes wrong during startup
    await stopAudioCapture({} as AudioCaptureStreams); // Pass empty object to trigger cleanup
    throw err;
  }
}

/**
 * Stops all provided audio streams and disables system audio loopback.
 *
 * @param streams An object containing the streams to stop.
 */
export async function stopAudioCapture(streams: Partial<AudioCaptureStreams>): Promise<void> {
  console.log('[AudioCapture] Stopping audio capture...');
  
  streams.combinedStream?.getTracks().forEach((track) => track.stop());
  streams.micStream?.getTracks().forEach((track) => track.stop());
  streams.systemStream?.getTracks().forEach((track) => track.stop());

  // Close the audio context if it exists
  if (audioContext && audioContext.state !== 'closed') {
    await audioContext.close();
    audioContext = null;
  }
  
  // Check if we should disable loopback (not needed in meeting mode)
  const isMeetingMode = localStorage.getItem('opus-meeting-mode') === 'true';
  if (!isMeetingMode) {
    // Tell the main process to disable system audio loopback (Clonely-style)
    // @ts-ignore - disableLoopback is added at runtime
    await window.ipcRenderer.disableLoopback().catch((err: any) => {
      console.error('[AudioCapture] Failed to disable loopback on cleanup:', err);
    });
  }

  console.log('[AudioCapture] ✅ Audio capture stopped');
} 