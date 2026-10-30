// provider-events.js: the in-process event surface a page-side provider
// reports through (provider.on(CALL_EVENTS.x, fn)). The host subscribes and
// carries each event to wherever it goes: IPC under Electron, a binding under
// Playwright. A payload-less event reaches handlers with no argument, so a host
// can forward it without inventing an `undefined`.
//
// A mixin, not a base class: providers already extend CallProvider.

function addEvents(target, { tag = '[provider]' } = {}) {
  const handlers = new Map(); // channel -> Set
  target.on = (channel, handler) => {
    if (!handlers.has(channel)) handlers.set(channel, new Set());
    handlers.get(channel).add(handler);
    return target;
  };
  target.off = (channel, handler) => {
    const set = handlers.get(channel);
    if (set) set.delete(handler);
    return target;
  };
  target.emit = (channel, ...args) => {
    const set = handlers.get(channel);
    if (!set) return;
    for (const h of set) {
      try { h(...args); } catch (e) { console.warn(tag + ' ' + channel + ' handler failed: ' + e.message); }
    }
  };
  return target;
}

module.exports = { addEvents };
