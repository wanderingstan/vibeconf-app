#!/usr/bin/env python3
"""The process diagram: the app window, its bot processes, and the agent sessions
that drive them, with every process boundary drawn (#301).

Run from anywhere: python3 media/processes-diagram.py. Writes
media/processes-{light,dark}.svg. Same visual system as the architecture
diagram (docs/STYLE-GUIDE.md, media/restyle-fluent.py): Fluent palette, Syne,
DM Sans, JetBrains Mono, embedded from the app's vendored fonts so the SVG
renders the same anywhere. Brand icons come from media/brand-icons.json.
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
# As in restyle-fluent.py: ground is the Fluent set's darkest pixel, cards are ink.
DARK = dict(
    bg='#3F2831', paper='#4A3140', ink='#FFF4DA', soft='#F1D9A4', faint='#9A8798',
    pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#6B5566',
    card_stroke='#FFE7B3', planned_fill='#3F2831', planned_stroke='#9A8798', planned_text='#F1D9A4',
    row_fill='#3F2831', row_stroke='#6B5566', wire='#FFE7B3', owner='#E62776', owner_text='#FF7BB0',
    eyebrow='#E62776', star='#FFE7B3', mono_icon='#FFF4DA', region='#9A8798',
    shadow='flood-color="#000000" flood-opacity="0.35"',
)

W, H = 1120, 830
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

    # ── This Mac ──
    a(f'<rect x="36" y="104" width="860" height="660" rx="12" fill="none" stroke="{T["region"]}" stroke-width="1.5" stroke-dasharray="7 5"/>')
    eyebrow(56, 132, 'THIS MAC', 'everything inside talks over 127.0.0.1 only')

    # ── The app window ──
    AX, AY, AW, AH = 330, 150, 540, 176
    box(AX, AY, AW, AH, stroke_w=2)
    a(f'<g transform="translate({AX + 20},{AY + 16}) scale(0.125)"><circle cx="64" cy="64" r="56" fill="#D97757"/><rect x="136" y="8" width="112" height="112" rx="6" fill="#7B68EE"/><rect x="8" y="136" width="112" height="112" rx="6" fill="#E95678"/><circle cx="192" cy="192" r="56" fill="#45D4CF"/></g>')
    text(AX + 64, AY + 30, 'vibeconferencing', 20, 800, family=SYNE, spacing=-0.3)
    text(AX + 64, AY + 47, 'The app: the one window you see. Its main process owns the bots.', 11.5, fill=T['soft'])
    a(f'<line x1="{AX + 20}" y1="{AY + 62}" x2="{AX + AW - 20}" y2="{AY + 62}" stroke="{T["line"]}" stroke-width="2"/>')
    c1, c2, cw = AX + 20, AX + 280, 240
    row(c1, AY + 74, cw, 'Stage', "the selected bot's real panel, relayed")
    row(c2, AY + 74, cw, 'Sidebar', 'bots, upcoming calls, account')
    row(c1, AY + 116, cw, 'Directory  :7864', 'where agents and skills find bots')
    row(c2, AY + 116, cw, 'Bot children', 'spawns bots, sees every exit, reads output')

    # ── Bot processes ──
    BY, BW, BH = 430, 166, 176
    bx = [330, 517, 704]
    a(f'<rect x="318" y="416" width="564" height="204" rx="10" fill="none" stroke="{T["line"]}" stroke-width="1.5"/>')
    for x, (name, port) in zip(bx[:2], [('Charlie', '7885'), ('Bob', '7887')]):
        box(x, BY, BW, BH, stroke_w=2)
        text(x + 14, BY + 26, name, 17, 800, family=SYNE, spacing=-0.3)
        text(x + 14, BY + 42, f'bot process · port {port}', 11, fill=T['soft'])
        row(x + 12, BY + 54, BW - 24, 'Call view', 'the meeting itself', 34)
        row(x + 12, BY + 94, BW - 24, 'Panel', 'hidden; shown on stage', 34)
        row(x + 12, BY + 134, BW - 24, 'Local API', 'tools, status, relay', 34)
    x = bx[2]
    box(x, BY, BW, BH, planned=True)
    text(x + 14, BY + 26, 'Other bots', 17, 800, family=SYNE, fill=T['planned_text'], spacing=-0.3)
    text(x + 14, BY + 42, 'test fleet, or by hand', 11, fill=T['planned_text'])
    for i, s in enumerate(['Still a bot process, but', "not the app's child. The", 'app finds it by scanning', 'ports and stops it over', 'HTTP.']):
        text(x + 14, BY + 70 + i * 16, s, 11, fill=T['planned_text'])

    # app → bots: the parent/child tree, the panel relay, the scan
    ab = AY + AH
    trunk = 740
    wire([(trunk, ab), (trunk, 392)], 'owner', end=False)
    wire([(bx[0] + 83, 392), (trunk, 392)], 'owner', end=False)
    wire([(bx[0] + 83, 392), (bx[0] + 83, BY)], 'owner')
    wire([(bx[1] + 83, 392), (bx[1] + 83, BY)], 'owner')
    label(560, 384, 'spawns each bot as its own child', fill=T['owner_text'], mono=False, size=11.5)
    label(507, 408, 'quit · hello · show me', fill=T['owner_text'], size=9.5)
    label(670, 408, 'sees every exit', fill=T['owner_text'], size=9.5)
    wire([(360, ab), (360, BY)], 'http', start=True)
    label(352, 374, 'panel relay', anchor='end')
    label(352, 388, 'HTTP + SSE', anchor='end')
    wire([(820, ab), (820, BY)], 'lookup')
    label(828, 374, 'port', anchor='start')
    label(828, 388, 'scan', anchor='start')

    # ── Agent sessions ──
    eyebrow(56, 420, 'AGENT SESSIONS', 'one per bot in a call')
    SX, SW, SH = 56, 230, 128
    for (sy, who, app_name, ico, port) in [(452, "Charlie's agent", 'Claude Code', 'Claude', '7885'), (612, "Bob's agent", 'Codex', 'Codex', '7887')]:
        box(SX, sy, SW, SH, stroke_w=2)
        icon(ico, SX + 14, sy + 14)
        text(SX + 50, sy + 27, who, 15, 600)
        text(SX + 50, sy + 43, f'{app_name} · opened by its bot', 10.5, fill=T['soft'])
        a(f'<line x1="{SX + 14}" y1="{sy + 56}" x2="{SX + SW - 14}" y2="{sy + 56}" stroke="{T["line"]}" stroke-width="1.5"/>')
        row(SX + 14, sy + 66, SW - 28, 'MCP server', f'its child, over stdio · pinned to {port}', 44)
    # a session's MCP server talks to its own bot
    wire([(SX + SW, 530), (bx[0], 530)], 'http')
    label(308, 523, 'HTTP')
    label(308, 545, 'token')
    wire([(SX + SW, 690), (bx[1] + 50, 690), (bx[1] + 50, BY + BH)], 'http')
    label(450, 683, 'HTTP + token, to its own bot', mono=False, size=11)
    # ...and finds it through the app's directory
    wire([(270, 452), (270, AY + 133), (AX, AY + 133)], 'lookup')
    label(262, 340, 'finds its bot', anchor='end')
    label(262, 354, ':7864', anchor='end')

    # ── Call platforms, outside this Mac ──
    eyebrow(920, 420, 'CALL PLATFORMS', 'bots join as participants')
    names = ['Google Meet', 'Zoom', 'Microsoft Teams', 'Slack Huddles']
    for i, n in enumerate(names):
        y = 450 + i * 46
        box(920, y, 164, 38)
        icon(n, 930, y + 8, 22)
        text(962, y + 24, n, 13, 600)
    wire([(882, 518), (920, 518)], 'http', start=True)

    # ── Key ──
    eyebrow(920, 132, 'KEY')
    ky = 152
    a(f'<rect x="920" y="{ky}" width="34" height="22" rx="4" fill="{T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="2"/>')
    text(964, ky + 10, 'a process', 11.5, 600)
    text(964, ky + 24, 'own memory, own crash', 10.5, fill=T['soft'])
    ky += 42
    wire([(920, ky + 11), (954, ky + 11)], 'owner')
    text(964, ky + 10, 'parent to child', 11.5, 600)
    text(964, ky + 24, 'spawn + private channel', 10.5, fill=T['soft'])
    ky += 42
    wire([(920, ky + 11), (954, ky + 11)], 'http')
    text(964, ky + 10, 'HTTP', 11.5, 600)
    text(964, ky + 24, 'local port, bot token', 10.5, fill=T['soft'])
    ky += 42
    wire([(920, ky + 11), (954, ky + 11)], 'lookup')
    text(964, ky + 10, 'lookup', 11.5, 600)
    text(964, ky + 24, 'directory or port scan', 10.5, fill=T['soft'])
    ky += 42
    a(f'<rect x="920" y="{ky}" width="34" height="22" rx="4" fill="none" stroke="{T["region"]}" stroke-width="1.5" stroke-dasharray="4 3"/>')
    text(964, ky + 10, 'machine boundary', 11.5, 600)
    text(964, ky + 24, 'beyond it: the internet', 10.5, fill=T['soft'])

    # ── Footer ──
    text(60, 798, "A bot that crashes takes nothing else down. The app sees the exit and its reason; if the app goes away, its bots finish their calls and quit.", 12, fill=T['soft'])

    a('</svg>')
    return '\n'.join(o)


for name, T in [('light', LIGHT), ('dark', DARK)]:
    out = os.path.join(HERE, f'processes-{name}.svg')
    open(out, 'w').write(render(T))
    print('wrote', out)
