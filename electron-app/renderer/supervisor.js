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

function describeBot(bot) {
  if (!bot.running) return bot.port ? `not running · port ${bot.port}` : 'not running';
  const where = bot.roomId ? ` · ${bot.roomId}` : '';
  if (bot.callStatus && bot.callStatus !== 'idle') return `${bot.callStatus}${where} · port ${bot.port}`;
  return `running · port ${bot.port}`;
}

function renderBots({ bots = [], orphans = [] }) {
  els.bots.replaceChildren();
  if (!bots.length) {
    els.bots.append(el('div', 'empty', 'No bots configured yet.'));
  }

  for (const bot of bots) {
    const row = el('div', 'bot');
    const inCall = bot.running && bot.callStatus && bot.callStatus !== 'idle';
    row.append(el('span', `dot ${inCall ? 'call' : bot.running ? 'up' : ''}`));

    const who = el('div', 'who');
    // The display name is what a person calls this bot; the profile is what the
    // machine calls it. Both, because they routinely differ — and the profile is
    // what every log line, port and folder is named after.
    const label = bot.botName || bot.name;
    who.append(el('div', 'name', bot.isDefault ? `${label} (default)` : label));
    who.append(el('div', 'sub', `${bot.name} · ${describeBot(bot)}`));
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
    const line = el('div');
    line.append(el('span', 'when', whenLabel(event.start)));
    line.append(document.createTextNode(`  ${event.summary || '(untitled)'}`));
    row.append(line);
    // Which bot this wakes is the whole point of showing it here — an upcoming
    // meeting nobody is assigned to is a meeting no bot will join.
    if (event.forProfile) row.append(el('div', 'for', `→ ${event.forProfile}`));
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
