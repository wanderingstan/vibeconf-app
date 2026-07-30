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
    this.provider = config.provider || 'auto'; // 'auto' picks elevenlabs if key set, else the OS voice
    this.apiKey = config.apiKey || '';
    this.voiceId = config.voiceId || 'CwhRBWXzGAHq8TQ4Fs17'; // "Roger" (premade, free tier)
    this.modelId = config.modelId || 'eleven_flash_v2_5'; // fast model (~75ms, 0.5 credits/char)
    // The OS's built-in voice name: a `say` voice on macOS, a SAPI voice on
    // Windows (#18). One key for both — the config/IPC name stayed `macosVoice`
    // so existing saved settings keep working; only the meaning widened.
    // On Windows the default is '' rather than a guessed name: SAPI then uses
    // the machine's default voice, which is always installed. main.js seeds a
    // real name into the store once it has enumerated them.
    //
    // 'Daniel' on macOS is a PREFERENCE, not a guarantee, and naming a voice
    // that isn't installed is safe: `say` substitutes the system default and
    // still exits 0 (verified — an unknown name and an empty one both render
    // audio). Windows is explicitly safe the same way, via the try/catch around
    // SelectVoice in system-voices.js. So neither platform can go mute because
    // of the voice NAME — worth knowing before "fixing" this to '', which would
    // only trade a male default for the locale's default and change nothing
    // about reliability.
    //
    // Daniel is en_GB, so the obvious "fix" is a US voice — but the iconic ones
    // aren't there any more. On macOS 26.5, `Alex` is NOT installed (it became a
    // download); the plain en_US tier is the legacy set (Agnes, Albert, Fred,
    // Junior) plus novelty voices. Naming Alex would land on the system default,
    // which is Samantha — female, i.e. the opposite of what picking a male voice
    // was for. Daniel is male, present, and decent, so it stays.
    this.macosVoice = config.macosVoice || (process.platform === 'win32' ? '' : 'Daniel');
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
    // Auto: use ElevenLabs if a key is set, else the OS's built-in voice.
    if (this.apiKey) return 'elevenlabs';
    if (typeof require !== 'undefined' || typeof process !== 'undefined') return 'macos-say';
    throw new Error('No TTS provider available. Set an ElevenLabs API key or run on macOS/Windows.');
  }

  async _doSynthesize(text) {
    const provider = this._resolveProvider();
    switch (provider) {
      case 'elevenlabs':
        return this._elevenlabs(text);
      // 'macos-say' is the historical id for "the OS's built-in voice" and is
      // what's persisted in existing configs; 'system' is the honest alias.
      case 'macos-say':
      case 'system':
        return this._systemSay(text);
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

  // Force the OS's built-in voice for a single utterance, regardless of the
  // configured provider. main.js calls this when ElevenLabs fails (e.g. quota
  // exhausted mid-call) so the bot stays audible with a degraded voice rather
  // than going silent. Returns an ArrayBuffer or null. Throws on a platform
  // with no built-in path (Linux — #21).
  async sayFallback(text) {
    if (!text?.trim()) return null;
    return this._systemSay(text);
  }

  // The OS's out-of-the-box voice: `say` on macOS, SAPI via PowerShell on
  // Windows (#18). Both render to a temp file and hand back the same 16-bit
  // 22.05kHz mono WAV, so everything downstream is platform-blind.
  async _systemSay(text) {
    if (process.platform === 'win32') return this._windowsSapi(text);
    if (process.platform === 'darwin') return this._macosSay(text);
    throw new Error(`No built-in TTS voice on ${process.platform} — set an ElevenLabs API key or run Voicebox`);
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

  // Windows' equivalent of the `say` path (#18): SAPI 5 through PowerShell's
  // System.Speech, which is present on every Windows install with nothing to
  // download. Renders straight to a 16-bit 22.05kHz mono WAV — the same shape
  // _macosSay returns after afconvert — so callers can't tell the two apart.
  //
  // The utterance goes through a temp .txt rather than the command line: it's
  // arbitrary model output, and a file means no quoting rules, no length cap,
  // and nothing that could be read as script. See system-voices.js.
  async _windowsSapi(text) {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const { sapiRenderScript, powerShellArgs } = require('./system-voices.js');

    // pid + random, for the same reason as _macosSay: os.tmpdir() is shared by
    // every bot on the machine, so a timestamp alone collides across profiles.
    const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const txtPath = path.join(os.tmpdir(), `vibeconf-tts-${uniq}.txt`);
    const wavPath = path.join(os.tmpdir(), `vibeconf-tts-${uniq}.wav`);

    try {
      fs.writeFileSync(txtPath, text, 'utf8');
      const script = sapiRenderScript({
        textPath: txtPath,
        wavPath,
        voice: this.macosVoice, // stored key is historical; it holds the SAPI name here
      });
      // PowerShell's cold start is ~0.5-1s on top of synthesis, so this gets a
      // longer leash than `say`'s 15s.
      try {
        execFileSync('powershell.exe', powerShellArgs(script), { timeout: 20000, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        // execFileSync's own message is just "Command failed"; PowerShell's is
        // on stderr, and it's the only thing that says WHICH part broke.
        const detail = String(err.stderr || '').trim().split('\n')[0] || err.message;
        throw new Error(`Windows SAPI synthesis failed: ${detail}`);
      }

      if (!fs.existsSync(wavPath)) throw new Error('Windows SAPI wrote no audio file');
      const buffer = fs.readFileSync(wavPath);
      if (!buffer.length) throw new Error('Windows SAPI produced an empty WAV');
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } finally {
      try { fs.unlinkSync(txtPath); } catch {}
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
