# Your cloud box

A Linux machine in AWS running Vibeconferencing, so your bot can join calls
without your laptop being open. One box per person.

Everything below goes through `scripts/vibeconf-attach.sh`. Put it on your PATH:

```bash
ln -s ~/Developer/vibeconf-app/scripts/vibeconf-attach.sh /usr/local/bin/vibeconf-attach
echo 'export VIBECONF_BOX=vibeconf-seth' >> ~/.zshrc   # your own box
```

## Daily use

```bash
vibeconf-attach --list        # which boxes exist, which are running (= costing money)
vibeconf-attach               # start the box if needed, then land in your agent's session
vibeconf-attach --stop        # stop it when you are done
```

`vibeconf-attach` with no arguments is the main one. It starts the box if it is
stopped, waits for it to register, finds your agent's tmux session and drops you
inside it. **You are attached to the live session driving the bot** — you can
watch it work and type at it.

**Detach with `Ctrl-B` then `D`.** The agent keeps running. Closing the terminal
or losing your connection is also fine; that is the point of the tmux shape
(#329). Detaching is NOT the same as stopping the box.

## Seeing the screen

```bash
vibeconf-attach --screen      # leave this running; it holds the tunnel open
open vnc://localhost:5900     # in another terminal, or Finder → Go → Connect to Server
```

macOS Screen Sharing is a VNC client, so there is nothing to install. The box
runs `xvfb`, `x11vnc` and `noVNC` as systemd services, with x11vnc bound to
loopback — so it is not exposed to the internet and must be tunnelled. The
password is in `~/.vnc/passwd` on the box.

You need this for the one-time logins below, and any time you want to see what
the app is actually showing.

## Setting up a new box (once per person)

The AMI carries the software. It deliberately does NOT carry anyone's identity,
so each box needs its own logins. See wanderingstan/vibeconferencing#508.

1. `vibeconf-attach --screen`, connect with Screen Sharing.
2. In the app, **sign in to vibeconferencing.com** and **connect Calendar
   access**. This is the one that matters: calendar auto-join reads *your*
   Google Calendar through the website and matches events against this bot.
3. In a terminal on the box (`vibeconf-attach --shell`), run `claude` once and
   sign in. Each person's own Claude account.
4. Optionally set a voice (ElevenLabs key), or leave the bot voiceless.

**Your bot does not need its own Google account.** It joins as a guest. The
Google identity in play is *yours*, on the website, for reading your calendar.

## Getting the bot into calls

**Scheduled:** invite the bot to a Google Calendar event, either by adding its
`calendarIdentityEmail` as a guest (it does not have to be a real address) or by
putting `#vibeconf:<botname>` in the title or description. The app polls your
calendar and joins at the right time.

**Ad hoc:** attach with `vibeconf-attach` and tell the agent to `/join-call
<meet-code>`.

## Cost

A `t3.large` is roughly **$0.08/hour**, so about **$60/month** if left running
continuously. `vibeconf-attach --stop` when you are done for the day; starting
again takes about a minute.

Leaving it up is the right call while a bot is expected to join scheduled calls
on its own — a stopped box cannot watch a calendar. Waking on a calendar event
is tracked in #301.

## When something is wrong

```bash
vibeconf-attach --sessions    # is the agent session there at all?
vibeconf-attach --shell       # a plain shell on the box
```

No session usually means the bot has not joined a call yet (the session is
created at join), or `linuxAgentTmux` is off for that box — it is off by default
(#329) and should be **on** for a personal box, since the attachable session is
the whole point.

Access is IAM, not SSH keys: there is no inbound port open and no IP allowlist,
so moving between home and a coffee shop changes nothing. If `vibeconf-attach`
says it cannot see your box, that is a permissions question, not a network one.
