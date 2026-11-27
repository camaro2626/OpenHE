#!/usr/bin/env python3
"""Recolour Wootility's pre-rendered switch presses (41-frame strips).

    python3 scripts/switch-strip-recolor.py            # every recipe
    python3 scripts/switch-strip-recolor.py siren      # some recipes

Each base switch (src/assets/switches/wooting/<base>-side.webp, frames side by
side) is split by geometry, not colour (the Jade family is one hue
throughout): above the housing is stem; between the housing's top and the lip
is the top housing, with the stem body seen through it where `stem_zones`
says; below the lip is the bottom housing. The stem moves down by the same
amount in every part of a frame, measured from where its top sits.

A part takes a colour and a finish:
  colour  keep each pixel's lightness, swap its tint; neutral pixels (the
          metal spring, clear glass) barely move
  clear   drop the tint and lighten (optionally a light tint)
  cloudy  milky over the inside: the inside shows, softened
  opaque  a top housing: the whole part in the colour, solid; a bottom
          housing: its walls in the colour with the inside still shown,
          since the renders are cutaways (as Wootility's KOM POM)

A finish the base cannot show (a clear stem: nothing behind an opaque stem
was rendered) is not forced; the recipe says what it is instead.

The top view (one picture) gets the same treatment by area: the stem in the
middle, the top housing around it, the bottom housing at the rim.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src/assets/switches/wooting'
OUT = SRC / 'recolor'
FRAMES = 41

# frame-0 geometry, frame pixels: housing top, lip, stem body seen inside the
# top housing (x0, y0, x1, y1, moving with the stem); top view: the stem's
# own outline as the base draws it (a box stem stays the base's box, a round
# stem stays round: ('box', x0, x1, y0, y1, corner) or ('round', radius), as
# fractions of the picture) and the rim width where the bottom housing shows
JADE_BOX = ('box', 0.235, 0.765, 0.32, 0.675, 0.03)
BASES = {
    'ttc-kom': {'top': 60, 'lip': 130, 'stem_zones': [(45, 60, 172, 128)],
                'top_stem': ('box', 0.23, 0.77, 0.26, 0.71, 0.02), 'rim': 0.08},
    'gateron-jade': {'top': 56, 'lip': 131, 'stem_zones': [(48, 56, 95, 135), (135, 56, 158, 135)],
                     'top_stem': JADE_BOX, 'rim': 0.08},
    'gateron-jade-gaming': {'top': 57, 'lip': 131, 'stem_zones': [(48, 57, 95, 135), (135, 57, 158, 135)],
                            'top_stem': JADE_BOX, 'rim': 0.08},
    'gateron-jade-ultra': {'top': 58, 'lip': 130, 'stem_zones': [(55, 58, 162, 70)],
                           'top_stem': ('round', 0.24), 'rim': 0.08},
}

WHITE = '#ffffff'
BUBBLEGUM = '#ff9ccf'
PALE_YELLOW = '#fff1a8'

# id: base, then each part as (finish, colour or None)
RECIPES = {
    # Jade
    'skyline': ('gateron-jade', ('colour', '#a9d3fc'), ('clear', None), ('opaque', WHITE)),
    'siren': ('gateron-jade', ('colour', '#fa98e0'), ('clear', None), ('opaque', WHITE)),
    'chixiao': ('gateron-jade', ('colour', '#ffd21f'), ('clear', None), ('opaque', '#d8222b')),
    # "both housings transparent": the bottom is see-through on the base, so clear it
    'ur-ice-magnetic': ('gateron-jade', ('colour', WHITE), ('clear', None), ('clear', None)),
    # Jade Gaming
    'purple-star': ('gateron-jade-gaming', ('colour', '#a77bff'), ('opaque', WHITE), ('opaque', WHITE)),
    'azure-sky-pro': ('gateron-jade-gaming', ('colour', '#29e5f2'), ('clear', None), ('opaque', WHITE)),
    # Jade Ultra
    'yaoguang': ('gateron-jade-ultra', ('colour', '#a9d3fc'), ('clear', None), ('opaque', WHITE)),
    'xueyao-snow': ('gateron-jade-ultra', ('colour', WHITE), ('clear', None), ('opaque', WHITE)),
    'bingyao': ('gateron-jade-ultra', ('colour', WHITE), ('clear', '#4679fa'), ('opaque', WHITE)),
    'sakura-clarity': ('gateron-jade-ultra', ('colour', BUBBLEGUM), ('clear', None), ('opaque', BUBBLEGUM)),
    'dark-jade': ('gateron-jade-ultra', ('colour', '#1b1c1f'), ('opaque', '#1b1c1f'), ('opaque', '#1b1c1f')),
    'hunyuan': ('gateron-jade-ultra', ('colour', '#f2f3f5'), ('cloudy', None), ('cloudy', None)),
    'zhuohua': ('gateron-jade-ultra', ('colour', BUBBLEGUM), ('opaque', BUBBLEGUM), ('opaque', BUBBLEGUM)),
    'ultra-rgb': ('gateron-jade-ultra', ('colour', BUBBLEGUM), ('clear', None), ('opaque', PALE_YELLOW)),
    'ultra-magnetic-pro': ('gateron-jade-ultra', ('colour', BUBBLEGUM), ('cloudy', None), ('opaque', PALE_YELLOW)),
    # TTC KOM
    'wukong': ('ttc-kom', ('colour', WHITE), ('clear', None), ('clear', None)),
    'pink-emperor': ('ttc-kom', ('colour', '#ffe58a'), ('clear', '#ffd6ec'), ('opaque', WHITE)),
}

LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def hex_rgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def colorize(lum, colour):
    """Dark keeps the colour deep, light pales it toward white."""
    c = hex_rgb(colour)
    l = np.clip(lum, 0, 1)[..., None]
    return np.where(l < 0.5, c * (l * 2), c + (1 - c) * ((l - 0.5) * 2))


def blur(x, r):
    img = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255


def saturation(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    return np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)


def treat(rgb, mask, finish, colour, stem=False):
    """One part's finish over `mask` (0..1 per pixel)."""
    lum = rgb @ LUMA
    sat = saturation(rgb)
    grey = np.repeat(lum[..., None], 3, -1)
    if finish == 'colour':
        # pixels that carried the base's colour take the new one; for a stem
        # (opaque on every base) all of it does
        weight = np.ones_like(lum) if stem else np.clip(sat / 0.12, 0, 1)
        # shading centred on the part's own average, so the colour comes out
        # as given rather than paled by a light base part
        m = float((lum * mask).sum() / max(mask.sum(), 1))
        c = hex_rgb(colour)
        if float(c @ LUMA) < 0.3:
            # a dark colour: lightening toward white would turn it grey
            new = np.clip(c + 0.35 * (lum - m)[..., None], 0, 1)
        else:
            new = colorize(np.clip(0.5 + 0.65 * (lum - m), 0, 1), colour)
    elif finish == 'walls':
        # an opaque bottom as Wootility draws one: a cutaway, the housing's
        # own pixels (outer and inner walls, shaded) in the colour, the
        # metal spring and anything neutral left as it is
        weight = np.clip((sat - 0.02) / 0.08, 0, 1)
        m = float((lum * mask * weight).sum() / max((mask * weight).sum(), 1))
        c = hex_rgb(colour)
        if float(c @ LUMA) < 0.3:
            new = np.clip(c + 0.45 * (lum - m)[..., None], 0, 1)
        else:
            new = colorize(np.clip(0.5 + 0.9 * (lum - m), 0, 1), colour)
    elif finish == 'clear':
        weight = np.ones_like(lum)
        clear = 0.3 + 0.7 * grey
        new = clear if colour is None else 0.7 * clear + 0.3 * colorize(0.25 + 0.75 * lum, colour)
    elif finish == 'cloudy':
        weight = np.ones_like(lum)
        milky = colorize(0.78 + 0.2 * blur(lum, 2.5), colour or '#f4f5f7')
        new = 0.4 * (0.3 + 0.7 * grey) + 0.6 * milky
    elif finish == 'opaque':
        weight = np.ones_like(lum)
        # shaded like the part was: the colour times its own light and dark
        # around the part's average, from a blurred copy so the inside does
        # not show through
        shade = blur(lum, 9)
        m = float((shade * mask).sum() / max(mask.sum(), 1))
        k = np.clip(0.9 + 0.7 * (shade - m), 0.55, 1.05)[..., None]
        new = np.clip(hex_rgb(colour) * k + (k > 1) * (k - 1) * 0.5, 0, 1)
    else:
        raise ValueError(finish)
    w = (mask * weight)[..., None]
    return rgb * (1 - w) + new * w


