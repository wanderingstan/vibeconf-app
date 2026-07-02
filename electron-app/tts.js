// tts.js — Text-to-speech provider abstraction.
// Currently supports ElevenLabs. Designed to be swappable for local
// models (e.g., Kokoro.js) in the future.
//
// Usage:
//   const tts = new TTSProvider({ provider: 'elevenlabs', apiKey: '...', voiceId: '...' });
//   const audioBuffer = await tts.synthesize('Hello everyone');
//   // audioBuffer is an ArrayBuffer ready for VirtualMic.playAudio()

class TTSProvider {
  constructor(config = {}) {
    this.provider = config.provider || 'auto'; // 'auto' picks elevenlabs if key set, else macos-say
    this.apiKey = config.apiKey || '';
    this.voiceId = config.voiceId || 'CwhRBWXzGAHq8TQ4Fs17'; // "Roger" (premade, free tier)
    this.modelId = config.modelId || 'eleven_v2_flash'; // fast model
    this.macosVoice = config.macosVoice || 'Samantha'; // macOS say voice
    this.voiceboxUrl = config.voiceboxUrl || 'http://127.0.0.1:17493'; // local Voicebox server
    this.voiceboxProfileId = config.voiceboxProfileId || '';
    this.voiceboxEngine = config.voiceboxEngine || 'kokoro'; // must match what the profile supports
    this._queue = [];
    this._active = false;
  }

  updateConfig(config) {
    if (config.provider) this.provider = config.provider;
    if ('apiKey' in config) this.apiKey = config.apiKey || '';
    if (config.voiceId) this.voiceId = config.voiceId;
    if (config.modelId) this.modelId = config.modelId;
    if (config.macosVoice) this.macosVoice = config.macosVoice;
    if (config.voiceboxUrl) this.voiceboxUrl = config.voiceboxUrl;
    if (config.voiceboxProfileId) this.voiceboxProfileId = config.voiceboxProfileId;
    if (config.voiceboxEngine) this.voiceboxEngine = config.voiceboxEngine;
  }

  async synthesize(text) {
    if (!text?.trim()) return null;

    // Serialize TTS requests to avoid concurrent API limit
    return new Promise((resolve, reject) => {
      this._queue.push({ text, resolve, reject });
      this._processQueue();
    });
  }

