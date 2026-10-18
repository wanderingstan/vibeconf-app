// supervisor.js (renderer) — the over-bot view (#301).
//
// Reads the fleet and the calendar from the supervisor process and draws them.
// It holds no state of its own beyond the last snapshot: everything true about a
// bot lives in that bot's process or on disk, and a renderer that cached any of
// it would be a fourth place for the fleet's state to disagree with itself.

const api = window.electronAPI;

const els = {
  bots: document.getElementById('bots'),
  count: document.getElementById('count'),
  orphans: document.getElementById('orphans'),
  events: document.getElementById('events'),
  banner: document.getElementById('calendarBanner'),
  tickStatus: document.getElementById('tickStatus'),
};

// Everything from the main process is either read off disk or off the network,
// so it reaches here as untrusted text: a bot name, an event title, a calendar
// organiser. Built as text nodes rather than innerHTML throughout.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Last failure per bot, shown under its name until its next action. Kept here
// because every refresh rebuilds the rows.
const rowErrors = new Map();

// Busy = anything from starting to join through the post-call write-up. The
// supervisor decides it (callPhase in supervisor.js), so the window and the
// directory never disagree about what a status means.
function inCall(bot) {
  return !!bot.busy;
}

// What a person would say the bot is doing, which is only ever about calls.
// "Running" is a fact about a process the user never started or stopped: any
// bot is available, and selecting one starts it if need be. So an idle bot
// says nothing here, and the row shows when it was last used instead.
const PHASE_TEXT = {
  joining: 'Joining…',
  stuck: 'Stuck joining',
  waiting: 'Waiting to be let in',
  'in-call': 'In a call',
  wrapping: 'Wrapping up the call',
};
function describeState(bot) {
  if (!bot.busy) return null;
  const where = bot.roomId && bot.phase !== 'wrapping' ? ` · ${bot.roomId}` : '';
  return { cls: bot.phase === 'stuck' ? 'stuck' : 'call', text: `${PHASE_TEXT[bot.phase] || 'Busy'}${where}` };
}

// Busy first, then most recently used. Name breaks ties (and orders bots that
// have never been used). Bots behave more like browser tabs than a fixed
// roster: whatever you used lately is what you reach for, and a bot tried once
// last month sinks on its own.
function rank(bot) { return inCall(bot) ? 0 : 1; }
function byRecency(a, b) {
  return rank(a) - rank(b)
    || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)
    || labelOf(a).localeCompare(labelOf(b));
}

// "used 5m ago", "used 3d ago": enough to tell last week's bot from last
// year's, not a timestamp.
function usedAgo(ms) {
  if (!ms) return null;
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'used just now';
  if (mins < 60) return `used ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `used ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `used ${days}d ago`;
  return `used ${Math.round(days / 30)}mo ago`;
}
function labelOf(bot) { return bot.botName || bot.name; }

function avatarFor(bot) {
  const box = el('div', 'avatar');
  if (bot.avatarThumb && bot.avatarThumb.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = bot.avatarThumb;
    img.alt = '';
    img.draggable = false;
    box.append(img);
  } else {
    // A bot that has never drawn its face (never opened since the thumbnail
    // existed) still gets a tile, so every row lines up.
    box.append(el('span', 'mono', (labelOf(bot).trim().charAt(0) || '?').toUpperCase()));
  }
  // Only a call earns a dot. Up or down is the app's business, not the user's.
  if (inCall(bot)) box.append(el('span', `dot ${bot.phase === 'stuck' ? 'stuck' : 'call'}`));
  return box;
}

// The bot whose panel is on the stage (#301 one-window spike).
let selectedBot = null;
// Bots launched from the sidebar that have not answered yet, so their row
// says "Starting…" across refreshes instead of flickering back to closed.
const starting = new Set();

// The stage behind the panel view. While a bot wakes up it shows that bot's
// face and name, straight from disk, so selecting a closed bot looks like a
// tab loading rather than a separate "start the bot" step.
function showStage(bot, { note = 'Waking up…', pulse = true } = {}) {
  const stage = document.getElementById('stage');
  stage.replaceChildren();
  if (!bot) { stage.append(el('div', null, 'Select a bot to see it here.')); return; }
  const card = el('div', 'waking');
  const face = el('div', 'waking-face');
  if (bot.avatarThumb && bot.avatarThumb.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = bot.avatarThumb;
    img.alt = '';
    face.append(img);
  } else {
    face.append(el('span', null, (labelOf(bot).trim().charAt(0) || '?').toUpperCase()));
  }
  card.append(face, el('div', 'waking-name', labelOf(bot)), el('div', `waking-note${pulse ? '' : ' still'}`, note));
  stage.append(card);
}