def masks(shape, base, d):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    # the stem above the housing: whatever of it is still above the housing top
    above = (yy < base['top']).astype(np.float32)
    inside = np.zeros((h, w), np.float32)
    for x0, y0, x1, y1 in base['stem_zones']:
        inside = np.maximum(inside, ((xx >= x0) & (xx < x1) & (yy >= y0 + d) & (yy < y1 + d)).astype(np.float32))
    inside *= (yy >= base['top']).astype(np.float32) * (yy < base['lip']).astype(np.float32)
    top = ((yy >= base['top']) & (yy < base['lip'])).astype(np.float32) * (1 - inside) * (1 - above)
    bottom = (yy >= base['lip']).astype(np.float32)
    soft = lambda m: blur(m, 0.8)
    return soft(above), soft(inside), soft(top), soft(bottom)


def recolor_frame(frame, base, d, recipe):
    rgb, a = frame[..., :3], frame[..., 3]
    _, stem, top, bottom = recipe
    above, inside, top_m, bottom_m = masks(a.shape, base, d)
    out = treat(rgb, above, *stem, stem=True)
    if top[0] == 'opaque':
        # nothing shows through an opaque top: the stem inside is housing
        top_m = np.maximum(top_m, inside)
    else:
        out = treat(out, inside, *stem, stem=True)
    out = treat(out, top_m, *top)
    out = treat(out, bottom_m, *bottom_finish(bottom))
    alpha = a
    if top[0] == 'opaque':
        # an opaque top is drawn solid (as Wootility's KOM POM)
        alpha = np.where(a > 0.35, a * (1 - top_m) + top_m, a)
    return np.dstack([np.clip(out, 0, 1), alpha])


