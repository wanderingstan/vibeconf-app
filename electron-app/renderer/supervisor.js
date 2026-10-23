// supervisor.js (renderer) — the over-bot view (#301).
//
// Reads the fleet and the calendar from the supervisor process and draws them.
// It holds no state of its own beyond the last snapshot: everything true about a
// bot lives in that bot's process or on disk, and a renderer that cached any of
// it would be a fourth place for the fleet's state to disagree with itself.

const api = window.electronAPI;

const els = {
  bots: document.getElementById('bots'),
  orphans: document.getElementById('orphans'),
  events: document.getElementById('events'),
  banner: document.getElementById('calendarBanner'),
  tickStatus: document.getElementById('tickStatus'),
  sessions: document.getElementById('sessions'),
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
  wrapping: 'Call ended · writing it up',
};
function describeState(bot) {
  if (!bot.busy) return null;
  const where = bot.roomId && bot.phase !== 'wrapping' ? ` · ${bot.roomId}` : '';
  // Wrapping up is after the call: muted, not call-green, so it doesn't read as
  // still being in one.
  const cls = bot.phase === 'stuck' ? 'stuck' : bot.phase === 'wrapping' ? 'wrap' : 'call';
  return { cls, text: `${PHASE_TEXT[bot.phase] || 'Busy'}${where}` };
}

// In a call (or joining, waiting, wrapping up) first, then most recently in a
// call. Selecting a bot does not move it: only calls do, so the list stays put
// while you click around it. Name breaks ties (and orders bots never in a call).
function rank(bot) { return inCall(bot) ? 0 : 1; }
function byRecency(a, b) {
  return rank(a) - rank(b)
    || (b.lastCallAt || 0) - (a.lastCallAt || 0)
    || labelOf(a).localeCompare(labelOf(b));
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
function showStage(bot, { note = 'Waking up…', pulse = true, action = null } = {}) {
  const stage = document.getElementById('stage');
  stage.replaceChildren();
  stage.classList.remove('has-session');
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
  // One button when there is something to do about it (Restart, for a bot
  // from an older build), with any failure said under it.
  if (action) {
    const b = el('button', 'stage-action', action.label);
    const err = el('div', 'waking-note still');
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await action.run().catch((e) => ({ ok: false, error: e.message }));
      if (r && !r.ok) { b.disabled = false; err.textContent = r.error || 'That didn\'t work.'; }
    });
    card.append(b, err);
  }
  stage.append(card);
}

