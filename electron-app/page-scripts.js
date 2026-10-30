// page-scripts.js: puts the media scripts into a call page, from its preload.
// The one copy of what each call preload (Meet, Zoom, Teams, Slack, WhatsApp,
// Telegram, Twilio) used to do by hand. Phase 2 of the calls library.
//
// Order matters:
//   1. the helpers the page scripts read off globalThis, because they run in
//      the page world and can't require: avatar posture math, and the emoji
//      set resolvers (#316, #828; they need fs);
//   2. page-inject.js, the media core (virtual mic and camera, the
//      getUserMedia / getDisplayMedia overrides, the audio taps). It must run
//      before the page's own scripts can ask for media;
//   3. the app's page plugins, which use the core through
//      window.__vibeconfMedia: the emoji avatar and the realtime voice.
//
// contextIsolation is off on every call view, so the preload's global IS the
// page's: an indirect eval here defines the scripts in the page world.

const fs = require('fs');
const path = require('path');

const CORE = 'page-inject.js';
const PLUGINS = ['page-avatar.js', 'page-realtime-voice.js'];

function evalFile(dir, file) {
  (0, eval)(fs.readFileSync(path.join(dir, file), 'utf-8'));
}

// tag: the preload's log prefix, e.g. '[zoom]'. Returns true when the core
// loaded (a plugin failing on its own never stops the call's media).
function injectPageScripts({ tag, dir = __dirname } = {}) {
  try {
    globalThis.__vibeAvatarPosture = require('./avatar-posture.js');
  } catch (err) {
    console.error(tag, 'avatar-posture.js failed to load (face stays centred):', err.message);
  }
  try {
    require('./emoji-assets.js').installPageResolvers(globalThis, dir);
  } catch (err) {
    // Every face still draws, as native emoji.
    console.error(tag, 'emoji resolvers failed (faces stay native):', err.message);
    globalThis.__vibeEmojiDataUri = () => null;
    globalThis.__vibeEmojiFontBytes = () => null;
    globalThis.__vibeEmojiDirUri = () => null;
    globalThis.__vibeEmojiDirCount = () => 0;
  }

  try {
    evalFile(dir, CORE);
    console.log(tag, CORE + ' loaded (media patch, before page scripts)');
  } catch (err) {
    console.error(tag, 'Failed to load ' + CORE + ':', err.message);
    return false;
  }
  for (const file of PLUGINS) {
    if (!fs.existsSync(path.join(dir, file))) continue;
    try {
      evalFile(dir, file);
    } catch (err) {
      console.error(tag, 'Failed to load ' + file + ' (the call media is unaffected):', err.message);
    }
  }
  return true;
}

module.exports = { injectPageScripts, CORE, PLUGINS };
