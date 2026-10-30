// load.js: puts the media core (page-inject.js) into a call page, from the
// page's preload. It must run before the page's own scripts can ask for media.
//
// The preload's global must be the page's (contextIsolation off), so an
// indirect eval here defines the core in the page world. A host's own page
// plugins load after it and use the core through window.__vibeconfMedia.

const fs = require('fs');
const path = require('path');

const MEDIA_CORE_PATH = path.join(__dirname, 'page-inject.js');

function injectMediaCore() {
  (0, eval)(fs.readFileSync(MEDIA_CORE_PATH, 'utf-8'));
}

module.exports = { injectMediaCore, MEDIA_CORE_PATH };
