// electron-builder afterPack hook: puts back the link to packages/calls that
// before-pack.js swapped for a copy while the app was packed.
exports.default = async function afterPack() {
  require('./before-pack.js').restoreCallsLink();
  console.log('[after-pack] relinked packages/calls');
};
