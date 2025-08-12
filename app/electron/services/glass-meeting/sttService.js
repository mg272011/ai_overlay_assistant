import { spawn } from 'child_process';
import { createOpenAISTT } from './openaiProvider.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DEBOUNCE_TIME = 2000;
const KEEPALIVE_INTERVAL_MS = 60000;
const SESSION_RENEWAL_MINUTES = 20;

class GlassSttService {
    constructor() {
        this.sttSessions = [];
        this.callbacks = {};
        this.isListening = false;
        this.macOSAudioProcess = null;
        this._isSessionActive = false;
        this.sessionStartTime = null;

        // Simple echo/duplicate suppression state
        this.lastMyText = '';
        this.lastMyTime = 0;
        this.lastTheirText = '';
        this.lastTheirTime = 0;

        // Gemini client for ultra-fast correction
        try {
            const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
            this.gemini = apiKey ? new GoogleGenerativeAI(apiKey) : null;
        } catch { this.gemini = null; }
    }

    setCallbacks(callbacks) {
        this.callbacks = callbacks;
    }

    normalizeText(t) {
        return String(t || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    isLikelyDuplicateEcho(a, b) {
        // Return true if a ~= b (substring or high overlap)
        const na = this.normalizeText(a);
        const nb = this.normalizeText(b);
        if (!na || !nb) return false;
        if (na === nb) return true;
        if (na.length <= 4 || nb.length <= 4) return na === nb;
        // Substring containment
        if (na.includes(nb) || nb.includes(na)) return true;
        // Token overlap ratio
        const seta = new Set(na.split(' '));
        const setb = new Set(nb.split(' '));
        let inter = 0;
        seta.forEach(tok => { if (setb.has(tok)) inter++; });
        const overlap = inter / Math.max(seta.size, setb.size);
        return overlap > 0.7;
    }

    debounce(func, delay) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }

    flushOpenAIBuffers() {
        if (!this.mySttSession && !this.theirSttSession) return;

        try {
            [this.mySttSession, this.theirSttSession].forEach((session, index) => {
                if (session && session.sendAudio) {
                    session.sendAudio(''); // Flush any pending audio
                }
            });
        } catch (error) {
            console.error('[Glass-Meeting] Error flushing OpenAI buffers:', error);
        }
    }

    async initializeSttSessions(language = 'en') {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OpenAI API key is not configured.');
        }

        console.log('[Glass-Meeting] Initializing STT sessions for OpenAI...');

        const handleMyMessage = async (transcript, isFinal) => {
            if (transcript && transcript.trim()) {
                // Echo suppression: if "Them" spoke very recently with near-identical text, drop this as echo
                const now = Date.now();
                const recentWindowMs = 1500; // 1.5s window
                const isRecentTheir = (now - this.lastTheirTime) < recentWindowMs;
                const isEcho = isRecentTheir && this.isLikelyDuplicateEcho(transcript, this.lastTheirText);
                if (isEcho) {
                    console.log('[Glass-Meeting] 🔇 Suppressing echo on Me (matched recent Them)');
                    // Still update lastMy* so future comparisons know about it
                    this.lastMyText = transcript; this.lastMyTime = now;
                    return;
                }

                // Optional ultra-fast correction on final only
                if (isFinal) {
                    transcript = await this.correctIfObvious(transcript);
                }
                console.log(`[Glass-Meeting] 🎤 Me: ${transcript} (${isFinal ? 'final' : 'partial'})`);
                this.sendToRenderer('stt-update', {
                    speaker: 'Me',
                    text: transcript,
                    isPartial: !isFinal,
                    isFinal,
                    timestamp: Date.now()
                });

                if (!isFinal) {
                    this.callbacks.onPartial?.('Me', transcript);
                }

                if (isFinal) {
                    this.callbacks.onTranscriptionComplete?.('Me', transcript);
                }

                this.lastMyText = transcript; this.lastMyTime = now;
            }
        };

        const handleTheirMessage = async (transcript, isFinal) => {
            if (transcript && transcript.trim()) {
                // If "Me" produced a near-identical line very recently, prefer "Them" and optionally mute the recent Me
                const now = Date.now();
                const recentWindowMs = 1500;
                const isRecentMine = (now - this.lastMyTime) < recentWindowMs;
                const overlaps = isRecentMine && this.isLikelyDuplicateEcho(transcript, this.lastMyText);
                if (overlaps) {
                    console.log('[Glass-Meeting] ↔️ Reclassifying overlapping text as Them (overrode recent Me)');
                    // No special UI handling needed; just proceed with Them
                }

                // Optional ultra-fast correction on final only
                if (isFinal) {
                    transcript = await this.correctIfObvious(transcript);
                }
                console.log(`[Glass-Meeting] 🔊 Them: ${transcript} (${isFinal ? 'final' : 'partial'})`);
                this.sendToRenderer('stt-update', {
                    speaker: 'Them', 
                    text: transcript,
                    isPartial: !isFinal,
                    isFinal,
                    timestamp: Date.now()
                });

                if (!isFinal) {
                    this.callbacks.onPartial?.('Them', transcript);
                }

                if (isFinal) {
                    this.callbacks.onTranscriptionComplete?.('Them', transcript);
                }

                this.lastTheirText = transcript; this.lastTheirTime = now;
            }
        };

        const myOptions = {
            apiKey,
            language,
            callbacks: {
                onTranscript: handleMyMessage,
                onError: (error) => console.error('[Glass-Meeting] My STT error:', error),
                onClose: () => console.log('[Glass-Meeting] My STT session closed')
            }
        };

        const theirOptions = {
            apiKey,
            language,
            callbacks: {
                onTranscript: handleTheirMessage,
                onError: (error) => console.error('[Glass-Meeting] Their STT error:', error),
                onClose: () => console.log('[Glass-Meeting] Their STT session closed')
            }
        };

        try {
            [this.mySttSession, this.theirSttSession] = await Promise.all([
                createOpenAISTT(myOptions),
                createOpenAISTT(theirOptions),
            ]);

            this._isSessionActive = true;
            this.sessionStartTime = Date.now();

            // Keep-alive timer - send empty audio periodically to keep connection alive
            this.keepAliveInterval = setInterval(() => {
                try {
                    // Send empty string to keep connection alive but not to trigger commits
                    if (this.mySttSession) {
                        // Don't send empty audio, it causes issues
                        // Just log to show we're still alive
                        console.log('[Glass-Meeting] Keep-alive check - session active');
                    }
                } catch (error) {
                    console.error('[Glass-Meeting] Keep-alive error:', error);
                }
            }, KEEPALIVE_INTERVAL_MS);

            // Session renewal timer
            this.renewalTimeout = setTimeout(() => {
                console.log('[Glass-Meeting] Renewing STT sessions...');
                this.initializeSttSessions(language);
            }, SESSION_RENEWAL_MINUTES * 60 * 1000);

            console.log('[Glass-Meeting] ✅ STT sessions initialized successfully');
        } catch (error) {
            console.error('[Glass-Meeting] ❌ Failed to initialize STT sessions:', error);
            throw error;
        }
    }

