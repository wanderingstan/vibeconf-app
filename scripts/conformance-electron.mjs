// conformance-electron.mjs: a ConformanceBot (packages/calls/conformance/
// suite.js) on the Electron host, which is the app: each bot is a running
// Vibeconferencing instance from spawn-test-fleet.sh, driven over its HTTP API
// through meet-test-lib's Bot.

import { Bot, sleep } from './meet-test-lib.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { platformFromUrl } = require('../packages/calls/core/call-target.js');

export class ElectronConformanceBot {
  constructor(name, port) {
    this.name = name;
    this.bot = new Bot(name, port, 'no-room');
  }

  async join(url) {
    const target = platformFromUrl(url);
    if (!target.ok) throw new Error(target.error);
    let ok;
    if (target.provider === 'meet') {
      this.bot.room = target.roomId;
      ok = await this.bot.join();
    } else {
      ok = await this.bot.joinLink(target.provider, url);
    }
    if (!ok) throw new Error('the app refused the join');
    if (!(await this.bot.waitInCall({ maxMs: 90000 }))) throw new Error('not in the call after 90s');
    await sleep(3000); // captions come up a moment after the call UI does
  }

  async participants() {
    const { participants = [] } = await this.bot.status();
    return participants.map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean);
  }

  startListening() { this.bot.since = new Date().toISOString(); }

  async heard(test, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let text = '';
    while (Date.now() < deadline) {
      const wait = Math.max(1, Math.min(20, Math.round((deadline - Date.now()) / 1000)));
      const { transcript } = await this.bot.waitForSpeech({ wait, silence: 2 });
      text = `${text} ${transcript.map((e) => e.text || '').join(' ')}`.trim();
      if (test(text)) return text;
    }
    return null;
  }

  async playClip(file) { await this.bot.playAudio({ path: file, emoji: '🔊' }); }

  async sendChat(text) { await this.bot.sendChat(text); }

  async chatContains(needle, timeoutMs) {
    return this.bot.expectChatContains(needle, { attempts: Math.max(1, Math.round(timeoutMs / 2000)), intervalMs: 2000 });
  }

  async share() { return (await this.bot.shareWhiteboard()).sharing; }

  async stopShare() {
    await this.bot.stopSharing();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try { if (!(await this.bot.status()).sharing) return true; } catch { /* retry */ }
    }
    return false;
  }

  async leave() {
    const data = await this.bot.leave();
    return data?.success !== false;
  }

  async snapshot() {
    const shot = await this.bot.screenshot();
    return shot.ok ? shot.path : null;
  }
}
