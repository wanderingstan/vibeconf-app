#!/usr/bin/env python3
"""The process diagram: the app window, its bot processes, and the agent sessions
that drive them, with every process boundary drawn (#301).

Run from anywhere: python3 media/processes-diagram.py. Writes
media/processes-{light,dark}.svg. Same visual system as the architecture
diagram (docs/STYLE-GUIDE.md, media/restyle-fluent.py): Fluent palette, Syne,
DM Sans, JetBrains Mono, embedded from the app's vendored fonts so the SVG
renders the same anywhere. Brand icons come from media/brand-icons.json.
Bot faces are the app's own emoji PNGs, resized with ImageMagick (`magick`
must be on PATH to regenerate).
"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, '..', 'electron-app', 'renderer', 'fonts')
ICONS = json.load(open(os.path.join(HERE, 'brand-icons.json')))

LIGHT = dict(
    bg='#FFF4DA', paper='#FFFDF7', ink='#4A3140', soft='#6B5566', faint='#9A8798',
    pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#F1D9A4',
    card_stroke='#4A3140', planned_fill='#FFF4DA', planned_stroke='#9A8798', planned_text='#6B5566',
    row_fill='#FFF4DA', row_stroke='#F1D9A4', wire='#4A3140', owner='#E62776', owner_text='#B31199',
    eyebrow='#9F0BA4', star='#E62776', mono_icon='#000', region='#9A8798',
    shadow='flood-color="#4A3140" flood-opacity="0.20"',
)
# As in restyle-fluent.py: ground is black, cards are ink, inset rows the Fluent set's darkest pixel.
DARK = dict(
    bg='#000000', paper='#4A3140', ink='#FFF4DA', soft='#F1D9A4', faint='#9A8798',
    pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#6B5566',
    card_stroke='#FFE7B3', planned_fill='#000000', planned_stroke='#9A8798', planned_text='#F1D9A4',
    row_fill='#3F2831', row_stroke='#6B5566', wire='#FFE7B3', owner='#E62776', owner_text='#FF7BB0',
    eyebrow='#E62776', star='#FFE7B3', mono_icon='#FFF4DA', region='#9A8798',
    shadow='flood-color="#000000" flood-opacity="0.35"',
)

W, H = 1180, 826
SYNE = "Syne, Futura, 'Trebuchet MS', sans-serif"
MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace"


def font_css():
    def face(family, file, weights):
        data = base64.b64encode(open(os.path.join(FONTS, file), 'rb').read()).decode()
        return f"@font-face{{font-family:'{family}';font-weight:{weights};src:url(data:font/woff2;base64,{data}) format('woff2');}}"
    # The vendored files are variable fonts: one file covers every weight.
    return ''.join([face('Syne', 'Syne-800.woff2', '400 800'),
                    face('DM Sans', 'DMSans-400.woff2', '100 1000'),
                    face('JetBrains Mono', 'JetBrainsMono-400.woff2', '100 800')])


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def render(T):
    o = []
    a = o.append

    def text(x, y, s, size=12, weight=400, fill=None, family=None, anchor='start', spacing=None):
        fam = f' font-family="{family}"' if family else ''
        ls = f' letter-spacing="{spacing}"' if spacing is not None else ''
        a(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}"{fam}{ls} fill="{fill or T["ink"]}" text-anchor="{anchor}">{esc(s)}</text>')

    def eyebrow(x, y, s, sub=None, anchor='start'):
        a(f'<text x="{x}" y="{y}" font-size="11" font-weight="700" font-family="{MONO}" letter-spacing="2" fill="{T["eyebrow"]}" text-anchor="{anchor}">'
          f'<tspan fill="{T["star"]}">✦ </tspan>{esc(s)}</text>')
        if sub:
            text(x, y + 16, sub, 12, fill=T['soft'], anchor=anchor)

    def box(x, y, w, h, planned=False, stroke_w=1.5, rx=6):
        if planned:
            a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{T["planned_fill"]}" stroke="{T["planned_stroke"]}" stroke-width="1.5" stroke-dasharray="5 4"/>')
        else:
            a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="{stroke_w}" filter="url(#sh)"/>')

    def row(x, y, w, title, sub, h=34):
        a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{T["row_fill"]}" stroke="{T["row_stroke"]}" stroke-width="1"/>')
        text(x + 10, y + 15, title, 12, 600)
        text(x + 10, y + 28, sub, 10.5, fill=T['soft'])

    def icon(name, x, y, size=26):
        ic = ICONS[name]
        attrs = ic['attrs'].replace('width="30" height="30"', f'width="{size}" height="{size}"').replace('fill="#000"', f'fill="{T["mono_icon"]}"')
        a(f'<svg x="{x}" y="{y}" {attrs}>{ic["inner"]}</svg>')

    def emoji(set_name, code, x, y, size=30):
        # The bot's face, from the app's own emoji sets (electron-app/emoji/<set>/<code>.png).
        import subprocess
        src = os.path.join(HERE, '..', 'electron-app', 'emoji', set_name, f'{code}.png')
        png = subprocess.run(['magick', src, '-resize', '96x96', '-strip', 'PNG32:-'], capture_output=True, check=True).stdout
        a(f'<image x="{x}" y="{y}" width="{size}" height="{size}" href="data:image/png;base64,{base64.b64encode(png).decode()}"/>')

    def wire(pts, kind='http', start=False, end=True):
        d = ' '.join(f'{"M" if i == 0 else "L"}{px},{py}' for i, (px, py) in enumerate(pts))
        if kind == 'owner':
            style = f'stroke="{T["owner"]}" stroke-width="2.2"'
            m = 'arrO'
        elif kind == 'lookup':
            style = f'stroke="{T["wire"]}" stroke-width="1.4" stroke-dasharray="2 4" stroke-linecap="round"'
            m = 'arr'
        else:
            style = f'stroke="{T["wire"]}" stroke-width="1.6"'
            m = 'arr'
        ms = (f' marker-start="url(#{m})"' if start else '') + (f' marker-end="url(#{m})"' if end else '')
        a(f'<path d="{d}" fill="none" {style}{ms}/>')

    def label(x, y, s, anchor='middle', fill=None, mono=True, size=10):
        text(x, y, s, size, 700 if mono else 500, fill=fill or T['soft'], family=MONO if mono else None, anchor=anchor)

    a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="\'DM Sans\', \'Avenir Next\', -apple-system, sans-serif">')
    a(f'<defs><style>{font_css()}</style>')
    a(f'<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{T["wire"]}"/></marker>')
    a(f'<marker id="arrO" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{T["owner"]}"/></marker>')
    a(f'<filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="-1" dy="2" stdDeviation="2.4" {T["shadow"]}/></filter></defs>')
    a(f'<rect width="{W}" height="{H}" fill="{T["bg"]}"/>')

    # ── Title ──
    text(60, 54, 'vibeconferencing: processes', 30, 800, family=SYNE, spacing=-0.6)
    text(60, 80, 'One app window, one process per bot, one agent per call. Every solid box is its own process: its own memory, its own crash.', 14, fill=T['soft'])

    # Layout: agents on the left, the app (main process + its bot children) in the
    # middle, call platforms on the right. Same reading direction as the README's
    # architecture diagram. Each agent sits on the same row as the bot it drives.
    ROW = [362, 496, 630]                   # Charlie, Bob, Other bots
    RH = 104
    SX, SW = 56, 230                        # agent sessions column
    RX, RY, RW, RB = 330, 150, 570, 682     # the app region (x, top, width, bottom)
    BX, BW = 400, 436                       # bot boxes inside the app region
    GUT = RX + RW - 36                      # right gutter inside the region: spawn trunk
    PX, PW = 960, 164                       # call platforms column

    # ── This Mac ──
    a(f'<rect x="36" y="104" width="884" height="660" rx="12" fill="none" stroke="{T["region"]}" stroke-width="1.5" stroke-dasharray="7 5"/>')
    eyebrow(56, 132, 'THIS MAC', 'everything inside talks over 127.0.0.1 only')

    # ── The app: one region, one main process, N bot processes ──
    a(f'<rect x="{RX}" y="{RY}" width="{RW}" height="{RB - RY}" rx="10" fill="none" stroke="{T["line"]}" stroke-width="2"/>')
    eyebrow(RX + 16, RY - 10, 'VIBECONFERENCING.APP', None)
    AX, AY, AW, AH = RX + 16, RY + 14, RW - 32, 146
    box(AX, AY, AW, AH, stroke_w=2)
    a(f'<g transform="translate({AX + 20},{AY + 16}) scale(0.125)"><circle cx="64" cy="64" r="56" fill="#D97757"/><rect x="136" y="8" width="112" height="112" rx="6" fill="#7B68EE"/><rect x="8" y="136" width="112" height="112" rx="6" fill="#E95678"/><circle cx="192" cy="192" r="56" fill="#45D4CF"/></g>')
    text(AX + 64, AY + 30, 'main process', 20, 800, family=SYNE, spacing=-0.3)
    text(AX + 64, AY + 47, 'The one window you see. It owns the bots.', 11.5, fill=T['soft'])
    a(f'<line x1="{AX + 20}" y1="{AY + 58}" x2="{AX + AW - 20}" y2="{AY + 58}" stroke="{T["line"]}" stroke-width="2"/>')
    cw = (AW - 40 - 16) // 2
    c1, c2 = AX + 20, AX + 20 + cw + 16
    row(c1, AY + 66, cw, 'Stage', "the selected bot's real panel, relayed")
    row(c2, AY + 66, cw, 'Sidebar', 'bots, upcoming calls, account')
    row(c1, AY + 104, cw, 'Directory  :7864', 'where agents and skills find bots')
    row(c2, AY + 104, cw, 'Bot children', 'spawns bots, sees every exit, reads output')
    DIR_Y = AY + 104 + 17                   # directory row, vertical centre
    AB = AY + AH                            # bottom of the main process box

    # ── Bot processes (one row each) ──
    rw3 = (BW - 28 - 16) // 3
    for y, (name, port, face) in zip(ROW[:2], [('Charlie', '7885', ('fluent3d', '1f60e')), ('Bob', '7887', ('redpanda', '1f60a'))]):
        box(BX, y, BW, RH, stroke_w=2)
        emoji(face[0], face[1], BX + 14, y + 12, 34)
        text(BX + 56, y + 27, name, 17, 800, family=SYNE, spacing=-0.3)
        text(BX + 56, y + 43, f'bot process · port {port}', 11, fill=T['soft'])
        row(BX + 14, y + 58, rw3, 'Local API', 'tools, status, relay', 34)
        row(BX + 14 + rw3 + 8, y + 58, rw3, 'Panel', 'hidden; shown on stage', 34)
        row(BX + 14 + 2 * (rw3 + 8), y + 58, rw3, 'Call view', 'the meeting itself', 34)
    PANEL_X = BX + 14 + rw3 + 8 + rw3 // 2  # centre of the Panel row
    # Other bots straddle the app's edge: a bot process, but not the app's child.
    y = ROW[2]
    box(BX, y, BW, RH, planned=True)
    text(BX + 14, y + 26, 'Other bots', 17, 800, family=SYNE, fill=T['planned_text'], spacing=-0.3)
    text(BX + 14, y + 42, 'started by hand, e.g. --profile=codex', 11, fill=T['planned_text'])
    text(BX + 14, y + 66, "Still a bot process, but not the app's child. The app finds it by scanning", 11, fill=T['planned_text'])
    text(BX + 14, y + 82, 'ports and stops it over HTTP.', 11, fill=T['planned_text'])

    # main process → bots: the parent/child tree down the right gutter
    wire([(GUT, AB), (GUT, ROW[1] + 18)], 'owner', end=False)
    wire([(GUT, ROW[0] + 18), (BX + BW, ROW[0] + 18)], 'owner')
    wire([(GUT, ROW[1] + 18), (BX + BW, ROW[1] + 18)], 'owner')
    label(GUT - 10, ROW[0] - 36, 'spawns each bot as its own child', anchor='end', fill=T['owner_text'], mono=False, size=11.5)
    label(GUT - 10, ROW[0] - 22, 'quit · hello · show me', anchor='end', fill=T['owner_text'], size=9.5)
    label(GUT - 10, ROW[0] - 8, 'sees every exit', anchor='end', fill=T['owner_text'], size=9.5)
    # ...and finds the ones it did not start
    scan_x = GUT + 18
    wire([(scan_x, AB), (scan_x, ROW[2] - 18), (BX + BW - 28, ROW[2] - 18), (BX + BW - 28, ROW[2])], 'lookup')
    label(scan_x - 8, ROW[2] - 5, 'port scan', anchor='end')
    # the selected bot's panel is relayed onto the stage
    wire([(PANEL_X, ROW[0]), (PANEL_X, AB)], 'http', start=True)
    label(PANEL_X - 8, ROW[0] - 22, 'panel relay', anchor='end')
    label(PANEL_X - 8, ROW[0] - 8, 'HTTP + SSE', anchor='end')

    # ── Agent sessions ──
    eyebrow(56, 330, 'AGENT SESSIONS', 'one per bot in a call')
    for (y, who, app_name, ico, port, trigger) in [(ROW[0], "Charlie's agent", 'Claude Code', 'Claude', '7885', '/join-call'), (ROW[1], "Bob's agent", 'Codex', 'Codex', '7887', '"join my call"')]:
        box(SX, y, SW, RH, stroke_w=2)
        icon(ico, SX + 14, y + 12)
        text(SX + 50, y + 27, who, 15, 600)
        text(SX + 50, y + 43, f'{app_name} · opened by its bot', 10.5, fill=T['soft'])
        row(SX + 14, y + 50, SW - 28, 'MCP server', f'its stdio child · pinned to {port}', 34)
        # how the human kicks it off: a skill in Claude Code, plain language elsewhere
        text(SX + 14, y + 97, trigger, 10.5, 700, fill=T['eyebrow'], family=MONO)
        text(SX + SW - 14, y + 97, 'calls join_call', 9.5, fill=T['soft'], anchor='end')
        # a session's MCP server talks to its own bot's local API
        wire([(SX + SW, y + 67), (BX, y + 67)], 'http')
        label((SX + SW + BX) / 2, y + 60, 'HTTP + token')
    # ...and finds it through the app's directory
    # Down the session box's right edge, clear of the AGENT SESSIONS eyebrow.
    wire([(SX + SW - 16, ROW[0]), (SX + SW - 16, DIR_Y), (AX, DIR_Y)], 'lookup')
    label(SX + SW - 24, DIR_Y + 20, 'finds its bot', anchor='end')
    label(SX + SW - 24, DIR_Y + 34, ':7864', anchor='end')

    # ── Call platforms, outside this Mac ──
    eyebrow(PX, 412, 'CALL PLATFORMS', 'bots join as participants')
    names = ['Google Meet', 'Zoom', 'Microsoft Teams', 'Slack Huddles']
    for i, n in enumerate(names):
        y = 442 + i * 46
        box(PX, y, PW, 38)
        icon(n, PX + 10, y + 8, 22)
        text(PX + 42, y + 24, n, 13, 600)
    bus_y = 442 + 2 * 46
    wire([(RX + RW, bus_y), (PX, bus_y)], 'http', start=True)

    # ── Key ──
    eyebrow(PX, 132, 'KEY')
    ky = 152
    a(f'<rect x="{PX}" y="{ky}" width="34" height="22" rx="4" fill="{T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="2"/>')
    text(PX + 44, ky + 10, 'a process', 11.5, 600)
    text(PX + 44, ky + 24, 'own memory, own crash', 10.5, fill=T['soft'])
    ky += 42
    wire([(PX, ky + 11), (PX + 34, ky + 11)], 'owner')
    text(PX + 44, ky + 10, 'parent to child', 11.5, 600)
    text(PX + 44, ky + 24, 'spawn + private channel', 10.5, fill=T['soft'])
    ky += 42
    wire([(PX, ky + 11), (PX + 34, ky + 11)], 'http')
    text(PX + 44, ky + 10, 'HTTP', 11.5, 600)
    text(PX + 44, ky + 24, 'local port, bot token', 10.5, fill=T['soft'])
    ky += 42
    wire([(PX, ky + 11), (PX + 34, ky + 11)], 'lookup')
    text(PX + 44, ky + 10, 'lookup', 11.5, 600)
    text(PX + 44, ky + 24, 'directory or port scan', 10.5, fill=T['soft'])
    ky += 42
    a(f'<rect x="{PX}" y="{ky}" width="34" height="22" rx="4" fill="none" stroke="{T["line"]}" stroke-width="2"/>')
    text(PX + 44, ky + 10, 'the app', 11.5, 600)
    text(PX + 44, ky + 24, 'one window, many processes', 10.5, fill=T['soft'])
    ky += 42
    a(f'<rect x="{PX}" y="{ky}" width="34" height="22" rx="4" fill="none" stroke="{T["region"]}" stroke-width="1.5" stroke-dasharray="4 3"/>')
    text(PX + 44, ky + 10, 'machine boundary', 11.5, 600)
    text(PX + 44, ky + 24, 'beyond it: the internet', 10.5, fill=T['soft'])

    # ── Footer ──
    text(60, 802, "A bot that crashes takes nothing else down. The app sees the exit and its reason; if the app goes away, its bots finish their calls and quit.", 12, fill=T['soft'])

    a('</svg>')
    return '\n'.join(o)


for name, T in [('light', LIGHT), ('dark', DARK)]:
    out = os.path.join(HERE, f'processes-{name}.svg')
    open(out, 'w').write(render(T))
    print('wrote', out)