def bottom_finish(part):
    """The renders are cutaways: an opaque bottom is coloured walls, inside shown."""
    return ('walls', part[1]) if part[0] == 'opaque' else part


def recolor_top(img, base, recipe):
    a = np.asarray(img.convert('RGBA')).astype(np.float32) / 255
    rgb, al = a[..., :3], a[..., 3]
    h, w = al.shape
    yy, xx = np.mgrid[0:h, 0:w]
    shape = base['top_stem']
    if shape[0] == 'round':
        inside = np.hypot(xx - w / 2, yy - h / 2) / w < shape[1]
    else:
        _, x0, x1, y0, y1, rad = shape
        # rounded rectangle: distance outside the rectangle shrunk by the corner
        dx = np.maximum(np.maximum(x0 + rad - xx / w, xx / w - (x1 - rad)), 0)
        dy = np.maximum(np.maximum(y0 + rad - yy / h, yy / h - (y1 - rad)), 0)
        inside = np.hypot(dx, dy) < rad
    edge = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]) / w
    stem_m = blur(inside.astype(np.float32), 1)
    bottom_m = blur((edge < base['rim']).astype(np.float32), 1) * (1 - stem_m)
    top_m = (1 - stem_m) * (1 - bottom_m)
    _, stem, top, bottom = recipe
    out = treat(rgb, stem_m, *stem, stem=True)
    out = treat(out, top_m, *top)
    out = treat(out, bottom_m, *bottom_finish(bottom))
    return Image.fromarray((np.dstack([np.clip(out, 0, 1), al]) * 255).astype(np.uint8), 'RGBA')


def main(ids):
    OUT.mkdir(exist_ok=True)
    for rid in ids:
        recipe = RECIPES[rid]
        base = BASES[recipe[0]]
        strip = np.asarray(Image.open(SRC / f'{recipe[0]}-side.webp').convert('RGBA')).astype(np.float32) / 255
        fw = strip.shape[1] // FRAMES
        frames = [strip[:, i * fw:(i + 1) * fw] for i in range(FRAMES)]
        tops = [int(np.where(f[..., 3].max(1) > 0.3)[0].min()) for f in frames]
        done = [recolor_frame(f, base, t - tops[0], recipe) for f, t in zip(frames, tops)]
        out = (np.concatenate(done, 1) * 255).astype(np.uint8)
        Image.fromarray(out, 'RGBA').save(OUT / f'{rid}-side.webp', 'WEBP', quality=90, method=6)
        Image.fromarray((done[0] * 255).astype(np.uint8), 'RGBA').save(OUT / f'{rid}-front.webp', 'WEBP', quality=92,
                                                                         method=6)
        recolor_top(Image.open(SRC / f'{recipe[0]}-top.webp'), base, recipe).save(OUT / f'{rid}-top.webp', 'WEBP',
                                                                                   quality=92, method=6)
        print(rid)


if __name__ == '__main__':
    main(sys.argv[1:] or list(RECIPES))
