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
    this._queue = [];
    this._active = false;
  }

  updateConfig(config) {
    if (config.provider) this.provider = config.provider;
    if ('apiKey' in config) this.apiKey = config.apiKey || '';
    if (config.voiceId) this.voiceId = config.voiceId;
    if (config.modelId) this.modelId = config.modelId;
    if (config.macosVoice) this.macosVoice = config.macosVoice;
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
      throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
    }

    return response.arrayBuffer();
  }

  async _macosSay(text) {
    // Use macOS `say` command to generate audio, then convert to WAV
    const { execSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');

    const tmpDir = os.tmpdir();
    const aiffPath = path.join(tmpDir, `vibeconf-tts-${Date.now()}.aiff`);
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
}

// Make available to service worker and other extension contexts
if (typeof globalThis !== 'undefined') {
  globalThis.TTSProvider = TTSProvider;
}