async function openBot(bot) {
  if (starting.has(bot.name)) return;
  rowErrors.delete(bot.name);
  if (!bot.running) {
    starting.add(bot.name);
    selectedBot = bot.name; // highlight it now; the supervisor confirms on arrival
    showStage(bot);
    refresh();
  }
  const r = await api.invoke('supervisor:open', bot.name).catch((e) => ({ ok: false, error: e.message }));
  starting.delete(bot.name);
  // An outdated bot is explained on the stage (see the 'outdated' push), not as a row error.
  if (!r?.ok && r?.code !== 'outdated') { rowErrors.set(bot.name, `Could not open it: ${r?.error || 'unknown error'}`); showStage(null); }
  refresh();
}

// The last fleet drawn, so a 'waking' push can find the bot's face and name.
let lastBots = [];

function renderBots({ bots = [], orphans = [], selected = null }) {
  lastBots = bots;
  selectedBot = selected || [...starting][0] || null;
  els.bots.replaceChildren();
  els.count.textContent = bots.length === 1 ? '1 bot' : bots.length ? `${bots.length} bots` : '';
  els.bots.classList.toggle('many', bots.length > 6);
  if (!bots.length) {
    els.bots.append(el('div', 'empty', 'No bots configured yet.'));
  }

  const sorted = [...bots].sort(byRecency);
  for (const bot of sorted) {
    const isStarting = starting.has(bot.name) && !bot.running;
    const row = el('div', `bot selectable${bot.name === selectedBot ? ' selected' : ''}`);
    // The profile (what folders, logs and ports are named after) is developer
    // detail: on hover, not on the row.
    row.title = `Profile: ${bot.name}${bot.running && bot.port ? ` · port ${bot.port}` : ''}`;
    // The row is the whole control: click a bot and its panel is on the stage,
    // where Call, Join and everything else already live. A closed bot is
    // started first (the supervisor waits for it to answer, then shows it).
    row.addEventListener('click', () => openBot(bot));
    row.append(avatarFor(bot));

    const who = el('div', 'who');
    // The display name is what a person calls this bot; the profile is what the
    // machine calls it. Both, because they routinely differ — and the profile is
    // what every log line, port and folder is named after.
    const name = el('div', 'name', labelOf(bot));
    if (bot.isDefault) name.append(el('span', 'tag', 'default'));
    who.append(name);
    const state = isStarting ? { cls: 'up', text: 'Waking up…' } : describeState(bot);
    const sub = el('div', 'sub');
    if (state) sub.append(el('span', `state ${state.cls}`, state.text));
    else sub.append(document.createTextNode(usedAgo(bot.lastUsedAt) || 'Not used yet'));
    who.append(sub);
    row.append(who);

    // A stuck join says why when the bot told us; otherwise what we can see.
    const err = rowErrors.get(bot.name)
      || (bot.phase === 'stuck' ? (bot.error || 'No progress for over a minute. Select it to see where it is.') : null);
    if (err) who.append(el('div', 'err', err));

    els.bots.append(row);
  }

  // An orphan is a port answering for a profile with no config on disk (#511):
  // a bot whose window was closed but whose process never exited. Surfaced
  // because today nothing tells you it is there — it just holds a port and
  // quietly counts as a running bot.
  els.orphans.replaceChildren();
  if (orphans.length) {
    const banner = el('div', 'banner warn');
    banner.textContent = `${orphans.length} running instance${orphans.length > 1 ? 's' : ''} with no profile on disk: `
      + orphans.map((o) => `${o.profile} (port ${o.port})`).join(', ');
    els.orphans.append(banner);
  }
}

