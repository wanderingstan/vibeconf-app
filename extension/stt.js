// stt.js — Speech-to-text provider abstraction.
// Currently supports ElevenLabs Scribe. Designed to be swappable for
// local models (e.g., Whisper.cpp) in the future.
//
// Usage from service worker:
//   const stt = new STTProvider({ apiKey: '...' });
//   const result = await stt.transcribe(audioBlob);
//   // result = { text: "Hello everyone", segments: [...] }

class STTProvider {
  constructor(config = {}) {
    this.provider = config.provider || 'elevenlabs';
    this.apiKey = config.apiKey || '';
    this.modelId = config.modelId || 'scribe_v2';
  }

  updateConfig(config) {
    if (config.provider) this.provider = config.provider;
    if (config.apiKey) this.apiKey = config.apiKey;
    if (config.modelId) this.modelId = config.modelId;
  }

  async transcribe(audioBlob) {
    if (!audioBlob || audioBlob.size === 0) return null;

    switch (this.provider) {
      case 'elevenlabs':
        return this._elevenlabs(audioBlob);
      // Future:
      // case 'whisper':
      //   return this._whisper(audioBlob);
      default:
        throw new Error(`Unknown STT provider: ${this.provider}`);
    }
  }

  async _elevenlabs(audioBlob) {
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const formData = new FormData();
    formData.append('model_id', this.modelId);
    formData.append('file', audioBlob, 'audio.webm');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`ElevenLabs STT error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    return {
      text: data.text || '',
      languageCode: data.language_code,
      segments: data.words || [],
    };
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.STTProvider = STTProvider;
}
