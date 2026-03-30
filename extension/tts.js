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
    this.provider = config.provider || 'elevenlabs';
    this.apiKey = config.apiKey || '';
    this.voiceId = config.voiceId || 'CwhRBWXzGAHq8TQ4Fs17'; // "Roger" (premade, free tier)
    this.modelId = config.modelId || 'eleven_v2_flash'; // fast model
  }

  updateConfig(config) {
    if (config.provider) this.provider = config.provider;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.voiceId) this.voiceId = config.voiceId;
    if (config.modelId) this.modelId = config.modelId;
  }

  async synthesize(text) {
    if (!text?.trim()) return null;

    switch (this.provider) {
      case 'elevenlabs':
        return this._elevenlabs(text);
      // Future providers:
      // case 'kokoro':
      //   return this._kokoro(text);
      // case 'openai':
      //   return this._openai(text);
      default:
        throw new Error(`Unknown TTS provider: ${this.provider}`);
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

  // Future: local Kokoro.js TTS
  // async _kokoro(text) {
  //   // Would run in an offscreen document or the whiteboard tab
  //   // const { KokoroTTS } = await import('kokoro-js');
  //   // const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX');
  //   // const audio = await tts.generate(text, { voice: 'af_heart' });
  //   // return audio.toArrayBuffer();
  // }
}

// Make available to service worker and other extension contexts
if (typeof globalThis !== 'undefined') {
  globalThis.TTSProvider = TTSProvider;
}
