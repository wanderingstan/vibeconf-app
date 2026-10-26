// twilio-call.js (#882): the phone number's gate, its access tokens, and the
// Twilio calls that deploy the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tw = require('../electron-app/twilio-call.js');

const AC = 'AC' + 'a'.repeat(32);
const SK = 'SK' + 'b'.repeat(32);
const SECRET = 'not-a-real-secret';

test('the access token is a signed JWT granting incoming calls only, to this bot\'s client', () => {
  const token = tw.mintAccessToken({ accountSid: AC, apiKeySid: SK, apiKeySecret: SECRET, identity: 'vibeconf-default', now: 1_700_000_000_000 });
  const [h, p, sig] = token.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.deepEqual(dec(h), { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
  const payload = dec(p);
  assert.equal(payload.iss, SK);
  assert.equal(payload.sub, AC);
  assert.equal(payload.exp - payload.iat, 3600);
  assert.deepEqual(payload.grants, { identity: 'vibeconf-default', voice: { incoming: { allow: true } } });
  const expected = createHmac('sha256', SECRET).update(h + '.' + p).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sig, expected);
  assert.throws(() => tw.mintAccessToken({ accountSid: AC, apiKeySid: SK, identity: 'x' }), /missing Twilio credentials/);
});

test('client identity is per bot profile and URL-safe', () => {
  assert.equal(tw.clientIdentity('Default'), 'vibeconf-default');
  assert.equal(tw.clientIdentity('bot 8!'), 'vibeconf-bot-8-');
});

const states = (def) => Object.fromEntries(def.states.map((s) => [s.name, s]));

test('the gate rejects everyone unless there is an allowlist AND a passcode of 4+ digits', () => {
  for (const args of [{ allowlist: [], passcode: '1234' }, { allowlist: ['+19175752435'], passcode: '' }, { allowlist: ['+19175752435'], passcode: '12' }]) {
    const def = tw.flowDefinition({ ...args, identity: 'vibeconf-default' });
    const s = states(def);
    assert.equal(s.Trigger.transitions.find((t) => t.event === 'incomingCall').next, 'reject', JSON.stringify(args));
    assert.equal(s.connect_bot, undefined, 'no path to the bot at all');
  }
});

test('the gate: allowlisted number, then the keypad passcode, then the bot', () => {
  const def = tw.flowDefinition({ allowlist: ['+1 (917) 575-2435', '4915112345678'], passcode: '24-68', identity: 'vibeconf-default' });
  const s = states(def);
  assert.equal(s.Trigger.transitions.find((t) => t.event === 'incomingCall').next, 'check_caller');
  const allow = s.check_caller.transitions.find((t) => t.event === 'match');
  assert.equal(allow.next, 'ask_passcode');
  assert.equal(allow.conditions[0].type, 'matches_any_of');
  assert.equal(allow.conditions[0].value, '+19175752435,+4915112345678');
  assert.equal(s.check_caller.transitions.find((t) => t.event === 'noMatch').next, 'reject');
  assert.equal(s.ask_passcode.properties.finish_on_key, '#');
  const ok = s.check_passcode.transitions.find((t) => t.event === 'match');
  assert.equal(ok.next, 'connect_bot');
  assert.deepEqual([ok.conditions[0].type, ok.conditions[0].value], ['equal_to', '2468']);
  assert.equal(s.check_passcode.transitions.find((t) => t.event === 'noMatch').next, 'wrong_passcode');
  for (const e of ['speech', 'timeout']) assert.equal(s.ask_passcode.transitions.find((t) => t.event === e).next, 'wrong_passcode');
  assert.deepEqual([s.connect_bot.properties.noun, s.connect_bot.properties.to], ['client', 'vibeconf-default']);
});

// A fake Twilio API: records requests, serves numbers and flows.
function fakeTwilio({ numbers = [{ sid: 'PN1', phone_number: '+19705550100', voice_url: '' }], flows = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
    calls.push({ method: opts.method, url, body, auth: opts.headers?.Authorization });
    const json = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (url.includes('/IncomingPhoneNumbers.json?')) {
      const want = decodeURIComponent(url.split('PhoneNumber=')[1]);
      return json(200, { incoming_phone_numbers: numbers.filter((n) => n.phone_number === want) });
    }
    if (url.endsWith('/v2/Flows?PageSize=100')) return json(200, { flows });
    if (url.endsWith('/v2/Flows') && opts.method === 'POST') return json(201, { sid: 'FWnew' });
    if (/\/v2\/Flows\/FW/.test(url)) return url.endsWith('FWgone') ? json(404, { message: 'not found' }) : json(200, { sid: url.split('/').pop() });
    if (/IncomingPhoneNumbers\/PN1\.json$/.test(url)) return json(200, { sid: 'PN1' });
    return json(400, { message: 'unexpected ' + url });
  };
  return { calls, fetchImpl };
}
const creds = { accountSid: AC, apiKeySid: SK, apiKeySecret: SECRET };
const gateArgs = (fetchImpl, extra = {}) => ({ creds, phone: '19705550100', identity: 'vibeconf-default', allowlist: ['19175752435'], passcode: '2468', flowName: 'Vibeconferencing gate (Default)', fetchImpl, ...extra });

test('provisioning creates the flow the first time and points the number at it', async () => {
  const t = fakeTwilio();
  const r = await tw.provisionGate(gateArgs(t.fetchImpl));
  assert.deepEqual(r, { flowSid: 'FWnew', numberSid: 'PN1' });
  const create = t.calls.find((c) => c.url.endsWith('/v2/Flows') && c.method === 'POST');
  assert.equal(create.body.Status, 'published');
  assert.equal(JSON.parse(create.body.Definition).initial_state, 'Trigger');
  const point = t.calls.find((c) => /IncomingPhoneNumbers\/PN1\.json$/.test(c.url));
  assert.equal(point.body.VoiceUrl, `https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/FWnew`);
  assert.ok(t.calls.every((c) => c.auth === 'Basic ' + Buffer.from(`${SK}:${SECRET}`).toString('base64')), 'API key auth on every request');
});

test('provisioning updates the existing flow, and recreates it if it was deleted', async () => {
  const t = fakeTwilio({ numbers: [{ sid: 'PN1', phone_number: '+19705550100', voice_url: `https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/FWabc` }] });
  assert.deepEqual(await tw.provisionGate(gateArgs(t.fetchImpl, { flowSid: 'FWabc' })), { flowSid: 'FWabc', numberSid: 'PN1' });
  assert.ok(!t.calls.some((c) => /IncomingPhoneNumbers\/PN1\.json$/.test(c.url)), 'already pointed: no write');
  const t2 = fakeTwilio();
  assert.equal((await tw.provisionGate(gateArgs(t2.fetchImpl, { flowSid: 'FWgone' }))).flowSid, 'FWnew');
});

test('provisioning refuses a number that is not on the account', async () => {
  const t = fakeTwilio({ numbers: [] });
  await assert.rejects(() => tw.provisionGate(gateArgs(t.fetchImpl)), /is not a number on this Twilio account/);
});

test('the gate and the credentials are out of the agent\'s reach, and main decides before answering', () => {
  const schema = readFileSync(join(root, 'electron-app/preferences-schema.js'), 'utf8');
  assert.doesNotMatch(schema, /twilio/i, 'no Twilio key is an agent-settable preference');
  const preload = readFileSync(join(root, 'electron-app/preload-twilio.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.invoke\('calling-app-incoming-call', \{ app: 'twilio', caller \}\)/);
  assert.doesNotMatch(preload, /apiKeySecret|parseAllowlist|isCallerAllowed/, 'the page never holds the secret or decides');
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('twilio-token'/);
  assert.match(main, /twilio: \{ label: 'Phone', preload: 'preload-twilio\.js'/);
});
