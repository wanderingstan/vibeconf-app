// Which account a bot is signed into on a calling app's web client (#843).
//
// The login lives in the page's own storage, not in cookies, so main can't read
// it directly: it runs PAGE_PROBES[app] inside the sign-in window and hands the
// raw result to describeAccount(), which turns it into the line the panel shows.
// The probes are serialized with toString(), so they must stay self-contained.

const PAGE_PROBES = {
  // WhatsApp Web keeps the linked number as a JSON string like
  // "15551234567:12@c.us" (number:device@server).
  whatsapp: function probeWhatsApp() {
    const wid = localStorage.getItem('last-wid-md') || localStorage.getItem('last-wid');
    if (!wid) return null;
    let pushname = null;
    try { pushname = JSON.parse(localStorage.getItem('last-pushname') || 'null'); } catch { /* absent */ }
    return { wid, pushname };
  },

  // Telegram's A client: user_auth = {dcID, id} once logged in. The profile
  // (name, username, phone) is in its cached global state: IndexedDB "tt-data"
  // on current builds (checked live 2026-10), localStorage on older ones. It
  // can lag the login by a few seconds, so the id alone still counts as
  // signed in, and the poll fills the rest in once it's cached.
  telegram: async function probeTelegram() {
    const auth = localStorage.getItem('user_auth');
    if (!auth) return null;
    let id = null;
    try { id = String(JSON.parse(auth).id || '') || null; } catch { /* keep null */ }
    const pick = (g) => {
      if (!g || typeof g !== 'object') return null;
      const uid = g.currentUserId || id;
      const u = g.users?.byId?.[uid];
      if (!u) return null;
      return {
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        username: u.usernames?.find((x) => x.isActive)?.username || u.usernames?.[0]?.username || u.username || null,
        phoneNumber: u.phoneNumber || null,
      };
    };
    const fromIdb = (dbName, storeName) => new Promise((resolve) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(storeName)) { db.close(); return resolve(null); }
          const get = db.transaction(storeName).objectStore(storeName).get('tt-global-state');
          get.onsuccess = () => {
            db.close();
            let g = get.result;
            if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
            resolve(pick(g));
          };
          get.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    });
    let user = null;
    try { user = pick(JSON.parse(localStorage.getItem('tt-global-state') || 'null')); } catch { /* not there */ }
    if (typeof indexedDB !== 'undefined') {
      // Current builds: db "tt-data", store "store". Older: idb-keyval defaults.
      if (!user) user = await fromIdb('tt-data', 'store');
      if (!user) user = await fromIdb('keyval-store', 'keyval');
    }
    return { id, ...(user || {}) };
  },
};

function probeSource(app) {
  const fn = PAGE_PROBES[app];
  return fn ? `(${fn.toString()})()` : null;
}

// Raw probe result → { label } for the panel, or null when signed out.
function describeAccount(app, raw) {
  if (!raw) return null;
  if (app === 'whatsapp') {
    let wid = raw.wid;
    try { wid = JSON.parse(wid); } catch { /* already plain */ }
    const digits = String(wid || '').split(/[:@]/)[0].replace(/\D/g, '');
    const parts = [raw.pushname, digits && `+${digits}`].filter(Boolean);
    return { label: parts.join(' · ') || 'signed in' };
  }
  if (app === 'telegram') {
    const name = [raw.firstName, raw.lastName].filter(Boolean).join(' ');
    const parts = [
      name,
      raw.username && `@${raw.username}`,
      raw.phoneNumber && `+${String(raw.phoneNumber).replace(/^\+/, '')}`,
    ].filter(Boolean);
    if (parts.length) return { label: parts.join(' · ') };
    return { label: raw.id ? `user id ${raw.id}` : 'signed in' };
  }
  return { label: 'signed in' };
}

module.exports = { PAGE_PROBES, probeSource, describeAccount };
