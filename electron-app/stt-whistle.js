// stt-whistle.js — Whistle (Cactus Compute), on-device speech-to-text in WASM
// (#845). The engine AudioTranscription uses to hear calls without captions.
//
// Why this engine: cross-platform (Mac, Windows, Linux), no native helper, no
// API key, audio stays on the machine. Benchmarked in #845 against Apple's
// on-device engine and the platforms' own captions: 6.1% WER vs Meet captions
// with speech gating + a pinned language + names as keywords, and 96% exact on
// the 396-name lane with the name as a keyword (0 false insertions). ~10-50x
// faster than realtime on Apple silicon, single thread.
//
// Artifacts are pinned to immutable Hugging Face revisions and SHA-256 checked
// (same pins as the prior art, panticonic/vibestudio-base extensions/speech).
// Downloaded once on first use (~18 MB) into userData; never bundled, so the
// app download doesn't grow for people who never use it.
//
// The engine is synchronous and not thread-safe, so it lives in ONE worker
// thread: transcriptions queue there and never block the main process. The
// worker source is an eval'd string so it loads the same way from an asar.

const { Worker } = require('node:worker_threads');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENGINE = 'https://huggingface.co/Cactus-Compute/needle3/resolve/2ae11323dc000f5e70c49f7403efa6af12ba9e67';
const MODEL = 'https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251';
const ARTIFACTS = [
  { name: 'needle.cjs', url: `${ENGINE}/wasm/needle.js`, sha256: '964681b2a5ec3c4db2f06e45a5b60c8981a7d4ab4cac16ef6bf5b1988657a5f1' },
  { name: 'needle.wasm', url: `${ENGINE}/wasm/needle.wasm`, sha256: 'c43f48e11f302087250d1e406024956781cd2f02595a5e343b3d7ddd5ef707fa' },
  { name: 'whistle.cact', url: `${MODEL}/whistle.cact`, sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb' },
  { name: 'LICENSE', url: `${MODEL}/LICENSE`, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
];
const ARTIFACT_ID = createHash('sha256').update(JSON.stringify(ARTIFACTS)).digest('hex').slice(0, 16);

// Whistle's languages. Anything else transcribes with auto-detect, which #845
// found drifts (German phrases on an English call), so callers should know.
const LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'];

/** BCP-47 ('de-DE', 'en') → a Whistle language code, or null (auto-detect). */
function whistleLanguage(tag) {
  const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(base) ? base : null;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Download + verify into <root>/<artifactId>/. Resolves the directory. */
async function prepareArtifacts(root, { progress = () => {}, fetchImpl = fetch } = {}) {
  const dir = path.join(root, ARTIFACT_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const a of ARTIFACTS) {
    const dest = path.join(dir, a.name);
    try {
      if (sha256(fs.readFileSync(dest)) === a.sha256) continue;
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    progress(`Downloading speech model: ${a.name}`);
    const res = await fetchImpl(a.url);
    if (!res.ok) throw new Error(`Whistle download failed (${res.status}): ${a.name}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== a.sha256) throw new Error(`Whistle checksum mismatch: ${a.name}`);
    const tmp = `${dest}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, dest); // a partial download never becomes the artifact
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  return dir;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const path = require('node:path');
(async () => {
  const engine = await require(path.join(workerData, 'needle.cjs'))({
    wasmBinary: readFileSync(path.join(workerData, 'needle.wasm')),
  });
  const alloc = (n) => { const p = engine._malloc(n); if (!p) throw new Error('Whistle allocation failed'); return p; };
  const check = (s) => { if (s < 0) throw new Error(engine.UTF8ToString(engine._needle_last_error()) || 'Whistle inference failed'); };
  const cstr = (s) => { const b = Buffer.from(s + '\0', 'utf8'); const p = alloc(b.length); engine.HEAPU8.set(b, p); return p; };
  const weights = readFileSync(path.join(workerData, 'whistle.cact'));
  const m = alloc(weights.length);
  try { engine.HEAPU8.set(weights, m); check(engine._needle_load(m, BigInt(weights.length))); } finally { engine._free(m); }
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', ({ id, audio, language, keywords }) => {
    const out = alloc(65536), inp = alloc(Math.max(4, audio.length * 4));
    const lang = language ? cstr(language) : 0;
    const kws = keywords && keywords.length ? cstr(keywords.join('\n')) : 0;
    try {
      new Float32Array(engine.HEAPU8.buffer, inp, audio.length).set(audio);
      const t0 = Date.now();
      check(engine._needle_transcribe(inp, audio.length, lang, kws, 0, out, 65536));
      const r = JSON.parse(engine.UTF8ToString(out));
      parentPort.postMessage({ type: 'result', id, text: String(r.text || ''), language: String(r.language || ''), ms: Date.now() - t0 });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id, message: err && err.message || String(err) });
    } finally {
      engine._free(out); engine._free(inp); if (lang) engine._free(lang); if (kws) engine._free(kws);
    }
  });
})().catch((err) => parentPort.postMessage({ type: 'fatal', message: err && err.message || String(err) }));
`;

class WhistleEngine {
  /** @param {{ root: string, log?: Function }} opts  root: where artifacts are cached */
  constructor({ root, log = () => {} }) {
    this.root = root;
    this.log = log;
    this._worker = null;
    this._ready = null;
    this._pending = new Map();
    this._seq = 0;
  }

  static get id() { return 'whistle'; }

  /** Download (first time) and load. Idempotent; resolves when transcribe() can run. */
  ready() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const t0 = Date.now();
      const dir = await prepareArtifacts(this.root, { progress: (m) => this.log(m) });
      await new Promise((resolve, reject) => {
        const w = new Worker(WORKER_SOURCE, { eval: true, workerData: dir });
        this._worker = w;
        w.on('message', (msg) => {
          if (msg.type === 'ready') return resolve();
          if (msg.type === 'fatal') return reject(new Error(msg.message));
          const p = this._pending.get(msg.id);
          if (!p) return;
          this._pending.delete(msg.id);
          if (msg.type === 'result') p.resolve({ text: msg.text.trim(), language: msg.language, ms: msg.ms });
          else p.reject(new Error(msg.message));
        });
        w.on('error', (err) => { reject(err); this._failAll(err); });
        w.on('exit', (code) => { if (code !== 0) this._failAll(new Error(`Whistle worker exited (${code})`)); this._worker = null; this._ready = null; });
      });
      this.log(`[stt] Whistle ready in ${Date.now() - t0} ms`);
    })();
    this._ready.catch(() => { this._ready = null; });
    return this._ready;
  }

  /**
   * @param {Float32Array} audio 16 kHz mono, <= 30 s
   * @param {{ language?: string|null, keywords?: string[] }} [opts]
   * @returns {Promise<{ text: string, language: string, ms: number }>}
   */
  async transcribe(audio, { language = null, keywords = [] } = {}) {
    await this.ready();
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, audio, language, keywords });
    });
  }

  _failAll(err) {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  async close() {
    const w = this._worker;
    this._worker = null;
    this._ready = null;
    this._failAll(new Error('Whistle engine closed'));
    if (w) await w.terminate();
  }
}

module.exports = { WhistleEngine, prepareArtifacts, whistleLanguage, ARTIFACTS, LANGUAGES };