    async sendMicAudioContent(base64Data) {
        if (!this.mySttSession) {
            console.log('[Glass-Meeting] Warning: No mic STT session available');
            return;
        }
        try {
            this.mySttSession.sendAudio(base64Data);
            // Log every 10th call to avoid spam
            if (!this.micAudioCounter) this.micAudioCounter = 0;
            this.micAudioCounter++;
            if (this.micAudioCounter % 10 === 0) {
                console.log('[Glass-Meeting] Sent mic audio chunk #', this.micAudioCounter);
            }
        } catch (error) {
            console.error('[Glass-Meeting] Error sending mic audio:', error);
        }
    }

    async sendSystemAudioContent(base64Data) {
        if (!this.theirSttSession) {
            console.log('[Glass-Meeting] Warning: No system STT session available');
            return;
        }
        try {
            this.theirSttSession.sendAudio(base64Data);
            // Log every 10th call to avoid spam
            if (!this.systemAudioCounter) this.systemAudioCounter = 0;
            this.systemAudioCounter++;
            if (this.systemAudioCounter % 10 === 0) {
                console.log('[Glass-Meeting] Sent system audio chunk #', this.systemAudioCounter);
            }
        } catch (error) {
            console.error('[Glass-Meeting] Error sending system audio:', error);
        }
    }

