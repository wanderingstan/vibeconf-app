#!/usr/bin/env python3
"""The two API diagrams for docs/api: the layer cake (one API, every platform)
and the call loop (join, wait, speak, share, leave).

Run from anywhere: python3 media/api-diagrams.py. Writes
media/api-layers-{light,dark}.svg and media/api-loop-{light,dark}.svg.
Same visual system as the other diagrams (docs/STYLE-GUIDE.md): Fluent
palette, Syne, DM Sans, JetBrains Mono, embedded from the app's vendored
fonts. Brand icons come from media/brand-icons.json.
"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, '..', 'electron-app', 'renderer', 'fonts')
ICONS = json.load(open(os.path.join(HERE, 'brand-icons.json')))

LIGHT = dict(
    bg='#FFF4DA', paper='#FFFDF7', ink='#4A3140', soft='#6B5566', faint='#9A8798',
    pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#F1D9A4', paper_lo='#FFE7B3',
    card_stroke='#4A3140', planned_fill='#FFF4DA', planned_stroke='#9A8798', planned_text='#6B5566',
    row_fill='#FFF4DA', row_stroke='#F1D9A4', wire='#4A3140', eyebrow='#9F0BA4', star='#E62776',
    mono_icon='#000', band='#4A3140', band_text='#FFF4DA', band_sub='#F1D9A4',
    shadow='flood-color="#4A3140" flood-opacity="0.20"',
)
DARK = dict(
    bg='#000000', paper='#4A3140', ink='#FFF4DA', soft='#F1D9A4', faint='#9A8798',
    pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#6B5566', paper_lo='#6B5566',
    card_stroke='#FFE7B3', planned_fill='#000000', planned_stroke='#9A8798', planned_text='#F1D9A4',
    row_fill='#3F2831', row_stroke='#6B5566', wire='#FFE7B3', eyebrow='#E62776', star='#FFE7B3',
    mono_icon='#FFF4DA', band='#B31199', band_text='#FFF4DA', band_sub='#FFE7B3',
    shadow='flood-color="#000000" flood-opacity="0.35"',
)

SYNE = "Syne, Futura, 'Trebuchet MS', sans-serif"
MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace"
BODY = "'DM Sans', 'Avenir Next', -apple-system, sans-serif"


def font_css():
    def face(family, file, weights):
        data = base64.b64encode(open(os.path.join(FONTS, file), 'rb').read()).decode()
        return f"@font-face{{font-family:'{family}';font-weight:{weights};src:url(data:font/woff2;base64,{data}) format('woff2');}}"
    return ''.join([face('Syne', 'Syne-800.woff2', '400 800'),
                    face('DM Sans', 'DMSans-400.woff2', '100 1000'),
                    face('JetBrains Mono', 'JetBrainsMono-400.woff2', '100 800')])


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


class Canvas:
    def __init__(self, T, W, H):
        self.T, self.W, self.H, self.o = T, W, H, []
        a = self.o.append
        a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{BODY}">')
        a(f'<defs><style>{font_css()}</style>')
        a(f'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{T["wire"]}"/></marker>')
        a(f'<marker id="arrP" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{T["pink"]}"/></marker>')
        a(f'<filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="-1" dy="2" stdDeviation="2.4" {T["shadow"]}/></filter></defs>')
        a(f'<rect width="{W}" height="{H}" fill="{T["bg"]}"/>')

    def text(self, x, y, s, size=12, weight=400, fill=None, family=None, anchor='start', spacing=None):
        fam = f' font-family="{family}"' if family else ''
        ls = f' letter-spacing="{spacing}"' if spacing is not None else ''
        self.o.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}"{fam}{ls} fill="{fill or self.T["ink"]}" text-anchor="{anchor}">{esc(s)}</text>')

    def eyebrow(self, x, y, s, sub=None, anchor='start'):
        T = self.T
        self.o.append(f'<text x="{x}" y="{y}" font-size="11" font-weight="700" font-family="{MONO}" letter-spacing="2" fill="{T["eyebrow"]}" text-anchor="{anchor}"><tspan fill="{T["star"]}">✦ </tspan>{esc(s)}</text>')
        if sub:
            self.text(x, y + 16, sub, 12, fill=T['soft'], anchor=anchor)

    def box(self, x, y, w, h, planned=False, stroke_w=1.5, rx=6, fill=None):
        T = self.T
        if planned:
            self.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{T["planned_fill"]}" stroke="{T["planned_stroke"]}" stroke-width="1.5" stroke-dasharray="5 4"/>')
        else:
            self.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill or T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="{stroke_w}" filter="url(#sh)"/>')

    def row(self, x, y, w, title, sub=None, h=34, mono=False):
        T = self.T
        self.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{T["row_fill"]}" stroke="{T["row_stroke"]}" stroke-width="1"/>')
        if sub is None:
            self.text(x + 10, y + h / 2 + 4, title, 11.5, 700 if mono else 600, family=MONO if mono else None)
        else:
            self.text(x + 10, y + 15, title, 12, 600)
            self.text(x + 10, y + 28, sub, 10.5, fill=T['soft'])

    def icon(self, name, x, y, size=26):
        ic = ICONS[name]
        attrs = ic['attrs'].replace('width="30" height="30"', f'width="{size}" height="{size}"').replace('fill="#000"', f'fill="{self.T["mono_icon"]}"')
        self.o.append(f'<svg x="{x}" y="{y}" {attrs}>{ic["inner"]}</svg>')

    def logo(self, x, y, size=40):
        s = size / 256
        self.o.append(f'<g transform="translate({x},{y}) scale({s})"><circle cx="64" cy="64" r="56" fill="#D97757"/><rect x="136" y="8" width="112" height="112" rx="6" fill="#7B68EE"/><rect x="8" y="136" width="112" height="112" rx="6" fill="#E95678"/><circle cx="192" cy="192" r="56" fill="#45D4CF"/></g>')

    def wire(self, pts, start=False, end=True, pink=False, dashed=False):
        T = self.T
        d = ' '.join(f'{"M" if i == 0 else "L"}{px},{py}' for i, (px, py) in enumerate(pts))
        style = f'stroke="{T["pink"]}" stroke-width="2"' if pink else f'stroke="{T["wire"]}" stroke-width="1.6"'
        if dashed:
            style += ' stroke-dasharray="2 4" stroke-linecap="round"'
        m = 'arrP' if pink else 'arr'
        ms = (f' marker-start="url(#{m})"' if start else '') + (f' marker-end="url(#{m})"' if end else '')
        self.o.append(f'<path d="{d}" fill="none" {style}{ms}/>')

    def label(self, x, y, s, anchor='middle', fill=None, size=10, mono=True):
        self.text(x, y, s, size, 700 if mono else 500, fill=fill or self.T['soft'], family=MONO if mono else None, anchor=anchor)

    def pill(self, cx, cy, s, w=None):
        T = self.T
        w = w or (len(s) * 7.2 + 24)
        self.o.append(f'<rect x="{cx - w / 2}" y="{cy - 11}" width="{w}" height="22" rx="11" fill="{T["pink_deep"]}"/>')
        self.text(cx, cy + 4, s, 11, 700, fill='#FFF4DA', family=SYNE, anchor='middle')

    def done(self):
        self.o.append('</svg>')
        return '\n'.join(self.o)


# ── Diagram 1: one API, every call (left to right, like the other diagrams) ──
def layers(T):
    W, H = 1120, 880
    c = Canvas(T, W, H)
    c.text(60, 54, 'one API, every call', 30, 800, family=SYNE, spacing=-0.6)
    c.text(60, 80, 'Your code speaks one HTTP shape. The app turns it into a participant on whichever platform the call is on.', 14, fill=T['soft'])

    # ── Left: who calls it ──
    c.eyebrow(60, 130, 'YOUR CODE', 'Anything that makes HTTP requests')
    callers = [('Claude', 'Claude Code', 'via the bundled MCP server'), ('Codex', 'Codex', 'via the bundled MCP server'),
               (None, 'curl', 'raw HTTP'), (None, 'Your app', 'any language'), (None, 'The explorer', 'vibeconferencing.com/api')]
    lx, lw, ly0, step = 60, 210, 160, 72
    lys = []
    for i, (ic, name, sub) in enumerate(callers):
        y = ly0 + i * step
        c.box(lx, y, lw, 56)
        tx = lx + 50 if ic else lx + 16
        if ic:
            c.icon(ic, lx + 14, y + 15)
        c.text(tx, y + 25, name, 14, 600, family=MONO if name == 'curl' else None)
        c.text(tx, y + 42, sub, 10.5, fill=T['soft'])
        lys.append(y + 28)
    bus_l = 340
    for y in lys:
        c.o.append(f'<line x1="{lx + lw}" y1="{y}" x2="{bus_l}" y2="{y}" stroke="{T["wire"]}" stroke-width="1.3"/>')
    c.o.append(f'<line x1="{bus_l}" y1="{lys[0]}" x2="{bus_l}" y2="{lys[-1]}" stroke="{T["wire"]}" stroke-width="1.3"/>')
    mid_l = (lys[0] + lys[-1]) / 2
    c.wire([(bus_l, mid_l), (400, mid_l)])
    c.label(370, mid_l - 10, 'HTTP', size=10)
    c.label(370, mid_l + 20, 'JSON', size=10)

    # ── Middle: the API ──
    bx, by, bw = 400, 118, 320
    rows_a = [('GET  /api/sync/{room}?wait=55', 'waits for a sentence to end; returns transcript and state'),
              ('POST /api/sync/{room}', 'speak, write the board, or run an action')]
    # Real tool names, the MCP server's, each one HTTP call to this API. The
    # count is read from mcp-server/server.js so "and N more" stays true.
    import re
    src = open(os.path.join(HERE, '..', 'mcp-server', 'server.js')).read()
    all_tools = re.findall(r'^server\.tool\(\s*\n?\s*"([a-z_]+)"', src, re.M)
    shown = ['join_call', 'wait_for_speech', 'speak', 'leave_call', 'start_call', 'read_transcripts',
             'read_chat', 'send_chat', 'update_whiteboard', 'read_whiteboard', 'load_url', 'start_share',
             'share_tab', 'stop_sharing', 'click_share', 'type_share', 'get_shared_screenshot', 'play_audio',
             'set_camera', 'set_avatar_emoji', 'set_mode', 'set_caption_language', 'set_voice', 'list_voices',
             'start_recording', 'stop_recording', 'get_room_info', 'get_call_screenshot', 'post_understanding', 'bank_probe']
    shown = [t for t in shown if t in all_tools]
    more = len(all_tools) - len(shown)
    bh = 170 + len(rows_a) * 42 + 30 + ((len(shown) + 1) // 2) * 17 + 44
    c.box(bx, by, bw, bh, stroke_w=2)
    c.logo(bx + bw / 2 - 20, by + 18)
    c.text(bx + bw / 2, by + 86, 'the local API', 20, 800, family=SYNE, spacing=-0.3, anchor='middle')
    c.text(bx + bw / 2, by + 104, 'http://127.0.0.1:7865 · bearer token', 11.5, 500, fill=T['soft'], family=MONO, anchor='middle')
    c.o.append(f'<line x1="{bx + 22}" y1="{by + 122}" x2="{bx + bw - 22}" y2="{by + 122}" stroke="{T["line"]}" stroke-width="2"/>')
    y = by + 144
    c.eyebrow(bx + 22, y, 'ONE REQUEST SHAPE')
    y += 12
    for title, sub in rows_a:
        c.o.append(f'<rect x="{bx + 22}" y="{y}" width="{bw - 44}" height="36" rx="4" fill="{T["row_fill"]}" stroke="{T["row_stroke"]}" stroke-width="1"/>')
        c.text(bx + 32, y + 15, title, 11, 700, family=MONO)
        c.text(bx + 32, y + 29, sub, 9.5, fill=T['soft'])
        y += 42
    y += 18
    c.eyebrow(bx + 22, y, f'{len(all_tools)} TOOLS, ONE HTTP CALL EACH')
    y += 10
    half = (len(shown) + 1) // 2
    grid_h = half * 17 + 30
    c.o.append(f'<rect x="{bx + 22}" y="{y}" width="{bw - 44}" height="{grid_h}" rx="4" fill="{T["row_fill"]}" stroke="{T["row_stroke"]}" stroke-width="1"/>')
    for i, t in enumerate(shown):
        col, rowi = divmod(i, half)
        c.text(bx + 32 + col * 138, y + 16 + rowi * 17, t, 10.5, 500, family=MONO)
    c.text(bx + bw - 32, y + grid_h - 9, f'…and {more} more', 10.5, 500, fill=T['soft'], family=MONO, anchor='end')
    api_mid = by + bh / 2

    # ── Right: the platforms, two stacks ──
    rx, rw = 850, 210
    bus_r = 780
    c.wire([(bx + bw, api_mid), (bus_r, api_mid)])
    c.text(bus_r - 30, api_mid - 30, 'the app drives', 10, 500, fill=T['soft'], anchor='middle')
    c.text(bus_r - 30, api_mid - 18, 'each platform’s', 10, 500, fill=T['soft'], anchor='middle')
    c.text(bus_r - 30, api_mid - 6, 'own web client', 10, 500, fill=T['soft'], anchor='middle')

    def stack(y0, plats, h=50, step=60):
        ys = []
        for i, (ic, name, sub, planned) in enumerate(plats):
            y = y0 + i * step
            c.box(rx, y, rw, h, planned=planned)
            c.icon(ic, rx + 12, y + (h - 26) / 2, 26)
            c.text(rx + 48, y + 23, name, 13, 600, fill=T['planned_text'] if planned else None)
            c.text(rx + 48, y + 39, sub, 10, fill=T['soft'])
            ys.append(y + h / 2)
            dash = ' stroke-dasharray="2 4" stroke-linecap="round"' if planned else ''
            c.o.append(f'<line x1="{bus_r}" y1="{y + h / 2}" x2="{rx}" y2="{y + h / 2}" stroke="{T["wire"]}" stroke-width="1.3"{dash}/>')
        return ys

    c.eyebrow(rx + rw, 130, 'MEETINGS THE BOT JOINS', 'POST a join action with the link', anchor='end')
    joins = [('Google Meet', 'Google Meet', 'join by code or link', False), ('Zoom', 'Zoom', 'join by link', False),
             ('Microsoft Teams', 'Microsoft Teams', 'join by link, lobby', False), ('Slack Huddles', 'Slack huddles', 'join by huddle URL', False),
             ('WhatsApp', 'WhatsApp', 'join by call link', False), ('FaceTime', 'FaceTime', 'planned', True)]
    ys1 = stack(160, joins)
    c.eyebrow(rx + rw, 556, 'CALLS THE BOT ANSWERS', 'Someone calls the bot; it picks up', anchor='end')
    answers = [('Telegram', 'Telegram', 'audio, chat', False), ('WhatsApp', 'WhatsApp', 'audio, video, share, chat', False),
               ('Phone', 'Phone (Twilio)', 'a real number, audio', False), ('Discord', 'Discord', 'planned', True)]
    ys2 = stack(586, answers)
    c.o.append(f'<line x1="{bus_r}" y1="{ys1[0]}" x2="{bus_r}" y2="{ys2[2]}" stroke="{T["wire"]}" stroke-width="1.3"/>')
    c.o.append(f'<line x1="{bus_r}" y1="{ys2[2]}" x2="{bus_r}" y2="{ys2[-1]}" stroke="{T["wire"]}" stroke-width="1.3" stroke-dasharray="2 4" stroke-linecap="round"/>')

    # ── Bottom left: what the room sees ──
    c.eyebrow(60, 560, 'WHAT THE ROOM SEES', 'A normal participant, not an integration')
    for i, s in enumerate(['a tile with a name and a face', 'a microphone that speaks', 'a camera: avatar or board', 'chat messages', 'a screen share']):
        c.row(60, 578 + i * 36, 280, s, h=30)

    c.text(W - 60, H - 24, 'Logos are trademarks of their respective owners.', 11, fill=T['faint'], anchor='end')
    return c.done()


# ── Diagram 2: the call loop ────────────────────────────────────────────────
def loop(T):
    W, H = 1120, 800
    c = Canvas(T, W, H)
    c.text(60, 54, 'the call loop', 30, 800, family=SYNE, spacing=-0.6)
    c.text(60, 80, 'One long-poll is the whole listening side. Everything the bot does is a POST to the same room.', 14, fill=T['soft'])

    # Three lanes
    lanes = [('your code', 'agent, script, curl', 200), ('the bot', 'the app, 127.0.0.1:7865', 560), ('the call', 'Meet, Zoom, Teams, Slack', 920)]
    top, bottom = 150, 730
    for name, sub, x in lanes:
        c.box(x - 110, top - 44, 220, 48)
        c.text(x, top - 18, name, 16, 800, family=SYNE, anchor='middle')
        c.text(x, top - 2, sub, 10.5, fill=T['soft'], anchor='middle')
        c.o.append(f'<line x1="{x}" y1="{top + 4}" x2="{x}" y2="{bottom}" stroke="{T["line"]}" stroke-width="2"/>')
    A, B, C = 200, 560, 920

    def step(y, frm, to, text, sub=None, pink=False, back=False):
        c.wire([(frm, y), (to, y)], pink=pink)
        mid = (frm + to) / 2
        c.label(mid, y - 8, text, size=11)
        if sub:
            c.text(mid, y + 16, sub, 10.5, fill=T['soft'], anchor='middle')

    def note(y, x, text, w=240, h=30):
        c.row(x - w / 2, y - 15, w, text, h=h)

    y = 190
    step(y, A, B, 'POST /api/sync/{room}  {meta:{action:"join-zoom", url}}', 'or join (Meet), join-teams, join-slack')
    step(y + 36, B, C, 'opens the link, clicks through pre-join', 'waits to be admitted')
    note(y + 76, C, 'the bot appears as a participant', 220)

    # the loop box
    ly, lh = 300, 280
    c.o.append(f'<rect x="{A - 150}" y="{ly}" width="{C - A + 300}" height="{lh}" rx="8" fill="none" stroke="{T["pink"]}" stroke-width="2" stroke-dasharray="6 5"/>')
    c.o.append(f'<rect x="{A - 140}" y="{ly - 11}" width="118" height="22" rx="11" fill="{T["pink_deep"]}"/>')
    c.text(A - 81, ly + 4, 'repeat', 11, 700, fill='#FFF4DA', family=SYNE, anchor='middle')

    y = ly + 36
    step(y, A, B, 'GET /api/sync/{room}?wait=55&since=<asOf>', 'blocks until someone finishes a sentence', pink=True)
    step(y + 34, C, B, 'captions, chat, who is speaking', 'the bot reads the platform’s own captions')
    step(y + 72, B, A, '200  transcript.entries[], participants, status', 'asOf is the next since', pink=True)
    note(y + 108, A, 'your model thinks', 160)
    step(y + 144, A, B, 'POST /api/sync/{room}  {transcript:[{text, emoji, urgency}]}', 'or whiteboard, or an action', pink=True)
    step(y + 180, B, C, 'speaks through its microphone', 'waits for a gap unless urgency ≥ 0.5')
    step(y + 216, B, A, '200  results.transcript  {ok, sent}', None, pink=True)

    y = ly + lh + 40
    step(y, A, B, 'POST /api/sync/{room}  {whiteboard:{content}}  then  {meta:{action:"share-whiteboard"}}', 'markdown and Mermaid')
    step(y + 34, B, C, 'the board goes out as a screen share')
    y += 76
    step(y, A, B, 'POST /api/sync/{room}  {meta:{action:"leave"}}')
    step(y + 30, B, C, 'hangs up')

    c.text(W - 60, H - 24, 'wait and silence are tunable; one waiter per bot; autoLeft tells you when the bot left on its own.', 11, fill=T['faint'], anchor='end')
    return c.done()


if __name__ == '__main__':
    for name, fn in [('api-layers', layers), ('api-loop', loop)]:
        for theme, T in [('light', LIGHT), ('dark', DARK)]:
            with open(os.path.join(HERE, f'{name}-{theme}.svg'), 'w') as f:
                f.write(fn(T))
    print('ok')
