#!/usr/bin/env python3
"""Restyle media/architecture-light.svg into the Fluent system (docs/STYLE-GUIDE.md).

Run from anywhere: python3 media/restyle-fluent.py. Writes architecture-fluent-{light,dark}.svg.

Both outputs come from the light file: the geometry is identical, only the
roles' colours change. Fonts are embedded as data URIs so the SVG renders the
brand type when GitHub serves it as an <img> (no external fetches allowed)."""
import base64, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'media/architecture-light.svg'
FONTS = ROOT / 'electron-app/renderer/fonts'

LIGHT = dict(
    bg='#FFF4DA', paper='#FFFDF7', paper_lo='#FFE7B3', ink='#4A3140', soft='#6B5566',
    faint='#9A8798', pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#F1D9A4',
    card_stroke='#4A3140', planned_fill='#FFF4DA', planned_stroke='#9A8798', planned_text='#6B5566',
    row_fill='#FFF4DA', row_stroke='#F1D9A4', pill_fill='#B31199', pill_text='#FFF4DA',
    wire='#4A3140', eyebrow='#9F0BA4', star='#E62776', mono_icon='#000',
    shadow='flood-color="#4A3140" flood-opacity="0.20"', legend_fill='#FFFDF7',
)
# A dark variant is an extrapolation: the guide only says on-air surfaces stay
# dark. Ground is black (Stan, 2026-10-22); cards are ink, their inset rows the
# Fluent set's darkest pixel (#3F2831).
DARK = dict(
    bg='#000000', paper='#4A3140', paper_lo='#6B5566', ink='#FFF4DA', soft='#F1D9A4',
    faint='#9A8798', pink='#E62776', pink_deep='#B31199', magenta='#9F0BA4', line='#6B5566',
    card_stroke='#FFE7B3', planned_fill='#000000', planned_stroke='#9A8798', planned_text='#F1D9A4',
    row_fill='#3F2831', row_stroke='#6B5566', pill_fill='#E62776', pill_text='#FFF4DA',
    wire='#FFE7B3', eyebrow='#E62776', star='#FFE7B3', mono_icon='#FFF4DA',
    shadow='flood-color="#000000" flood-opacity="0.35"', legend_fill='#4A3140',
)

def b64(name):
    return base64.b64encode((FONTS / name).read_bytes()).decode()

FONT_CSS = "\n".join(
    f"@font-face{{font-family:'{fam}';font-weight:{w};src:url(data:font/woff2;base64,{b64(f)}) format('woff2');}}"
    for fam, w, f in [
        ('Syne', 800, 'Syne-800.woff2'), ('Syne', 700, 'Syne-700.woff2'),
        ('DM Sans', 400, 'DMSans-400.woff2'), ('DM Sans', 600, 'DMSans-600.woff2'),
        ('JetBrains Mono', 700, 'JetBrainsMono-500.woff2'),
    ])

DISPLAY = "Syne, Futura, 'Trebuchet MS', sans-serif"
BODY = "'DM Sans', 'Avenir Next', -apple-system, sans-serif"
MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace"