  _processQueue() {
    if (this._active || this._queue.length === 0) return;
    this._active = true;
    const { text, resolve, reject } = this._queue.shift();

    this._doSynthesize(text)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this._active = false;
        this._processQueue();
      });
  }

  _resolveProvider() {
    if (this.provider !== 'auto') return this.provider;
    // Auto: use ElevenLabs if key is set, otherwise fall back to macOS say
    if (this.apiKey) return 'elevenlabs';
    if (typeof require !== 'undefined' || typeof process !== 'undefined') return 'macos-say';
    throw new Error('No TTS provider available. Set an ElevenLabs API key or run on macOS.');
  }

  async _doSynthesize(text) {
    const provider = this._resolveProvider();
    switch (provider) {
      case 'elevenlabs':
        return this._elevenlabs(text);
      case 'macos-say':
        return this._macosSay(text);
      case 'voicebox':
        return this._voicebox(text);
      default:
        throw new Error(`Unknown TTS provider: ${provider}`);
    }
  }

  async _elevenlabs(text) {
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': this.apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      // Parse ElevenLabs' structured error so callers can react to specific
      // conditions (esp. quota_exceeded) instead of regex-matching a raw string.
      let detail = null;
      try { detail = JSON.parse(errorText)?.detail || null; } catch {}
      const code = detail?.status || detail?.code || null;
      let message = `ElevenLabs API error ${response.status}`;
      if (code === 'quota_exceeded') {
        // Pull the credit numbers out of the message for a clean, actionable note.
        const m = /You have (\d+) credits remaining, while (\d+) credits are required/.exec(detail?.message || '');
        const remaining = m ? Number(m[1]) : null;
        const required = m ? Number(m[2]) : null;
        message = remaining != null
          ? `ElevenLabs quota exhausted — ${remaining} credits left, ${required} needed for this line`
          : `ElevenLabs quota exhausted`;
        const err = new Error(message);
        err.code = 'quota_exceeded';
        err.status = response.status;
        err.quota = { remaining, required };
        throw err;
      }
      const err = new Error(`${message}: ${errorText}`);
      err.code = code || 'http_error';
      err.status = response.status;
      throw err;
    }

    return response.arrayBuffer();
  }

  // Force the macOS `say` fallback for a single utterance, regardless of the
  // configured provider. main.js calls this when ElevenLabs fails (e.g. quota
  // exhausted mid-call) so the bot stays audible with a degraded voice rather
  // than going silent. Returns an ArrayBuffer or null. Throws if not on macOS.
  async sayFallback(text) {
    if (!text?.trim()) return null;
    return this._macosSay(text);
  }

  async _macosSay(text) {
    // Use macOS `say` command to generate audio, then convert to WAV
    const { execSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const tmpDir = os.tmpdir();
    // Unique per PROCESS + call: os.tmpdir() is shared across every bot instance
    // on the machine, so a name from Date.now() alone collides when two bots
    // synthesize in the same millisecond (multi-profile #282/#301). Colliding
    // processes then stomp each other's temp files mid-afconvert → "Command
    // failed" / ENOENT. pid + random makes the path unique across processes and
    // within a process.
    const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const aiffPath = path.join(tmpDir, `vibeconf-tts-${uniq}.aiff`);
    const wavPath = aiffPath.replace('.aiff', '.wav');

    try {
      // Generate speech as AIFF
      const safeText = text.replace(/'/g, "'\\''");
      execSync(`say -v "${this.macosVoice}" -o "${aiffPath}" '${safeText}'`, { timeout: 15000 });

      // Convert AIFF to WAV (Web Audio API decodes WAV reliably)
      execSync(`afconvert -f WAVE -d LEI16@22050 "${aiffPath}" "${wavPath}"`, { timeout: 5000 });

      // Read WAV as ArrayBuffer
      const buffer = fs.readFileSync(wavPath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } finally {
      // Clean up temp files
      try { fs.unlinkSync(aiffPath); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}
    }
  }

  // Voicebox (voicebox.sh) — local TTS server. Generation is async: POST /generate
  // kicks off a job, we poll /generate/{id}/status until it completes, then fetch
  // the finished WAV from /audio/{id}. No streaming endpoint exists yet (Voicebox's
  // own docs list it as "Coming Soon"), so this mirrors the whole-buffer contract
  // of _elevenlabs/_macosSay rather than attempting partial playback.
  async _voicebox(text) {
    if (!this.voiceboxProfileId) {
      throw new Error('Voicebox profile not configured');
    }

    const genRes = await fetch(`${this.voiceboxUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: this.voiceboxProfileId,
        engine: this.voiceboxEngine,
        text,
      }),
    });
    if (!genRes.ok) {
      throw new Error(`Voicebox generate error ${genRes.status}: ${await genRes.text().catch(() => '')}`);
    }
    const { id, status: initialStatus, error: initialError } = await genRes.json();
    if (initialStatus === 'failed' || initialError) {
      throw new Error(`Voicebox generation failed: ${initialError}`);
    }

    // Poll for completion. The status endpoint returns an SSE-framed single event
    // ("data: {...}") rather than a plain JSON body.
    const deadline = Date.now() + 20000;
    let completed = false;
    while (Date.now() < deadline) {
      const raw = await fetch(`${this.voiceboxUrl}/generate/${id}/status`).then((r) => r.text());
      let data;
      try {
        data = JSON.parse(raw.replace(/^data:\s*/, ''));
      } catch {
        data = null;
      }
      if (data?.status === 'completed') {
        completed = true;
        break;
      }
      if (data?.status === 'failed') {
        throw new Error(`Voicebox generation failed: ${data.error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!completed) {
      throw new Error('Voicebox generation timed out');
    }

    const audioRes = await fetch(`${this.voiceboxUrl}/audio/${id}`);
    if (!audioRes.ok) {
      throw new Error(`Voicebox audio fetch error ${audioRes.status}`);
    }
    return audioRes.arrayBuffer();
  }
}

// Make available to service worker and other extension contexts
if (typeof globalThis !== 'undefined') {
  globalThis.TTSProvider = TTSProvider;
}
