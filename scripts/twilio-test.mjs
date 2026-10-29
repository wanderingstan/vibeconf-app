#!/usr/bin/env node
// twilio-test.mjs — agent-less end-to-end test for the phone bot (#882).
//
// A phone bot is answered, not joined, so this test places the call itself:
// Twilio's REST API dials the bot's number with a scripted caller (TwiML) that
// waits for the gate's prompt, keys the passcode, says a known phrase twice,
// stays on the line while the bot talks, then hangs up.
//
//   answer      the bot gets past its own gate and reaches in-call
//   hear        the bot transcribes the caller's phrase (audio tap + STT;
//               phones have no captions)
//   speak       the bot's speech is accepted while in the call (not queued)
//   hang-up     the caller ending the call takes the bot out of the call
//   billing     Twilio records the call as completed, with a duration
//
// PREREQ: the test-twilio-1 profile, set up once with the Twilio account's
// credentials, its own test number, the caller ID below on its allowlist, and
// a passcode (never the production bot's number: provisioning rewrites the
// number's flow). Then:
//   scripts/spawn-test-fleet.sh 1 --twilio
//   node scripts/twilio-test.mjs --bots Alice:7901
//
// --caller is the From number (default VIBECONF_TWILIO_CALLER): any number on
// the same Twilio account. It is only caller ID; nothing on that number changes.
// Each run is a real call of under a minute, billed at Twilio's per-minute rate.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const PROFILE = arg('profile', 'test-twilio-1');
const [botSpec] = arg('bots', 'Alice:7901').split(',');
const [botName, botPort] = botSpec.split(':');

const cfgPath = join(homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'profiles', PROFILE, 'agent', 'config.json');
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) {
  console.error(`Cannot read ${PROFILE}'s settings (${e.message}). Set the profile up first; see the header.`);
  process.exit(2);
}
const { twilioAccountSid: SID, twilioApiKeySid: KEY, twilioApiKeySecret: SECRET, twilioPasscode: PASSCODE } = cfg;
const TO = '+' + String(cfg.twilioPhoneNumber || '').replace(/\D/g, '');
const CALLER = arg('caller', process.env.VIBECONF_TWILIO_CALLER || '');
if (!SID || !KEY || !SECRET || TO.length < 8 || !PASSCODE || !CALLER) {
  console.error('Missing Twilio settings in the profile, or no --caller / VIBECONF_TWILIO_CALLER.');
  process.exit(2);
}

// The word the bot has to hear. Unusual enough that a mis-transcription of
// the gate's own prompt can't produce it.
const WORD = 'pineapple';
// Timing, measured on the first run: the bot is connected about 28 s into the
// call (gate prompt, keypad, the flow's <Dial>, the bot's own allowlist check).
// Anything said before that never reaches it, so the caller waits well past
// that, then repeats the word across ~20 s.
const twiml = [
  '<Response>',
  '<Pause length="5"/>',                      // the gate's 2 s break + prompt
  `<Play digits="${PASSCODE}#"/>`,
  '<Pause length="30"/>',                     // dial the client, bot answers
  ...[1, 2, 3].flatMap(() => [
    `<Say voice="Polly.Matthew">This is the test caller. The secret word is ${WORD}.</Say>`,
    '<Pause length="4"/>',
  ]),
  '<Pause length="10"/>',                     // let the bot finish speaking
  '<Hangup/>',
  '</Response>',
].join('');

const auth = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');
const api = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
async function twilio(method, path, form) {
  const resp = await fetch(api + path, {
    method,
    headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Twilio ${method} ${path}: ${resp.status} ${data.message || ''}`);
  return data;
}

// Room the app keys a phone call by (twilio-call.js roomCodeForCaller).
const bot = new Bot(botName, Number(botPort), 'phone-' + CALLER.replace(/\D/g, ''));
let callSid = null;

async function run() {
  console.log(`twilio-test → ${botName} on ${TO}, caller ID ${CALLER.replace(/\d(?=\d{4})/g, '•')}`);

  // 0) The bot's phone page has to be registered with Twilio before we dial,
  //    and the gate written onto the number. Both happen at app start.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await bot.ping();
    if (!up) await sleep(1000);
  }
  if (!up) { record(botName, 'botUp', false, 'local server never answered'); return; }
  await sleep(15000);

  // 1) Place the call.
  const call = await twilio('POST', '/Calls.json', { To: TO, From: CALLER, Twiml: twiml, Timeout: '30' });
  callSid = call.sid;
  record('caller', 'placeCall', true, `${call.status}`);

  // 2) Answer: through the gate and into the call.
  const answered = await bot.waitInCall({ maxMs: 45000 });
  record(botName, 'answered', answered, answered ? '' : 'not in-call 45 s after dialing (gate, allowlist, or phone page not registered?)');
  if (!answered) { try { const s = await bot.screenshot(); if (s.ok) console.log(`  📸 ${s.path}`); } catch { /* best effort */ } return; }

  // 3) Speak while the caller is certainly still on the line.
  const said = await bot.speak('Hello, this is the test bot. I can hear you.');
  const why = said?.results?.transcript?.reason || '';
  record(botName, 'speakInCall', !/queue|silent/i.test(why), why || 'accepted in-call');

  // 4) Hear: the caller's phrase, through the audio tap and STT.
  let heard = '';
  for (let i = 0; i < 4 && !new RegExp(WORD, 'i').test(heard); i++) {
    const { transcript } = await bot.waitForSpeech({ wait: 20, silence: 2 });
    heard += ' ' + transcript.map((e) => e.text || '').join(' ');
  }
  record(botName, 'hearsCaller', new RegExp(WORD, 'i').test(heard), heard.trim() ? `heard "${heard.trim().slice(0, 80)}"` : 'heard nothing');

  // 5) Hang-up: the caller's TwiML ends the call; the bot must leave it.
  let ended = false;
  for (let i = 0; i < 60 && !ended; i++) {
    await sleep(1000);
    try { ended = (await bot.status()).callStatus !== 'in-call'; } catch { /* retry */ }
  }
  record(botName, 'callEnded', ended, ended ? '' : 'still in-call 60 s after the caller should have hung up');
}

run()
  .catch((err) => { console.error('twilio-test error:', err && err.message); record('harness', 'run', false, err && err.message); })
  .finally(async () => {
    // 6) Twilio's own view of the call: completed, with a duration.
    if (callSid) {
      try {
        let c;
        for (let i = 0; i < 10; i++) {
          c = await twilio('GET', `/Calls/${callSid}.json`);
          if (c.status === 'completed' || c.status === 'failed' || c.status === 'busy' || c.status === 'no-answer') break;
          if (i === 0) await twilio('POST', `/Calls/${callSid}.json`, { Status: 'completed' }).catch(() => {}); // never leave a test call running
          await sleep(2000);
        }
        record('caller', 'callCompleted', c.status === 'completed' && Number(c.duration) > 0, `${c.status}, ${c.duration || 0} s`);
      } catch (e) { record('caller', 'callCompleted', false, e.message); }
    }
    const r = report();
    process.exit(r.fails > 0 || r.stalls > 0 ? 1 : 0);
  });
