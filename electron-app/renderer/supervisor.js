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
  refresh: document.getElementById('refresh'),
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

function inCall(bot) {
  return bot.running && bot.callStatus && bot.callStatus !== 'idle';
}

// The words behind the status dot: what a person would say the bot is doing.
// The port rides along because it is how every log line and agent names a bot.
function describeState(bot) {
  if (inCall(bot)) return { cls: 'call', text: bot.roomId ? `In a call · ${bot.roomId}` : `In a call (${bot.callStatus})` };
  if (bot.running) return { cls: 'up', text: 'Running' };
  return { cls: '', text: 'Not running' };
}

// In a call, then running, then the rest; alphabetical by display name within
// each. The bots you might act on are the ones near the top.
function rank(bot) { return inCall(bot) ? 0 : bot.running ? 1 : 2; }
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
  box.append(el('span', `dot ${inCall(bot) ? 'call' : bot.running ? 'up' : ''}`));
  return box;
}

function renderBots({ bots = [], orphans = [] }) {
  els.bots.replaceChildren();
  const up = bots.filter((b) => b.running).length;
  els.count.textContent = bots.length ? `${up} of ${bots.length} running` : '';
  els.bots.classList.toggle('many', bots.length > 6);
  if (!bots.length) {
    els.bots.append(el('div', 'empty', 'No bots configured yet.'));
  }

  const sorted = [...bots].sort((a, b) => rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b)));
  for (const bot of sorted) {
    const row = el('div', `bot${bot.running ? '' : ' off'}`);
    row.append(avatarFor(bot));

    const who = el('div', 'who');
    // The display name is what a person calls this bot; the profile is what the
    // machine calls it. Both, because they routinely differ — and the profile is
    // what every log line, port and folder is named after.
    const name = el('div', 'name', labelOf(bot));
    if (bot.isDefault) name.append(el('span', 'tag', 'default'));
    who.append(name);
    const state = describeState(bot);
    const sub = el('div', 'sub');
    sub.append(el('span', `state ${state.cls}`, state.text));
    const where = [bot.name !== labelOf(bot) ? bot.name : null, bot.port ? `port ${bot.port}` : null].filter(Boolean);
    if (where.length) sub.append(document.createTextNode(` · ${where.join(' · ')}`));
    sub.title = `${bot.name}${bot.port ? ` · port ${bot.port}` : ''}`;
    who.append(sub);
    row.append(who);

    const open = el('button', bot.running ? '' : 'primary', bot.running ? 'Show' : 'Open');
    open.addEventListener('click', async () => {
      open.disabled = true;
      open.textContent = bot.running ? 'Showing…' : 'Opening…';
      const result = await api.invoke(bot.running ? 'supervisor:focus' : 'supervisor:launch', bot.name);
      if (!result?.ok) {
        open.textContent = 'Failed';
        open.title = result?.error || 'unknown error';
      }
      // A launched bot takes a moment to bind its port, so the refresh that
      // would flip this row to "running" is deliberately delayed rather than
      // immediate — an instant refresh always reports "not running" and reads
      // as the launch having failed.
      setTimeout(refresh, 2500);
    });
    row.append(open);
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
    els.events.append(el('div', 'empty', 'Nothing scheduled.'));
    return;
  }
  for (const event of events) {
    const row = el('div', 'event');
    row.append(el('span', 'when', whenLabel(event.start)));
    const what = el('div', 'what');
    what.append(el('div', 'title', event.summary || '(untitled)'));
    // Which bot this wakes is the whole point of showing it here — an upcoming
    // meeting nobody is assigned to is a meeting no bot will join.
    if (event.forProfile) what.append(el('div', 'for', `→ ${event.forProfile}`));
    row.append(what);
    els.events.append(row);
  }
}

async function refresh() {
  els.refresh.disabled = true;
  try {
    renderBots(await api.invoke('supervisor:fleet'));
  } finally {
    els.refresh.disabled = false;
  }
}

// The process pushes after every tick, so the window stays current without
// polling it a second time from here.
api.on('supervisor-state', (state) => {
  renderEvents(state || {});
  if (state?.lastTick) {
    els.tickStatus.textContent = `Last checked ${new Date(state.lastTick).toLocaleTimeString()}`;
  }
  refresh();
});

els.refresh.addEventListener('click', () => {
  api.invoke('supervisor:tick').catch(() => {});
  refresh();
});

refresh();
