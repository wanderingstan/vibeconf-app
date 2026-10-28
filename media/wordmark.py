#!/usr/bin/env python3
"""The wordmark: the four-shape logo and 'vibeconferencing' in Syne 800, on a
transparent background, for the top of the README.

Run from anywhere: python3 media/wordmark.py. Writes media/wordmark-light.svg
(plum ink) and media/wordmark-dark.svg (cream), per docs/STYLE-GUIDE.md. The
font is embedded from the app's vendored Syne so it renders the same anywhere.
"""
import base64, os

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, '..', 'electron-app', 'renderer', 'fonts', 'Syne-800.woff2')

W, H = 900, 120
LOGO = 72


def svg(fill):
    font = base64.b64encode(open(FONT, 'rb').read()).decode()
    s = LOGO / 256
    x_text = 24 + LOGO + 22
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs><style>@font-face{{font-family:'Syne';font-weight:800;src:url(data:font/woff2;base64,{font}) format('woff2');}}</style></defs>
<g transform="translate(24,{(H - LOGO) / 2}) scale({s})"><circle cx="64" cy="64" r="56" fill="#D97757"/><rect x="136" y="8" width="112" height="112" rx="6" fill="#7B68EE"/><rect x="8" y="136" width="112" height="112" rx="6" fill="#E95678"/><circle cx="192" cy="192" r="56" fill="#45D4CF"/></g>
<text x="{x_text}" y="{H / 2 + 20}" font-family="Syne, Futura, 'Trebuchet MS', sans-serif" font-size="56" font-weight="800" letter-spacing="-1.4" fill="{fill}">vibeconferencing</text>
</svg>
'''


if __name__ == '__main__':
    for name, fill in [('light', '#4A3140'), ('dark', '#FFF4DA')]:
        with open(os.path.join(HERE, f'wordmark-{name}.svg'), 'w') as f:
            f.write(svg(fill))
    print('ok')
