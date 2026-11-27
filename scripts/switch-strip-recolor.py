#!/usr/bin/env python3
"""Recolour Wootility's pre-rendered switch presses (41-frame strips).

    python3 scripts/switch-strip-recolor.py            # every recipe
    python3 scripts/switch-strip-recolor.py siren      # some recipes

Each base switch (src/assets/switches/wooting/<base>-side.webp, frames side by
side) is split by geometry, not colour (the Jade family is one hue
throughout): above the housing is stem; between the housing's top and the lip
is the top housing; below the lip is the bottom housing. The stem is one
rigid piece drawn wherever it has got to (see BASES).

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

# frame-0 geometry, frame pixels. `top` and `lip` are the top housing's top
# and bottom edges. The stem is one rigid piece that slides down by the same
# amount everywhere (measured from where its top sits): `stem` is its outline
# at rest as rectangles (x0, y0, x1, y1), drawn whole in every frame wherever
# it has got to. `pole` (a rectangle too) is the stem's middle post, behind
# the spring; `spring` (x0, x1, y0, floor) is the spring in front of it: its
# top rides on the stem, its floor stays. Where the spring covers the pole the
# pole takes only a little of the colour and the spring none. A base whose stem has
# its own colours (the KOM's red and blue) is found by colour instead
# (`stem_hues`, degrees, inside `stem_x`). Top view: the stem's outline as the
# base draws it (a box stem stays the base's box, a round stem stays round:
# ('box', x0, x1, y0, y1, corner) or ('round', radius), as fractions of the
# picture) and the rim width where the bottom housing shows.
JADE_BOX = ('box', 0.235, 0.765, 0.32, 0.675, 0.03)
JADE_STEM = [(81, 0, 137, 52), (55, 50, 163, 62), (47, 62, 80, 134), (140, 55, 167, 132)]
BASES = {
    'ttc-kom': {'top': 60, 'lip': 130, 'stem_hues': [(330, 380), (200, 250)], 'stem_x': (48, 172),
                'top_stem': ('box', 0.23, 0.77, 0.26, 0.71, 0.02), 'rim': 0.08},
    'gateron-jade': {'top': 56, 'lip': 131, 'stem': JADE_STEM, 'pole': (80, 62, 140, 155), 'spring': (66, 150, 62, 182),
                     'top_stem': JADE_BOX, 'rim': 0.08},
    'gateron-jade-gaming': {'top': 57, 'lip': 131,
                            'stem': [(51, 0, 165, 53), (51, 50, 165, 62)] + JADE_STEM[2:],
                            'pole': (80, 62, 140, 155), 'spring': (66, 150, 62, 182), 'top_stem': JADE_BOX, 'rim': 0.08},
    'gateron-jade-ultra': {'top': 58, 'lip': 130,
                           'stem': [(58, 0, 158, 66), (41, 66, 82, 131), (134, 66, 175, 131)],
                           'pole': (82, 66, 134, 155), 'spring': (66, 150, 64, 185), 'top_stem': ('round', 0.24), 'rim': 0.08},
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


def hue(rgb):
    mx, mn = rgb.max(-1), rgb.min(-1)
    c = np.maximum(mx - mn, 1e-6)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.where(mx == r, ((g - b) / c) % 6, np.where(mx == g, (b - r) / c + 2, (r - g) / c + 4))
    return h * 60


def stem_masks(rgb, a, base, d):
    """Where the stem shows in a frame whose stem has moved down `d`, and
    where its pole shows behind the spring."""
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    under = np.zeros((h, w), np.float32)
    if 'stem_hues' in base:
        hu, sat = hue(rgb), saturation(rgb)
        coloured = np.zeros((h, w), bool)
        for h0, h1 in base['stem_hues']:
            coloured |= ((hu >= h0) & (hu < h1)) | ((hu + 360 >= h0) & (hu + 360 < h1))
        x0, x1 = base['stem_x']
        stem = coloured * np.clip((sat - 0.1) / 0.12, 0, 1) * ((xx >= x0) & (xx < x1))
    else:
        outline = np.zeros((h, w), bool)
        for x0, y0, x1, y1 in base['stem']:
            outline |= (xx >= x0) & (xx < x1) & (yy >= y0 + d) & (yy < y1 + d)
        x0, y0, x1, y1 = base['pole']
        pole = (xx >= x0) & (xx < x1) & (yy >= y0 + d) & (yy < y1 + d)
        sx0, sx1, sy0, floor = base['spring']
        spring = (xx >= sx0) & (xx < sx1) & (yy >= sy0 + d) & (yy < floor)
        stem = (outline | (pole & ~spring)).astype(np.float32)
        under = (pole & spring & ~outline).astype(np.float32)
    shown = (a > 0.3).astype(np.float32)
    return blur(stem * shown, 0.6), blur(under * shown, 0.6)


def stem_colour(rgb, mask, colour, groups=None):
    """The stem in `colour`, shaded by its own light and dark. `groups` (masks)
    are parts of the base stem in different colours, each centred on its own
    average so the new stem comes out one colour."""
    lum = rgb @ LUMA
    rel = np.zeros_like(lum)
    for g in groups or [np.ones_like(lum)]:
        gm = mask * g
        m = float((lum * gm).sum() / max(gm.sum(), 1e-6))
        rel = np.where(g > 0.5, lum - m, rel)
    c = hex_rgb(colour)
    if float(c @ LUMA) < 0.3:
        new = np.clip(c + 0.35 * rel[..., None], 0, 1)
    else:
        new = colorize(np.clip(0.5 + 0.65 * rel, 0, 1), colour)
    m3 = mask[..., None]
    return rgb * (1 - m3) + new * m3


def spring_metal(rgb, base, d):
    """The spring's coils: striped (strong local contrast) inside the spring."""
    h, w = rgb.shape[:2]
    if 'spring' not in base:
        return np.zeros((h, w), np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    sx0, sx1, sy0, floor = base['spring']
    band = ((xx >= sx0 - 4) & (xx < sx1 + 4) & (yy >= sy0 + d) & (yy < floor + 4)).astype(np.float32)
    lum = rgb @ LUMA
    mean = blur(lum, 1.5)
    spread = np.sqrt(np.clip(blur(lum * lum, 1.5) - mean * mean, 0, None))
    return blur(blur(band, 1) * np.clip((spread - 0.02) / 0.06, 0, 1), 1.5)


# how much of a top housing's finish lies over the stem seen through it
THROUGH = {'clear': 0.4, 'cloudy': 0.5, 'opaque': 1.0}
GLASS = 0.2  # a plain clear top: the stem behind it a touch lighter, as rendered


def recolor_frame(frame, base, d, recipe):
    rgb, a = frame[..., :3], frame[..., 3]
    _, stem, top, bottom = recipe
    h, w = a.shape
    yy = np.mgrid[0:h, 0:w][0]
    stem_m, under = stem_masks(rgb, a, base, d)
    groups = None
    if 'stem_hues' in base:
        hu = hue(rgb)
        groups = [(((hu >= h0) & (hu < h1)) | ((hu + 360 >= h0) & (hu + 360 < h1))).astype(np.float32)
                  for h0, h1 in base['stem_hues']]
    metal = spring_metal(rgb, base, d)
    out = stem_colour(rgb, stem_m, stem[1], groups)
    out = stem_colour(out, under * 0.45 * (1 - metal), stem[1])
    top_band = blur(((yy >= base['top']) & (yy < base['lip'])).astype(np.float32), 0.8)
    bottom_band = blur((yy >= base['lip']).astype(np.float32), 0.8)
    top_m = top_band * (1 - stem_m)
    out = treat(out, top_m, *top)
    # the stem seen through the top housing
    k = GLASS if top == ('clear', None) else THROUGH[top[0]]
    out = treat(out, top_band * stem_m * k, *top)
    bottom_m = bottom_band * (1 - stem_m) * (1 - metal)
    out = treat(out, bottom_m, *bottom_finish(bottom))
    alpha = a
    if top[0] == 'opaque':
        # an opaque top is drawn solid (as Wootility's KOM POM)
        alpha = np.where(a > 0.35, a * (1 - top_band) + top_band, a)
    # the spring is plain metal, whatever is around it
    grey = (np.clip(out, 0, 1) @ LUMA)[..., None]
    keep = (metal * (1 - top_band * (top[0] == 'opaque')))[..., None]
    out = out * (1 - keep) + grey * keep
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