function whenLabel(startIso) {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return '';
  const mins = Math.round((start - Date.now()) / 60000);
  if (mins < 0) return 'now';
  if (mins === 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
  return new Date(start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function renderEvents(state) {
  els.banner.replaceChildren();
  if (state.signedIn === false) {
    const banner = el('div', 'banner warn');
    banner.textContent = 'Not signed in to vibeconferencing.com, so no calendar is being watched.';
    els.banner.append(banner);
  } else if (state.calendarError) {
    const banner = el('div', 'banner warn');
    banner.textContent = `Calendar check failed: ${state.calendarError}`;
    els.banner.append(banner);
  }

  const events = state.events || [];
  els.events.replaceChildren();
  if (!events.length) {
    els.events.append(el('div', 'empty', 'No meetings for your bots in the next 24 hours.'));
    return;
  }
  for (const event of events) {
    const row = el('div', 'event');
    row.append(el('span', 'when', whenLabel(event.start)));
    const what = el('div', 'what');
    what.append(el('div', 'title', event.summary || '(untitled)'));
    // Which bot this wakes is the whole point of showing it here — an upcoming
    // meeting nobody is assigned to is a meeting no bot will join.
    // The owner's RSVP gates the join (ownerHasConfirmed), so an unaccepted
    // meeting is listed but says it will not be joined, as the panel does.
    const who = event.forProfile ? `→ ${event.forProfile}` : '';
    what.append(el('div', 'for', event.ownerConfirmed === false
      ? `${who} · not joining until you accept the invite`
      : who));
    row.append(what);
    els.events.append(row);
  }
}

async function refresh() {
  renderBots(await api.invoke('supervisor:fleet'));
}

// The process pushes after every tick, so the window stays current without
// polling it a second time from here.
api.on('supervisor-state', (state) => {
  // A bot is being woken (from a click here, or from anywhere else that opens
  // one): show its placeholder on the stage until its panel arrives.
  if (state && 'waking' in state) {
    const bot = lastBots.find((b) => b.name === state.waking);
    if (bot) { starting.add(bot.name); showStage(bot); }
    if (state.wakeFailed) {
      starting.delete(state.wakeFailed);
      rowErrors.set(state.wakeFailed, `Could not open it: ${state.error || 'unknown error'}`);
      showStage(null);
    }
  }
  // The bot arrived (or the stage was cleared): drop the placeholder, so it
  // cannot resurface later from behind the panel.
  if (state && state.selected !== undefined) { starting.clear(); showStage(null); }
  // Selected a bot started by an older build: it cannot be shown here until it
  // restarts. Say that on the stage, with its face, rather than a broken panel.
  if (state && state.outdated) {
    const bot = lastBots.find((b) => b.name === state.outdated);
    selectedBot = state.outdated;
    showStage(bot || { name: state.outdated }, {
      note: `${bot ? labelOf(bot) : state.outdated} is running an older version of the app. Quit it, then select it again to show it here.`,
      pulse: false,
    });
  }
  // Not every push is a calendar tick: a change in the browser's open calls
  // pushes too, with no events, and must not blank the Upcoming list.
  if (state && 'events' in state) renderEvents(state);
  if (state?.lastTick) {
    els.tickStatus.textContent = `Last checked ${new Date(state.lastTick).toLocaleTimeString()}`;
  }
  refresh();
});

// ── The account line pinned to the sidebar's bottom ──

async function renderAccount() {
  const box = document.getElementById('account');
  const a = await api.invoke('supervisor:account').catch(() => ({ signedIn: null }));
  box.replaceChildren();
  box.classList.toggle('signed-out', a.signedIn === false);
  if (a.signedIn === null) return; // could not tell: say nothing rather than something wrong
  if (a.signedIn) {
    const who = el('span', 'who', a.email || a.name || 'Signed in');
    who.title = 'Your vibeconferencing.com login. One sign-in covers every bot.';
    box.append(who);
    return;
  }
  box.append(el('span', 'who', 'Not signed in'));
  const btn = el('button', 'ghost', 'Sign in');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const r = await api.invoke('supervisor:sign-in').catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) { btn.textContent = r?.error || 'Could not sign in'; return; }
    setTimeout(renderAccount, 3000);
  });
  box.append(btn);
}
renderAccount();
// A sign-in or sign-out anywhere (a bot's settings, App Settings) reaches the
// window as a fleet refresh soon enough; re-check on focus too.
window.addEventListener('focus', renderAccount);

// ── The sidebar's top bar: hide/show, and which list it shows ──
//
// Remembered per machine in localStorage (a convenience, so it may be empty:
// every read is guarded and the defaults are the full sidebar on Bots).

const SIDEBAR_W = 320; // keep in step with SIDEBAR_W / RAIL_W in supervisor-app.js
const RAIL_W = 56;
const MODES = ['bots', 'upcoming', 'history'];

function remembered(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not persisted; fine */ }
}

function showMode(mode) {
  if (!MODES.includes(mode)) mode = 'bots';
  for (const b of document.querySelectorAll('.mode')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== mode;
  remember('sidebarMode', mode);
}

// Collapsing also tells the supervisor, which places the bot's panel (a
// separate view) beside whatever width the sidebar now takes.
function setCollapsed(collapsed) {
  document.getElementById('sidebar').hidden = collapsed;
  document.getElementById('rail').hidden = !collapsed;
  remember('sidebarCollapsed', collapsed ? '1' : '0');
  api.invoke('supervisor:layout', { sidebarWidth: collapsed ? RAIL_W : SIDEBAR_W }).catch(() => {});
}

for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => showMode(b.dataset.mode));
document.getElementById('collapse').addEventListener('click', () => setCollapsed(true));
document.getElementById('expand').addEventListener('click', () => setCollapsed(false));

showMode(remembered('sidebarMode', 'bots'));
setCollapsed(remembered('sidebarCollapsed', '0') === '1');

refresh();