async function openBot(bot) {
  if (starting.has(bot.name)) return;
  if (selectedSession) { selectedSession = null; renderSessions(); }
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

// ── Row actions: merge into a call, and the … menu ──
//
// Merge is a phone's "merge calls": add this bot to a call already going (a
// Meet open in your browser, or a call another bot is in). It shows only when
// there is such a call, so its presence says one is on. The … menu holds the
// rest: Show in Finder, Stop, Delete bot.

const MERGE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7.5 L12 4 L15.5 7.5 M12 4 V12 M12 12 L6.5 20 M12 12 L17.5 20"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>';

let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('click', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
// A click in the bot's pane lands in another web page (the stage is its own
// view), so this page only learns of it by losing focus. Close then too.
window.addEventListener('blur', closeMenu);

// A small menu under `anchor`: items are { label, run, disabled, danger, title }.
function showMenu(anchor, items) {
  // A second click on the button that opened it closes it, like any menu.
  if (openMenu && openMenu.__anchor === anchor) { closeMenu(); return; }
  closeMenu();
  const menu = el('div', 'row-menu');
  for (const it of items) {
    const b = el('button', `row-menu-item${it.danger ? ' danger' : ''}`, it.label);
    if (it.disabled) b.disabled = true;
    if (it.title) b.title = it.title;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.run(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)))}px`;
  menu.__anchor = anchor;
  openMenu = menu;
}

function iconButton(cls, svg, title) {
  const b = el('button', `row-act ${cls}`);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg; // a fixed glyph of our own, not data
  return b;
}

async function mergeInto(bot, target) {
  rowErrors.delete(bot.name);
  const r = await api.invoke('supervisor:add', bot.name, target.url).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) rowErrors.set(bot.name, `Could not add it to the call: ${r?.error || 'unknown error'}`);
  refresh();
}

function rowActions(bot, merge) {
  const box = el('div', 'row-actions');
  // Calls this bot is not already in.
  const targets = inCall(bot) ? [] : (merge || []).filter((t) => t.bot !== bot.name);
  if (targets.length) {
    const m = iconButton('merge', MERGE_ICON, targets.length === 1 ? `Add ${labelOf(bot)} to ${targets[0].label}` : `Add ${labelOf(bot)} to a call`);
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      if (targets.length === 1) { mergeInto(bot, targets[0]); openBot(bot); return; }
      showMenu(m, targets.map((t) => ({ label: t.label, title: t.url, run: () => { mergeInto(bot, t); openBot(bot); } })));
    });
    box.append(m);
  }
  const more = iconButton('more', MORE_ICON, 'More');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const busy = inCall(bot);
    showMenu(more, [
      { label: 'Show in Finder', run: () => api.invoke('supervisor:reveal', bot.name).catch(() => {}) },
      ...(bot.running ? [{ label: 'Stop', disabled: busy, title: busy ? 'Leave the call first' : 'Stop it now; it starts again when you select it',
        run: async () => {
          const r = await api.invoke('supervisor:stop-bot', bot.name).catch((err) => ({ ok: false, error: err.message }));
          if (!r?.ok) rowErrors.set(bot.name, r?.error || 'Could not stop it.');
          refresh();
        } }] : []),
      { label: 'Delete bot…', danger: true, disabled: bot.isDefault || busy,
        title: bot.isDefault ? "The default bot can't be deleted" : busy ? 'Leave the call first' : 'Move it to the Trash',
        run: async () => {
          const r = await api.invoke('supervisor:delete-bot', bot.name).catch((err) => ({ ok: false, error: err.message }));
          if (r && !r.ok && !r.cancelled) rowErrors.set(bot.name, r.error || 'Could not delete it.');
          refresh();
        } },
    ]);
  });
  box.append(more);
  return box;
}

function renderBots({ bots = [], orphans = [], selected = null, merge = [] }) {
  lastBots = bots;
  selectedBot = selected || [...starting][0] || null;
  els.bots.replaceChildren();
  els.bots.classList.toggle('many', bots.length > 6);
  if (!bots.length) {
    els.bots.append(el('div', 'empty', 'No bots configured yet.'));
  }

  // "New bot" heads the list: making one is a list-level action, so it lives
  // here rather than inside any one bot's panel.
  els.bots.append(newBotRow());

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
    // Only something worth saying earns a second line: a call state, or waking
    // up. Otherwise the row is just the name.
    if (state) {
      const sub = el('div', 'sub');
      sub.append(el('span', `state ${state.cls}`, state.text));
      who.append(sub);
    }
    row.append(who);
    row.append(rowActions(bot, merge));
    if (merge.some((t) => t.bot !== bot.name) && !inCall(bot)) row.classList.add('can-merge');

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

// ── Sessions: your recent Claude Code sessions, below the bots ──
//
// Seth's idea: a session you already have knows about real work, so make it
// a bot and it can talk about that work. Click one for its last lines and a
// Create bot button; the bot resumes that very session.

let selectedSession = null;
const SESSION_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5 L10 12 L7 14.5 M12.5 15 L17 15"/></svg>';

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const folderOf = (cwd) => String(cwd || '').split('/').filter(Boolean).pop() || cwd;

async function renderSessions() {
  if (!els.sessions) return;
  const list = await api.invoke('supervisor:sessions').catch(() => []);
  els.sessions.replaceChildren();
  if (!list.length) return;
  els.sessions.append(el('div', 'section-head', 'Sessions'));
  for (const sess of list) {
    const row = el('div', `session${sess.id === selectedSession ? ' selected' : ''}`);
    row.title = `${sess.cwd}\nSession ${sess.id}`;
    const icon = el('div', 'session-icon');
    icon.innerHTML = SESSION_ICON; // a fixed glyph of our own, not data
    const who = el('div', 'who');
    who.append(el('div', 'title', sess.title || sess.lastPrompt || folderOf(sess.cwd)));
    const sub = el('div', 'sub');
    if (Date.now() - sess.mtimeMs < 2 * 60 * 1000) sub.append(el('span', 'live'));
    sub.append(document.createTextNode(sess.bot ? `Already ${sess.bot}` : `${ago(sess.mtimeMs)} · ${folderOf(sess.cwd)}`));
    who.append(sub);
    row.append(icon, who);
    row.addEventListener('click', () => openSession(sess.id));
    els.sessions.append(row);
  }
}
renderSessions();
setInterval(renderSessions, 20000);
window.addEventListener('focus', renderSessions);

async function openSession(id) {
  selectedSession = id;
  selectedBot = null;
  await api.invoke('supervisor:clear-stage').catch(() => {});
  const d = await api.invoke('supervisor:session-detail', id).catch((e) => ({ ok: false, error: e.message }));
  // The clear-stage push redraws an empty stage; draw the session after it.
  setTimeout(() => showSessionStage(d), 0);
  renderSessions();
  refresh();
}

function showSessionStage(d) {
  const stage = document.getElementById('stage');
  stage.replaceChildren();
  stage.classList.add('has-session');
  if (!d?.ok) { stage.append(el('div', 'sess-err', d?.error || 'Could not read that session.')); return; }
  const { session: s, excerpt, suggestion, emojiSets, voices } = d;
  stage.append(el('div', 'sess-title', s.title || s.lastPrompt || folderOf(s.cwd)));
  stage.append(el('div', 'sess-meta', `Claude Code session · ${ago(s.mtimeMs)} · ${s.cwd}`));

  // Its last lines, so you can tell which session this is.
  const box = el('div', 'sess-excerpt');
  if (!excerpt.length) box.append(el('div', 'sess-line', 'No conversation to show yet.'));
  for (const line of excerpt) {
    const div = el('div', `sess-line ${line.role}`);
    // No labels: your prompts sit on a shaded, indented block, the way Claude
    // Code shows a conversation; Claude's replies are plain text.
    div.append(document.createTextNode(line.text));
    box.append(div);
  }
  stage.append(box);
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });

  const create = el('button', 'sess-create', 'Create bot');
  stage.append(create);

  // The bot it becomes: picked at random the way a new bot is, changeable here.
  const opts = el('div', 'sess-opts');
  const field = (label, control) => { const f = el('div', 'sess-opt'); f.append(el('label', null, label), control); opts.append(f); return control; };
  const nameIn = field('Name', Object.assign(document.createElement('input'), { value: suggestion.name, maxLength: 40 }));
  const nameNote = el('div', 'sess-hint', suggestion.nameNote || '');
  nameIn.parentElement.append(nameNote);
  const faceSel = field('Face style', document.createElement('select'));
  for (const e of emojiSets) faceSel.append(Object.assign(document.createElement('option'), { value: e.id, textContent: e.label }));
  faceSel.value = suggestion.emojiSet;
  const voiceSel = field('Voice', document.createElement('select'));
  voiceSel.append(Object.assign(document.createElement('option'), { value: '', textContent: 'The app\'s default voice' }));
  // Grouped by provider, best first, the way a bot's own voice picker is.
  const groups = new Map();
  for (const v of voices) {
    if (!groups.has(v.group)) { const g = document.createElement('optgroup'); g.label = v.group; groups.set(v.group, g); voiceSel.append(g); }
    groups.get(v.group).append(Object.assign(document.createElement('option'), { value: v.id, textContent: v.label }));
  }
  voiceSel.value = suggestion.voice || '';
  const shuffle = el('button', 'sess-shuffle', 'Shuffle');
  shuffle.addEventListener('click', async () => {
    const n = await api.invoke('supervisor:suggest-bot', s.id).catch(() => null);
    if (n) { nameIn.value = n.name; faceSel.value = n.emojiSet; voiceSel.value = n.voice || ''; nameNote.textContent = n.nameNote || ''; }
  });
  opts.append(shuffle);
  stage.append(opts);
  stage.append(el('div', 'sess-note', 'The bot resumes this session, in its folder, so it starts with everything the session knows. Its background is picked at random; change anything later in its settings.'));
  const err = el('div', 'sess-err');
  stage.append(err);

  create.addEventListener('click', async () => {
    create.disabled = true;
    create.textContent = 'Creating…';
    const r = await api.invoke('supervisor:create-bot-from-session', {
      id: s.id, name: nameIn.value, emojiSet: faceSel.value, voice: voiceSel.value,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (!r?.ok) {
      create.disabled = false;
      create.textContent = 'Create bot';
      err.textContent = `Could not create it: ${r?.error || 'unknown error'}`;
      return;
    }
    selectedSession = null;
    renderSessions();
  });
}

// The process pushes after every tick, so the window stays current without
// polling it a second time from here.
api.on('supervisor-state', (state) => {
  // A bot is being woken (from a click here, or from anywhere else that opens
  // one): show its placeholder on the stage until its panel arrives.
  if (state && 'waking' in state) {
    const wake = (b) => { starting.add(b.name); showStage(b); };
    const bot = lastBots.find((b) => b.name === state.waking);
    if (bot) wake(bot);
    // A bot just created is not in the last list drawn yet: fetch, then show it.
    else if (state.waking) refresh().then(() => { const b = lastBots.find((x) => x.name === state.waking); if (b) wake(b); });
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
    const label = bot ? labelOf(bot) : state.outdated;
    const busy = bot && inCall(bot);
    showStage(bot || { name: state.outdated }, {
      note: busy
        ? `${label} is running an older version of the app, so it can't show here. Restart it after its call.`
        : `${label} is running an older version of the app, so it can't show here until it restarts.`,
      pulse: false,
      action: busy ? null : { label: `Restart ${label}`, run: () => api.invoke('supervisor:restart-bot', state.outdated) },
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

// ── New bot ──

let creatingBot = false;
function newBotRow() {
  const row = el('div', 'bot selectable new-bot');
  const tile = el('div', 'avatar new-tile');
  tile.append(el('span', null, '+'));
  const who = el('div', 'who');
  who.append(el('div', 'name', creatingBot ? 'Creating…' : 'New bot'));
  row.append(tile, who);
  row.addEventListener('click', async () => {
    if (creatingBot) return;
    creatingBot = true;
    refresh();
    const r = await api.invoke('supervisor:new-bot').catch((e) => ({ ok: false, error: e.message }));
    creatingBot = false;
    if (!r?.ok && r?.name) rowErrors.set(r.name, `Could not start the new bot: ${r.error || 'unknown error'}`);
    refresh();
  });
  return row;
}

// ── The account line pinned to the sidebar's bottom ──

// The account, and the gear for App Settings beside it: machine-wide settings
// live with the account, down here, so the only gear in the window means "the
// app". A bot's own settings are its pane's "Edit <bot>".
function appSettingsGear() {
  const gear = el('button', 'gear');
  gear.title = 'App Settings: voices, keys and everything shared by all bots (⌘,)';
  gear.setAttribute('aria-label', 'App Settings');
  gear.append(el('i', 'ui-icon ui-icon-gear'));
  gear.addEventListener('click', () => api.invoke('supervisor:app-settings').catch(() => {}));
  return gear;
}

// The account, drawn twice from one answer: the full line in the sidebar's
// footer, and a stacked picture over the gear on the collapsed rail.
async function renderAccount() {
  const a = await api.invoke('supervisor:account').catch(() => ({ signedIn: null }));
  renderAccountLine(document.getElementById('account'), a);
  renderAccountRail(document.getElementById('railAccount'), a);
}

const openAccount = () => api.invoke('supervisor:open-account').catch(() => {});
async function signIn(btn) {
  if (btn) btn.disabled = true;
  const r = await api.invoke('supervisor:sign-in').catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { if (btn) { btn.disabled = false; btn.title = r?.error || 'Could not sign in'; } return false; }
  setTimeout(renderAccount, 3000);
  return true;
}

function accountPicture(a) {
  if (!a.avatarUrl) return null;
  const img = el('img', 'me-avatar');
  img.alt = '';
  img.referrerPolicy = 'no-referrer'; // Google's image host refuses some referrers
  img.src = a.avatarUrl;
  return img;
}

function renderAccountLine(box, a) {
  if (!box) return;
  box.replaceChildren();
  box.classList.toggle('signed-out', a.signedIn === false);
  if (a.signedIn) {
    // You, as the website shows you: your picture and email, opening your
    // account page there.
    const who = el('button', 'who');
    who.title = 'Your vibeconferencing.com account (one sign-in covers every bot). Opens in your browser.';
    const img = accountPicture(a);
    if (img) { img.addEventListener('error', () => img.remove()); who.append(img); } // no picture beats a broken one
    who.append(el('span', 'me-email', a.email || a.name || 'Signed in'));
    who.addEventListener('click', openAccount);
    box.append(who);
  } else if (a.signedIn === false) {
    box.append(el('span', 'who', 'Not signed in'));
    const btn = el('button', 'ghost', 'Sign in');
    btn.addEventListener('click', async () => {
      if (!(await signIn(btn))) btn.textContent = btn.title || 'Could not sign in';
    });
    box.append(btn);
  } else {
    // Could not tell (offline): say nothing rather than something wrong.
    box.append(el('span', 'who', ''));
  }
  box.append(appSettingsGear());
}

function renderAccountRail(box, a) {
  if (!box) return;
  box.replaceChildren();
  if (a.signedIn) {
    const me = el('button', 'me');
    me.title = `${a.email || a.name || 'Signed in'}: your vibeconferencing.com account. Opens in your browser.`;
    me.setAttribute('aria-label', 'Your account');
    const img = accountPicture(a);
    const initial = () => el('span', 'me-initial', (a.name || a.email || '?').trim().charAt(0).toUpperCase());
    if (img) { img.addEventListener('error', () => img.replaceWith(initial())); me.append(img); }
    else me.append(initial());
    me.addEventListener('click', openAccount);
    box.append(me);
  } else if (a.signedIn === false) {
    // Signed out: an empty seat where your picture would be. Click to sign in.
    const me = el('button', 'me');
    me.title = 'Not signed in to vibeconferencing.com. Click to sign in.';
    me.setAttribute('aria-label', 'Sign in');
    me.append(el('span', 'me-ring'));
    me.addEventListener('click', () => signIn(me));
    box.append(me);
  }
  box.append(appSettingsGear());
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
