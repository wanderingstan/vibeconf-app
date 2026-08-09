// elevenlabs-errors.js: turn an ElevenLabs API failure into something a user
// can act on.
//
// Why this exists: ElevenLabs API keys are SCOPED. A key can be perfectly valid
// for text-to-speech and still lack `voices_read`, in which case GET /v1/voices
// 401s while speaking works fine. The old code did `if (!res.ok) return []`, so
// that case looked identical to "no key set" and "account has no voices": the
// user pasted a working key, saw no voices appear, and got no explanation.
//
// The API distinguishes these for us: a 401 body carries
// `detail.status` ('missing_permissions' | 'invalid_api_key' | …) and a
// `detail.message` naming the specific permission. Pure + testable; the fetch
// lives in main.js.

// Permission an operation needs, for the "how do I fix it" half of the message.
const VOICES_READ = 'voices_read';

// Pull `detail.status` / `detail.message` out of an ElevenLabs error body.
// The body is normally { detail: { status, message } }, but `detail` is
// sometimes a bare string (and sometimes absent on gateway errors), so both
// shapes are handled rather than assumed.
function parseDetail(body) {
  const d = body && typeof body === 'object' ? body.detail : undefined;
  if (typeof d === 'string') return { status: '', message: d };
  if (d && typeof d === 'object') {
    // `code` as well as `status`: ElevenLabs sends BOTH, and they don't always
    // agree. A legacy-format key answers code=invalid_api_key with
    // status=invalid_api_key_prefix, so reading status alone missed it and the
    // whole thing fell through to the generic HTTP branch.
    return {
      status: String(d.status || ''),
      code: String(d.code || ''),
      message: String(d.message || ''),
    };
  }
  return { status: '', code: '', message: '' };
}

/**
 * Classify a failed /v1/voices response.
 *
 * @param {number} httpStatus   HTTP status code
 * @param {any}    body         parsed JSON body (or null/undefined if unparseable)
 * @returns {{kind: string, message: string, permission?: string}}
 *
 * `kind` is for code to branch on; `message` is written to be shown to a user
 * as-is. Anything unrecognized falls through to a generic 'http' rather than
 * being swallowed; an unexplained failure the user can see beats silence.
 */
function classifyVoicesError(httpStatus, body) {
  const { status, code, message } = parseDetail(body);
  const detail = `${status} ${code} ${message}`.toLowerCase();

  // Scoped key missing voices_read. Match on the status first, but fall back to
  // sniffing the message: the status string is the documented contract, the
  // message is the belt-and-braces for a wording change.
  if (status === 'missing_permissions' || /missing the permission/.test(detail)) {
    const named = /permission\s+([a-z_]+)/.exec(message || '');
    const permission = named ? named[1] : VOICES_READ;
    return {
      kind: 'missing_permissions',
      permission,
      message:
        `Your ElevenLabs key is missing the "${permission}" permission, so the app can't list your voices. ` +
        'Speaking may still work: this blocks the LIST, not synthesis (a scoped key can be missing ' +
        'that permission too). You can still use an ElevenLabs voice without the list: paste its id into ' +
        '"ElevenLabs Voice ID" in Bot Settings. The id is the last part of the voice\'s page URL on ' +
        'elevenlabs.io. ' +
        'To get the list back, edit the key at elevenlabs.io → Profile → API Keys and enable ' +
        `"${permission}" (or switch it to "Has access to all" scopes).`,
    };
  }

  // A key from before ElevenLabs moved to `sk_`-prefixed keys. It is not a typo
  // and it will never work again, so "check for a typo" is the wrong advice:
  // the only fix is generating a new one. Seen in the field: a key stored long
  // ago kept failing every ElevenLabs call, and the app only revealed it when
  // someone tried to pick a voice.
  if (status === 'invalid_api_key_prefix' || /must start with 'sk_'/.test(detail)) {
    return {
      kind: 'legacy_key',
      message:
        'Your ElevenLabs API key is in the OLD format, which ElevenLabs no longer accepts. '
        + 'every request with it fails, so no ElevenLabs voice can be used. It cannot be repaired; '
        + 'generate a new one at elevenlabs.io → Profile → API Keys (new keys start with "sk_") '
        + 'and paste it into Bot Settings.',
    };
  }

  if (status === 'invalid_api_key' || code === 'invalid_api_key' || /invalid api key/.test(detail)) {
    return { kind: 'invalid_key', message: 'That ElevenLabs API key was rejected as invalid. Check for a typo or a stale key.' };
  }

  if (status === 'quota_exceeded' || /quota/.test(detail)) {
    return { kind: 'quota', message: 'Your ElevenLabs account is out of quota, so voices could not be listed.' };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'unauthorized', message: `ElevenLabs rejected the key (HTTP ${httpStatus}). ${message}`.trim() };
  }

  if (httpStatus === 429) {
    return { kind: 'rate_limited', message: 'ElevenLabs is rate-limiting this key. Try again in a moment.' };
  }

  return {
    kind: 'http',
    message: `Couldn't list ElevenLabs voices (HTTP ${httpStatus}).${message ? ' ' + message : ''}`,
  };
}

// Network-level failure (DNS, offline, abort/timeout): no HTTP status to read.
function classifyVoicesNetworkError(err) {
  const name = String(err?.name || '');
  if (name === 'AbortError') {
    return { kind: 'timeout', message: "ElevenLabs didn't respond in time, so voices couldn't be listed." };
  }
  return { kind: 'network', message: `Couldn't reach ElevenLabs to list voices (${err?.message || 'network error'}).` };
}

module.exports = { classifyVoicesError, classifyVoicesNetworkError, VOICES_READ };
