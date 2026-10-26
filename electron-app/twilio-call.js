// Phone calls through Twilio (#882): a real number the bot answers.
//
// Shape (no public server needed):
//   caller → the bot's Twilio number → a Studio Flow (the GATE, run by Twilio)
//          → <Dial><Client>identity</Client> → the bot's call view, where
//            renderer/twilio-phone.html runs Twilio's Voice SDK as that client.
//
// The gate is deterministic and lives on Twilio's side, so nothing reaches
// the bot (no audio, no transcript, no agent) until it passes:
//   1. the caller's number must be on the allowlist,
//   2. then they must enter the passcode on the keypad.
// Both are set only in the app's Settings and written into the flow by main;
// they are not agent-settable preferences, and the agent never sees them.
// The bot re-checks the caller's number before it answers (defence in depth).
//
// Credentials: the account SID plus an API key (SID + secret) from the bot's
// Settings. The secret signs short-lived access tokens here in main; it never
// reaches a page.

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { phoneDigits, parseAllowlist, isCallerAllowed } = require('./whatsapp-call');

const WEB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'twilio-phone.html')).href;
const TOKEN_TTL_SECONDS = 3600;
const FLOW_NAME_PREFIX = 'Vibeconferencing gate';

function roomCodeForCaller(phone) {
  const d = phoneDigits(phone);
  return d ? `phone-${d}` : null;
}

