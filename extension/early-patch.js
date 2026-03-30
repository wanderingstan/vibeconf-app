// early-patch.js — Runs in ISOLATED world at document_start.
// Injects a synchronous inline <script> into the page BEFORE any other
// scripts execute. This ensures getUserMedia is patched before Meet's
// code can save a reference to the original.
//
// The inline script installs a thin wrapper that delegates to the full
// handler in page-inject.js (which loads slightly later via world: MAIN).
// This solves the signed-in Google account issue where Meet caches
// getUserMedia during early initialization.

'use strict';

const patchScript = document.createElement('script');
patchScript.textContent = `
(function() {
  // Save originals
  const _getUserMedia = MediaDevices.prototype.getUserMedia;
  const _getDisplayMedia = MediaDevices.prototype.getDisplayMedia;
  const _enumerateDevices = MediaDevices.prototype.enumerateDevices;
  const _permissionsQuery = Permissions.prototype.query;

  // Patch getUserMedia with a delegating wrapper
  MediaDevices.prototype.getUserMedia = function() {
    if (window.__botsInCallsGetUserMedia) {
      return window.__botsInCallsGetUserMedia.apply(this, arguments);
    }
    if (!window.__botsInCallsPendingGUM) {
      window.__botsInCallsPendingGUM = [];
    }
    return new Promise((resolve, reject) => {
      window.__botsInCallsPendingGUM.push({
        args: arguments,
        context: this,
        resolve,
        reject,
      });
      console.log('[bots-in-calls] getUserMedia queued (handler not ready yet)');
    });
  };

  // Patch getDisplayMedia
  MediaDevices.prototype.getDisplayMedia = function() {
    if (window.__botsInCallsGetDisplayMedia) {
      return window.__botsInCallsGetDisplayMedia.apply(this, arguments);
    }
    return _getDisplayMedia.call(this, ...arguments);
  };

  // Patch enumerateDevices to always include virtual camera + mic
  MediaDevices.prototype.enumerateDevices = async function() {
    const devices = await _enumerateDevices.call(navigator.mediaDevices);
    const hasAudio = devices.some(function(d) { return d.kind === 'audioinput'; });
    const hasVideo = devices.some(function(d) { return d.kind === 'videoinput'; });
    var extras = [];
    if (!hasAudio) {
      extras.push({
        deviceId: 'virtual-mic',
        kind: 'audioinput',
        label: 'Bots in Calls Virtual Microphone',
        groupId: 'bots-in-calls',
        toJSON: function() { return this; },
      });
    }
    if (!hasVideo) {
      extras.push({
        deviceId: 'virtual-camera',
        kind: 'videoinput',
        label: 'Bots in Calls Virtual Camera',
        groupId: 'bots-in-calls',
        toJSON: function() { return this; },
      });
    }
    if (extras.length > 0) {
      console.log('[bots-in-calls] Early patch: added', extras.length, 'virtual device(s)');
    }
    return devices.concat(extras);
  };

  // Patch permissions.query to report camera/mic as granted
  Permissions.prototype.query = async function(descriptor) {
    if (descriptor.name === 'microphone' || descriptor.name === 'camera') {
      console.log('[bots-in-calls] Early patch: permissions.query', descriptor.name, '→ granted');
      var status = new EventTarget();
      status.state = 'granted';
      status.onchange = null;
      return status;
    }
    return _permissionsQuery.call(this, descriptor);
  };

  // Store originals for the full handler to use
  window.__botsInCallsOriginalGUM = _getUserMedia;
  window.__botsInCallsOriginalGDM = _getDisplayMedia;

  console.log('[bots-in-calls] Early patch: all media APIs intercepted before page scripts');
})();
`;

// Prepend to <html> so it runs before any page <script> tags
(document.documentElement || document.head || document).prepend(patchScript);
patchScript.remove(); // Clean up — the code has already executed

console.log('[bots-in-calls] Early patch script injected');
