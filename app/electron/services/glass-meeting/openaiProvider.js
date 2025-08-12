import WebSocket from 'ws';

async function createOpenAISTT({ apiKey, language = 'en', callbacks = {} }) {
  console.log('[Glass-Meeting] Creating OpenAI STT session...');
  
  // Use the realtime API endpoint (not the transcription-only endpoint)
  const wsUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
  
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'OpenAI-Beta': 'realtime=v1',
  };

  // Rate limiting state
  let retryCount = 0;
  const maxRetries = 5;
  let isRateLimited = false;
  let rateLimitResetTime = 0;

  const createConnection = () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers });
      let isSessionReady = false;
      let pendingAudio = [];
      let commitTimer = null;
      const COMMIT_DEBOUNCE_MS = 500;  // Reduced from 900ms for faster commits
      const MIN_COMMIT_BYTES_MONO_16K_100MS = 1600; // Reduced threshold - roughly 50ms worth
      let bytesSinceLastCommit = 0;

      const scheduleCommit = () => {
        try {
          if (commitTimer) clearTimeout(commitTimer);
          commitTimer = setTimeout(() => {
            try {
              if (ws?.readyState === WebSocket.OPEN) {
                // Only commit if we have >= ~50ms of audio buffered
                if (bytesSinceLastCommit >= MIN_COMMIT_BYTES_MONO_16K_100MS) {
                  console.log('[Glass-Meeting] Committing audio buffer with', bytesSinceLastCommit, 'bytes');
                  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                  bytesSinceLastCommit = 0;
                } else if (bytesSinceLastCommit > 0) {
                  // We have some audio but not enough - wait a bit more and force commit
                  console.log('[Glass-Meeting] Waiting for more audio, currently have', bytesSinceLastCommit, 'bytes');
                  if (commitTimer) clearTimeout(commitTimer);
                  commitTimer = setTimeout(() => {
                    try {
                      if (ws?.readyState === WebSocket.OPEN && bytesSinceLastCommit > 0) {
                        console.log('[Glass-Meeting] Force committing smaller buffer with', bytesSinceLastCommit, 'bytes');
                        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                        bytesSinceLastCommit = 0;
                      }
                    } catch (e2) {
                      console.error('[Glass-Meeting] Commit retry error:', e2);
                    }
                  }, 200); // Wait 200ms more then force commit whatever we have
                }
              }
            } catch (e) {
              console.error('[Glass-Meeting] Commit error:', e);
            }
          }, COMMIT_DEBOUNCE_MS);
        } catch (err) {
          console.error('[Glass-Meeting] Commit schedule error:', err);
        }
      };
      
      const cleanTranscript = (t) => {
        if (!t) return t;
        // Drop isolated non-ascii 1-2 char tokens and trim double spaces
        return t
          .split(/\s+/)
          .filter(tok => tok.length > 2 || /^[\w\-.,!?']+$/.test(tok))
          .join(' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
      };

      const session = {
        sendAudio: (audioData) => {
          if (!isSessionReady) {
            pendingAudio.push(audioData);
            return;
          }
          
          try {
            const event = {
              type: 'input_audio_buffer.append',
              audio: audioData
            };
            ws.send(JSON.stringify(event));
            if (audioData && audioData.length > 0) {
              // Approximate byte length from base64 (OpenAI expects base64 PCM16)
              const b64len = audioData.length;
              const bytes = Math.floor(b64len * 0.75); // 3/4 approximation for base64->binary
              bytesSinceLastCommit += bytes;
              // Log periodically to debug
              if (bytesSinceLastCommit % 3200 === 0) {
                console.log('[Glass-Meeting] Accumulated', bytesSinceLastCommit, 'bytes of audio');
              }
            }
            if (audioData && audioData.length > 0) {
              scheduleCommit();
            }
          } catch (error) {
            console.error('[Glass-Meeting] Error sending audio to OpenAI:', error);
          }
        },
        
        close: () => {
          if (commitTimer) {
            clearTimeout(commitTimer);
            commitTimer = null;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }
      };

      ws.on('open', () => {
        console.log('[Glass-Meeting] Connected to OpenAI STT');
        retryCount = 0; // Reset retry count on successful connection
        isRateLimited = false;
        
        // For realtime API, configure session for audio transcription
        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: 'You are a helpful assistant that transcribes audio.',
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
              language: language || 'en'
            },
            tools: [],
            tool_choice: 'none',
            temperature: 0.6,  // Minimum allowed temperature for realtime API
            max_response_output_tokens: 4096
          }
        };
        
        ws.send(JSON.stringify(sessionConfig));
        isSessionReady = true;
        
        // Send any pending audio
        pendingAudio.forEach(audio => session.sendAudio(audio));
        pendingAudio = [];
        
        resolve(session);
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          // Handle rate limit errors
          if (event.type === 'error' && event.error?.code === 'rate_limit_exceeded') {
            console.warn('[Glass-Meeting] Rate limit exceeded, will retry with backoff');
            isRateLimited = true;
            rateLimitResetTime = Date.now() + (60 * 1000); // Assume 1 minute reset
            ws.close();
            return;
          }

          if (event.type === 'error') {
            console.error('[Glass-Meeting] OpenAI error:', event.error);
            if (callbacks.onError) {
              callbacks.onError(event.error);
            }
          } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
            const transcript = cleanTranscript(event.transcript || '');
            console.log('[Glass-Meeting] Transcription:', transcript);
            
            if (callbacks.onTranscript) {
              callbacks.onTranscript(transcript, true); // isFinal = true for OpenAI
            }
          } else if (event.type === 'conversation.item.input_audio_transcription.failed') {
            console.error('[Glass-Meeting] Transcription failed:', event);
          }
        } catch (error) {
          console.error('[Glass-Meeting] Error parsing message:', error);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[Glass-Meeting] WebSocket closed: ${code} ${reason}`);
        
        // Handle rate limit reconnection
        if (isRateLimited && retryCount < maxRetries) {
          const waitTime = Math.min(
            Math.pow(2, retryCount) * 1000 + Math.random() * 1000,
            30000 // Max 30 seconds
          );
          retryCount++;
          
          console.log(`[Glass-Meeting] Rate limited, retrying in ${Math.round(waitTime/1000)}s (attempt ${retryCount}/${maxRetries})`);
          
          setTimeout(() => {
            createConnection().then(resolve).catch(reject);
          }, waitTime);
        } else if (retryCount >= maxRetries) {
          reject(new Error(`Max retries exceeded due to rate limiting. Please upgrade your OpenAI tier.`));
        } else {
          // Normal close handling
          callbacks.onClose?.();
        }
      });

      ws.on('error', (error) => {
        console.error('[Glass-Meeting] WebSocket error:', error);
        reject(error);
      });
    });
  };

  return createConnection();
}

export { createOpenAISTT }; 