    sendToRenderer(channel, data) {
        import('electron').then(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                windows[0].webContents.send(channel, data);
            }
        }).catch(error => {
            console.error('[Glass-Meeting] Error importing electron:', error);
        });
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin') {
            throw new Error('macOS audio capture only available on macOS');
        }

        console.log('[Glass-Meeting] Starting macOS system audio capture...');
        
        try {
            const executablePath = '/Users/michaelgoldstein/opus/app/swift/SystemAudioDump';
            this.macOSAudioProcess = spawn(executablePath, [], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.macOSAudioProcess.stdout.on('data', (data) => {
                const base64Data = data.toString('base64');
                this.sendSystemAudioContent(base64Data);
            });

            this.macOSAudioProcess.stderr.on('data', (data) => {
                console.error('[Glass-Meeting] SystemAudioDump stderr:', data.toString());
            });

            this.macOSAudioProcess.on('error', (error) => {
                console.error('[Glass-Meeting] SystemAudioDump error:', error);
            });

            this.macOSAudioProcess.on('close', (code) => {
                console.log(`[Glass-Meeting] SystemAudioDump closed with code ${code}`);
                this.macOSAudioProcess = null;
            });

            console.log('[Glass-Meeting] ✅ macOS system audio capture started');
        } catch (error) {
            console.error('[Glass-Meeting] ❌ Failed to start macOS audio capture:', error);
            throw error;
        }
    }

    stopMacOSAudioCapture() {
        if (this.macOSAudioProcess) {
            console.log('[Glass-Meeting] Stopping macOS system audio capture...');
            this.macOSAudioProcess.kill('SIGTERM');
            this.macOSAudioProcess = null;
        }
    }

    isSessionActive() {
        return this._isSessionActive && (this.mySttSession || this.theirSttSession);
    }

    async closeSessions() {
        console.log('[Glass-Meeting] Closing STT sessions...');
        
        this._isSessionActive = false;
        
        // Clear timers
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.renewalTimeout) {
            clearTimeout(this.renewalTimeout);
            this.renewalTimeout = null;
        }

        // Close sessions
        if (this.mySttSession) {
            this.mySttSession.close();
            this.mySttSession = null;
        }
        if (this.theirSttSession) {
            this.theirSttSession.close();
            this.theirSttSession = null;
        }

        // Stop macOS audio capture
        this.stopMacOSAudioCapture();

        console.log('[Glass-Meeting] ✅ STT sessions closed');
    }
}

// Fast correction using Gemini 2.0 Flash experimental
GlassSttService.prototype.correctIfObvious = async function (text) {
    try {
        const original = text;
        if (!this.gemini) return original;
        // Keep this very fast: only short-ish segments
        if (original.length > 220) return original;
        const model = this.gemini.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        const prompt = `You are a lightning-fast transcription corrector.
Return ONLY the corrected input with minimal edits.
- Fix obvious ASR mistakes, misspellings, and wrong-word homophones
- Do NOT paraphrase, expand, or change meaning
- Preserve names/place/brand capitalization when obvious
- Keep punctuation and sentence structure unless clearly wrong
If the input is already correct, return it unchanged.

Input:
${original}`;
        const res = await model.generateContent(prompt);
        let out = res?.response?.text()?.trim();
        if (!out) return original;

        // Strip wrappers the model might add
        out = out.replace(/^```[a-z]*\n?|```$/g, '').replace(/^"|"$/g, '').trim();

        // Safety guards: avoid long expansions
        const maxLen = Math.ceil(original.length * 1.3) + 10; // allow slight growth
        if (out.length > maxLen) return original;

        // If the length delta is too large, likely paraphrase
        const lenDiff = Math.abs(out.length - original.length);
        if (lenDiff > Math.max(20, Math.floor(original.length * 0.3))) {
            return original;
        }
        return out;
    } catch {
        return text;
    }
}

export default GlassSttService; 