// The Voice SDK client name the flow dials. One per bot profile.
function clientIdentity(profile) {
  return 'vibeconf-' + String(profile || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
}

const e164 = (digits) => '+' + digits;

// ---------------------------------------------------------------------------
// Access token (a JWT, HS256 over the API key secret), with a Voice grant
// that only allows INCOMING calls to this client.
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function mintAccessToken({ accountSid, apiKeySid, apiKeySecret, identity, ttlSeconds = TOKEN_TTL_SECONDS, now = Date.now() }) {
  if (!accountSid || !apiKeySid || !apiKeySecret || !identity) throw new Error('missing Twilio credentials');
  const iat = Math.floor(now / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${apiKeySid}-${iat}`,
    iss: apiKeySid,
    sub: accountSid,
    iat,
    exp: iat + ttlSeconds,
    grants: { identity, voice: { incoming: { allow: true } } },
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', apiKeySecret).update(unsigned).digest();
  return unsigned + '.' + b64url(sig);
}

// ---------------------------------------------------------------------------
// The gate, as a Studio Flow definition. With no allowlist or no passcode it
// rejects everyone: a number reachable by anyone must never fall open.
// ---------------------------------------------------------------------------
function flowDefinition({ allowlist = [], passcode = '', identity }) {
  const allowed = [...allowlist].map(phoneDigits).filter(Boolean).map(e164);
  const code = String(passcode || '').replace(/\D/g, '');
  const open = allowed.length > 0 && code.length >= 4 && !!identity;
  const at = (x, y) => ({ offset: { x, y } });
  const states = [
    {
      name: 'Trigger',
      type: 'trigger',
      transitions: [
        { event: 'incomingMessage' },
        { event: 'incomingCall', next: open ? 'check_caller' : 'reject' },
        { event: 'incomingConversationMessage' },
        { event: 'incomingRequest' },
        { event: 'incomingParent' },
      ],
      properties: at(0, 0),
    },
    {
      name: 'reject',
      type: 'say-play',
      transitions: [{ event: 'audioComplete' }],
      properties: { ...at(-400, 400), say: 'Sorry, this number cannot take your call. Goodbye.', loop: 1 },
    },
  ];
  if (open) {
    states.push(
      {
        name: 'check_caller',
        type: 'split-based-on',
        transitions: [
          { event: 'noMatch', next: 'reject' },
          {
            event: 'match',
            next: 'ask_passcode',
            conditions: [{ friendly_name: 'allowed caller', arguments: ['{{trigger.call.From}}'], type: 'matches_any_of', value: allowed.join(',') }],
          },
        ],
        properties: { ...at(0, 200), input: '{{trigger.call.From}}' },
      },
      {
        name: 'ask_passcode',
        type: 'gather-input-on-call',
        transitions: [
          { event: 'keypress', next: 'check_passcode' },
          { event: 'speech', next: 'wrong_passcode' },
          { event: 'timeout', next: 'wrong_passcode' },
        ],
        properties: {
          ...at(0, 400),
          say: 'Please enter your passcode, then press pound.',
          loop: 1,
          finish_on_key: '#',
          timeout: 10,
          stop_gather: true,
          gather_language: 'en-US',
          speech_timeout: 'auto',
          profanity_filter: 'true',
        },
      },
      {
        name: 'check_passcode',
        type: 'split-based-on',
        transitions: [
          { event: 'noMatch', next: 'wrong_passcode' },
          {
            event: 'match',
            next: 'connect_bot',
            conditions: [{ friendly_name: 'passcode', arguments: ['{{widgets.ask_passcode.Digits}}'], type: 'equal_to', value: code }],
          },
        ],
        properties: { ...at(0, 600), input: '{{widgets.ask_passcode.Digits}}' },
      },
      {
        name: 'wrong_passcode',
        type: 'say-play',
        transitions: [{ event: 'audioComplete' }],
        properties: { ...at(400, 800), say: 'Sorry, that is not right. Goodbye.', loop: 1 },
      },
      {
        name: 'connect_bot',
        type: 'connect-call-to',
        transitions: [{ event: 'callCompleted' }, { event: 'hangup' }],
        properties: { ...at(0, 800), noun: 'client', to: identity, caller_id: '{{trigger.call.From}}', timeout: 30 },
      },
    );
  }
  return {
    description: 'Vibeconferencing: caller allowlist + keypad passcode, then the bot. Written by the app; edits here are overwritten.',
    states,
    initial_state: 'Trigger',
    flags: { allow_concurrent_calls: true },
  };
}

// ---------------------------------------------------------------------------
// Twilio REST (API key auth). `fetchImpl` is injectable for tests.
// ---------------------------------------------------------------------------
function makeClient({ accountSid, apiKeySid, apiKeySecret, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64');
  async function call(method, url, form) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(body && body.message) || 'request failed'}`);
    return body;
  }
  const api = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  return {
    // The account's number record for `phone`, or null.
    async findNumber(phone) {
      const r = await call('GET', `${api}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164(phoneDigits(phone)))}`);
      return (r && r.incoming_phone_numbers && r.incoming_phone_numbers[0]) || null;
    },
    async listFlows() {
      const r = await call('GET', 'https://studio.twilio.com/v2/Flows?PageSize=100');
      return (r && r.flows) || [];
    },
    async createFlow(name, definition) {
      return call('POST', 'https://studio.twilio.com/v2/Flows', { FriendlyName: name, Status: 'published', Definition: JSON.stringify(definition) });
    },
    async updateFlow(sid, definition) {
      return call('POST', `https://studio.twilio.com/v2/Flows/${sid}`, { Status: 'published', Definition: JSON.stringify(definition) });
    },
    async pointNumberAt(numberSid, voiceUrl) {
      return call('POST', `${api}/IncomingPhoneNumbers/${numberSid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: 'POST' });
    },
  };
}

function flowWebhook(accountSid, flowSid) {
  return `https://webhooks.twilio.com/v1/Accounts/${accountSid}/Flows/${flowSid}`;
}

// Create or update this bot's gate flow and point its number at it.
// Returns { flowSid, numberSid }.
async function provisionGate({ creds, phone, identity, allowlist, passcode, flowSid, flowName, fetchImpl }) {
  const client = makeClient({ ...creds, fetchImpl });
  const number = await client.findNumber(phone);
  if (!number) throw new Error(`${e164(phoneDigits(phone) || '')} is not a number on this Twilio account`);
  const definition = flowDefinition({ allowlist, passcode, identity });
  let sid = flowSid;
  if (sid) {
    try { await client.updateFlow(sid, definition); } catch (err) { if (!/404/.test(err.message)) throw err; sid = null; }
  }
  if (!sid) {
    const existing = (await client.listFlows()).find((f) => f.friendly_name === flowName);
    sid = existing ? existing.sid : null;
    if (sid) await client.updateFlow(sid, definition);
    else sid = (await client.createFlow(flowName, definition)).sid;
  }
  const hook = flowWebhook(creds.accountSid, sid);
  if (number.voice_url !== hook) await client.pointNumberAt(number.sid, hook);
  return { flowSid: sid, numberSid: number.sid };
}

module.exports = {
  WEB_URL,
  FLOW_NAME_PREFIX,
  phoneDigits,
  parseAllowlist,
  isCallerAllowed,
  roomCodeForCaller,
  clientIdentity,
  mintAccessToken,
  flowDefinition,
  makeClient,
  flowWebhook,
  provisionGate,
};
