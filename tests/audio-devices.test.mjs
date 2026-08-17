// audio-devices.test.mjs — is there an acoustic path from the speakers back
// into the microphone? (#422/#378)
//
// This decides one thing, and it is the thing the whole echo problem turns on.
// A person on SPEAKERS hears the bot, their microphone hears it too, Meet
// animates THEIR speaking indicator, and the bot reads its own voice as that
// person interrupting — then cuts itself off. A person on headphones cannot
// produce that at all.
//
// The classification is fiddly in a way that invites a wrong shortcut: wired
// headphones report the SAME `builtin` transport as the internal speakers, so
// transport alone cannot separate them. Most of these tests are real device
// names and transports as macOS actually reports them.
//
// Run: node --test tests/audio-devices.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseAudioDevices, formatAudioDevices, hasEchoPath, sampleAudioDevices } =
  require('../electron-app/audio-devices.js');

// Shaped exactly like `system_profiler SPAudioDataType -json`.
const profile = (devices) => JSON.stringify({
  SPAudioDataType: [{
    _items: devices.map(([name, transport, role]) => ({
      _name: name,
      coreaudio_device_transport: transport,
      ...(role === 'out' ? { coreaudio_default_audio_output_device: 'spaudio_yes' } : {}),
      ...(role === 'in' ? { coreaudio_default_audio_input_device: 'spaudio_yes' } : {}),
    })),
  }],
});

test('built-in speakers plus built-in mic is the echo-prone case', () => {
  // The configuration that produced #378 on a live call.
  const p = parseAudioDevices(profile([
    ['MacBook Pro Speakers', 'coreaudio_device_type_builtin', 'out'],
    ['MacBook Pro Microphone', 'coreaudio_device_type_builtin', 'in'],
  ]));
  assert.equal(p.echoPath, true);
  assert.equal(p.output.name, 'MacBook Pro Speakers');
  assert.equal(p.output.transport, 'builtin');
});

test('wired headphones are NOT an echo path, despite the builtin transport', () => {
  // The trap. macOS reports the 3.5mm jack as `builtin`, identical to the
  // internal speakers, so anything keying on transport alone calls this
  // echo-prone and is wrong for every wired-headset user.
  const p = parseAudioDevices(profile([
    ['External Headphones', 'coreaudio_device_type_builtin', 'out'],
    ['MacBook Pro Microphone', 'coreaudio_device_type_builtin', 'in'],
  ]));
  assert.equal(p.output.transport, 'builtin', 'same transport as the speakers');
  assert.equal(p.echoPath, false, 'and still no acoustic path');
});

test('AirPods and named headsets are not an echo path either', () => {
  for (const [name, transport] of [
    ["Stan's AirPods Pro", 'coreaudio_device_transport_bluetooth'],
    ['Sony WH-1000XM5 (Headphones)', 'coreaudio_device_transport_bluetooth'],
    ['Bose QC 45', 'coreaudio_device_transport_bluetooth'],
  ]) {
    const p = parseAudioDevices(profile([[name, transport, 'out']]));
    assert.equal(p.echoPath, false, `${name} should not be echo-prone`);
  }
});

test('a device that does not say what it is answers UNKNOWN, not a guess', () => {
  // "Jabra Evolve2 65" is a headset. "Jabra Speak 510" is a speakerphone. Both
  // arrive over USB and neither name declares which — so the first is unknown
  // and only the second is called echo-prone. Guessing either way would be
  // worse than admitting it: a wrong TRUE marks a headphones-only call as echo
  // evidence, and a wrong FALSE hides a real echo case. The question asked in
  // the call is what settles it.
  const unknown = parseAudioDevices(profile([['Jabra Evolve2 65', 'coreaudio_device_transport_usb', 'out']]));
  assert.equal(unknown.echoPath, null);
  assert.match(formatAudioDevices(unknown, 'join'), /echo path unknown/);

  const speakerphone = parseAudioDevices(profile([['Jabra Speak 510', 'coreaudio_device_transport_usb', 'out']]));
  assert.equal(speakerphone.echoPath, true);
});

test('speakerphones and monitors DO radiate into the room', () => {
  for (const [name, transport] of [
    ['Studio Display Speakers', 'coreaudio_device_transport_displayport'],
    ['Jabra Speak 510', 'coreaudio_device_transport_usb'],
    ['External Speakers', 'coreaudio_device_type_builtin'],
  ]) {
    const p = parseAudioDevices(profile([[name, transport, 'out']]));
    assert.equal(p.echoPath, true, `${name} should be echo-prone`);
  }
});

test('an unknown output reports unknown, not "no"', () => {
  // The failure direction matters. Claiming "no echo path" for a device we
  // could not read would quietly mark a call as clean evidence when it is not.
  assert.equal(hasEchoPath(null), null);
  assert.equal(hasEchoPath({ transport: 'usb' }), null, 'no name = no verdict');
});

test('malformed or empty output yields null rather than throwing', () => {
  // This runs on the join path. It must never be the reason a call fails.
  for (const bad of ['', 'not json', '{}', '{"SPAudioDataType":[]}', null, undefined]) {
    assert.equal(parseAudioDevices(bad), null);
  }
  assert.equal(formatAudioDevices(null, 'join'), null);
});

test('the logged line carries its own caveat', () => {
  // A bare "echo path LIKELY" read a year later would look like a measurement
  // of the CALL, when it is a guess about one machine's OS defaults — and Meet
  // has its own device picker that can disagree.
  const p = parseAudioDevices(profile([
    ['MacBook Pro Speakers', 'coreaudio_device_type_builtin', 'out'],
    ['MacBook Pro Microphone', 'coreaudio_device_type_builtin', 'in'],
  ]));
  const line = formatAudioDevices(p, 'join');
  assert.match(line, /\[audio-devices\] join:/);
  assert.match(line, /echo path LIKELY/);
  assert.match(line, /Meet may use different devices/);
});

test('non-macOS hosts sample nothing instead of guessing', async () => {
  assert.equal(await sampleAudioDevices({ platform: 'win32' }), null);
  assert.equal(await sampleAudioDevices({ platform: 'linux' }), null);
});
