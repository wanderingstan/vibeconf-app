// bundle.js: turns a page-side CommonJS module and its relative requires into
// one script a plain browser page can run.
//
// Under Electron a call page's preload has Node's require, so a provider loads
// as itself. A Playwright page has no require, so the host bundles the provider
// (and the few library modules it pulls in) into a single script for
// addInitScript. Only relative requires inside the package are followed; the
// page code needs nothing else, and anything else is an error rather than a
// silent gap at runtime.

const fs = require('fs');
const path = require('path');

const REQUIRE_RE = /require\((['"])([^'"]+)\1\)/g;

function bundlePageScript(entry, { exportAs } = {}) {
  const modules = new Map(); // absolute path -> { id, src }
  const visit = (file) => {
    if (modules.has(file)) return modules.get(file).id;
    const id = modules.size;
    const entryRec = { id, src: '' };
    modules.set(file, entryRec);
    entryRec.src = fs.readFileSync(file, 'utf8').replace(REQUIRE_RE, (whole, q, spec) => {
      if (!spec.startsWith('.')) {
        throw new Error(`${path.basename(file)}: require('${spec}') can't run in a page; only relative requires are bundled`);
      }
      let target = path.resolve(path.dirname(file), spec);
      if (!target.endsWith('.js')) target += '.js';
      return `__req(${visit(target)})`;
    });
    return id;
  };
  const entryId = visit(path.resolve(entry));

  const defs = [...modules.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, src }) => `${id}: function (module, exports, __req) {\n${src}\n}`)
    .join(',\n');
  return `(function () {
  var __defs = {\n${defs}\n};
  var __cache = {};
  function __req(id) {
    if (__cache[id]) return __cache[id].exports;
    var module = __cache[id] = { exports: {} };
    __defs[id].call(module.exports, module, module.exports, __req);
    return module.exports;
  }
  var __entry = __req(${entryId});
  ${exportAs ? `window[${JSON.stringify(exportAs)}] = __entry;` : ''}
})();\n`;
}

module.exports = { bundlePageScript };