def restyle(s, T):
    # root font + embedded fonts
    s = s.replace('font-family="Inter, -apple-system, Helvetica Neue, Helvetica, Arial, sans-serif"',
                  f'font-family="{BODY}"', 1)
    s = s.replace('<defs>', f'<defs>\n<style>{FONT_CSS}</style>', 1)
    # shadow: soft plum, down and to the left (key light upper right)
    s = re.sub(r'<feDropShadow[^>]*/>', f'<feDropShadow dx="-1" dy="2" stdDeviation="2.4" {T["shadow"]}/>', s)
    s = s.replace('<path d="M0,0 L10,5 L0,10 z" fill="#555"/>', f'<path d="M0,0 L10,5 L0,10 z" fill="{T["wire"]}"/>')
    # ground
    s = s.replace('<rect width="1120" height="800" fill="#FAFAF7"/>', f'<rect width="1120" height="800" fill="{T["bg"]}"/>')
    # title + dek
    s = s.replace('<text x="60" y="52" font-size="26" font-weight="700" fill="#1a1a1a">Vibeconferencing — architecture</text>',
                  f'<text x="60" y="54" font-size="30" font-weight="800" font-family="{DISPLAY}" letter-spacing="-0.6" fill="{T["ink"]}">vibeconferencing: architecture</text>')
    s = s.replace('<text x="60" y="78" font-size="14" fill="#555">', f'<text x="60" y="80" font-size="14" fill="{T["soft"]}">')
    # section eyebrows: mono, magenta, pink star
    def eyebrow(m):
        x, y, anchor, label = m.group(1), m.group(2), m.group(3), m.group(4)
        return (f'<text x="{x}" y="{y}" font-size="11" font-weight="700" font-family="{MONO}" letter-spacing="2" '
                f'fill="{T["eyebrow"]}" text-anchor="{anchor}"><tspan fill="{T["star"]}">✦ </tspan>{label}</text>')
    s = re.sub(r'<text x="([\d.]+)" y="(\d+)" font-size="12" font-weight="700" fill="#444" letter-spacing="1\.4" text-anchor="(start|end)">([A-Z ]+)</text>', eyebrow, s)
    s = s.replace('<text x="422" y="260" font-size="11" font-weight="700" fill="#444" letter-spacing="1.4">CORE SERVICES</text>',
                  f'<text x="422" y="260" font-size="10" font-weight="700" font-family="{MONO}" letter-spacing="1.8" fill="{T["eyebrow"]}"><tspan fill="{T["star"]}">✦ </tspan>CORE SERVICES</text>')
    s = re.sub(r'font-size="12" fill="#888"', f'font-size="12" fill="{T["soft"]}"', s)
    # cards: paper, ink line, 6px corners
    s = re.sub(r'rx="10" fill="#FFFFFF" stroke="#CFCFCF" stroke-width="1\.2"', f'rx="6" fill="{T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="1.5"', s)
    s = re.sub(r'rx="10" fill="#FBFBFA" stroke="#B8B8B8" stroke-width="1\.2"', f'rx="6" fill="{T["planned_fill"]}" stroke="{T["planned_stroke"]}" stroke-width="1.5"', s)
    # centre box
    s = s.replace('rx="14" fill="#FFFFFF" stroke="#1a1a1a" stroke-width="1.6"', f'rx="6" fill="{T["paper"]}" stroke="{T["card_stroke"]}" stroke-width="2"')
    # centre box: top raised to the eyebrow line, logo centred, title + dek centred beneath it
    s = s.replace('<rect x="400" y="160" width="320" height="344"', '<rect x="400" y="118" width="320" height="386"')
    s = s.replace('<g transform="translate(422,180) scale(0.15625)">', '<g transform="translate(540,136) scale(0.15625)">')
    s = s.replace('<text x="476" y="198" font-size="19" font-weight="700" fill="#1a1a1a">Vibeconferencing</text>',
                  f'<text x="560" y="204" font-size="20" font-weight="800" font-family="{DISPLAY}" letter-spacing="-0.3" fill="{T["ink"]}" text-anchor="middle">vibeconferencing</text>')
    s = s.replace('<text x="476" y="216" font-size="12" fill="#777">', '<text x="560" y="222" font-size="12" fill="#777" text-anchor="middle">')
    s = s.replace('stroke="#E5E5E5"/>', f'stroke="{T["line"]}" stroke-width="2"/>')
    s = re.sub(r'rx="7" fill="#F3F3F0"', f'rx="4" fill="{T["row_fill"]}" stroke="{T["row_stroke"]}" stroke-width="1"', s)
    # pills
    s = re.sub(r'rx="12" fill="#1a1a1a"', f'rx="12" fill="{T["pill_fill"]}"', s)
    s = re.sub(r'font-size="11\.5" font-weight="700" fill="#fff"', f'font-size="11.5" font-weight="700" font-family="{DISPLAY}" fill="{T["pill_text"]}"', s)
    # text roles
    s = re.sub(r'font-weight="600" fill="#1a1a1a"', f'font-weight="600" fill="{T["ink"]}"', s)
    s = re.sub(r'font-weight="600" fill="#555"', f'font-weight="600" fill="{T["planned_text"]}"', s)
    s = re.sub(r'fill="#777"', f'fill="{T["soft"]}"', s)
    s = re.sub(r'font-weight="600" fill="#444"', f'font-weight="700" font-family="{MONO}" fill="{T["soft"]}"', s)   # MCP / HTTP
    s = re.sub(r'font-size="10\.5" fill="#666"', f'font-size="10.5" fill="{T["soft"]}"', s)   # joins as / participant (prose, stays body)
    s = re.sub(r'font-size="11\.5" (fill="[^"]+")>Ollama', r'font-size="10.5" \1>Ollama', s)
    s = re.sub(r'font-size="11\.5" fill="#666"', f'font-size="11.5" fill="{T["soft"]}"', s)                       # legend
    s = s.replace('fill="#999"', f'fill="{T["faint"]}"')
    # wires
    s = re.sub(r'stroke="#555" stroke-width="1\.3"', f'stroke="{T["wire"]}" stroke-width="1.3"', s)
    s = re.sub(r'stroke="#555" stroke-width="1\.6"', f'stroke="{T["wire"]}" stroke-width="1.6"', s)
    # legend swatches
    s = s.replace('rx="4" fill="#fff" stroke="#CFCFCF" stroke-width="1.2"', f'rx="3" fill="{T["legend_fill"]}" stroke="{T["card_stroke"]}" stroke-width="1.5"')
    s = s.replace('rx="4" fill="#FBFBFA" stroke="#B8B8B8" stroke-width="1.2"', f'rx="3" fill="{T["planned_fill"]}" stroke="{T["planned_stroke"]}" stroke-width="1.5"')
    # monochrome brand icons (Apple, OpenAI, Runway, ElevenLabs...)
    s = s.replace('fill="#000"', f'fill="{T["mono_icon"]}"')
    leftovers = sorted(set(re.findall(r'#(?:1a1a1a|555|777|444|888|666|999|CFCFCF|B8B8B8|FBFBFA|F3F3F0|E5E5E5|FAFAF7)\b', s)))
    if leftovers:
        print('unmapped:', leftovers, file=sys.stderr)
    return s

src = SRC.read_text()
(ROOT / 'media/architecture-fluent-light.svg').write_text(restyle(src, LIGHT))
(ROOT / 'media/architecture-fluent-dark.svg').write_text(restyle(src, DARK))
print('ok')
