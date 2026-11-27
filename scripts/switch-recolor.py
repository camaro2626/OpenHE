#!/usr/bin/env python3
"""Switch pictures for OpenHE, recoloured from OpenAula's clear switch.

    python3 scripts/switch-recolor.py

The clear switch's stem is the only saturated part of the picture, so it is
picked out by colour; the housing splits into top and bottom at the lip the
press animation already uses (y = 800 in the 1536 px front view). Each part is
tinted from its own brightness, so the render's shading and highlights stay.
The outputs keep the clear switch's geometry, so its animation config fits.

Recipes: stem colour; top housing tint (None keeps it clear) and how strongly;
bottom housing colour and whether it is solid. The gains scale brightness
before tinting: below 1 for deep, saturated colours.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src/assets/switches'

RECIPES = {
    # Skyloong Crystal Blue: turquoise stem and bottom, clear top
    'crystal-blue': {'stem': '#4fcfb6', 'top': None, 'top_mix': 0.0, 'bottom': '#5fd3bd', 'bottom_solid': True},
    # TTC KOM (sold as "Magneto" on RongYuan boards): bright red stem, clear top, deep purple base
    'ttc-kom': {'stem': '#e0222c', 'stem_gain': 0.66, 'top': None, 'top_mix': 0.0, 'bottom': '#5a1f78', 'bottom_gain': 0.62, 'bottom_solid': True},
}

LIP = 800  # front view, px
SPRING = (640, 805, 885, 1035)  # front view, px


def load(name):
    im = np.asarray(Image.open(SRC / name).convert('RGBA')).astype(np.float32) / 255
    return im


def colorize(lum, hex_):
    """Dark keeps the colour deep, light pales it toward white."""
    c = np.array([int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    l = np.clip(lum, 0, 1)[..., None]
    return np.where(l < 0.5, c * (l * 2), c + (1 - c) * ((l - 0.5) * 2))


def blur(mask, r):
    img = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255


def parts(im):
    rgb, a = im[..., :3], im[..., 3]
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    stem = blur((sat > 0.28) & (a > 0.05), 1.2)
    return rgb, a, lum, stem


def recolor(im, recipe, bottom_weight, spring_weight=None):
    """`bottom_weight` per pixel: 0 top housing .. 1 bottom housing."""
    rgb, a, lum, stem = parts(im)
    # a clear top: drop the tint the original stem left in it
    top_rgb = 0.35 * rgb + 0.65 * lum[..., None] if recipe['top'] is None else (
        (1 - recipe['top_mix']) * rgb + recipe['top_mix'] * colorize(lum, recipe['top']))
    bot_rgb = colorize(lum * recipe.get('bottom_gain', 0.85 if recipe['bottom_solid'] else 1), recipe['bottom'])
    w = bottom_weight[..., None]
    house = (1 - w) * top_rgb + w * bot_rgb
    if spring_weight is not None:
        # the spring, seen through the bottom housing
        sw = (spring_weight * bottom_weight)[..., None]
        house = (1 - sw) * house + sw * (0.6 * rgb + 0.4 * colorize(lum, recipe['bottom']))
    out_rgb = stem[..., None] * colorize(lum * recipe.get('stem_gain', 1.05), recipe['stem']) + (1 - stem[..., None]) * house
    alpha = np.where(a > 0.12, (1 - bottom_weight) * np.clip(a * 1.15, 0, 1) + bottom_weight * a, a)
    if recipe['bottom_solid']:
        alpha = np.where((bottom_weight > 0.5) & (a > 0.12), 1.0, alpha)
    if recipe['top'] is None:
        alpha = np.where(bottom_weight < 0.5, a, alpha)
    out_a = np.where(stem > 0.5, a, alpha)
    return Image.fromarray((np.clip(np.dstack([out_rgb, out_a]), 0, 1) * 255).astype(np.uint8), 'RGBA')


def front(recipe):
    im = load('clear-front.png')
    h, w = im.shape[:2]
    yy = np.arange(h)[:, None].repeat(w, 1).astype(np.float32)
    bottom = np.clip((yy - (LIP - 12)) / 24, 0, 1)
    spring = Image.new('L', (w, h), 0)
    ImageDraw.Draw(spring).rectangle(SPRING, fill=255)
    spring = np.asarray(spring.filter(ImageFilter.GaussianBlur(14))).astype(np.float32) / 255
    return recolor(im, recipe, bottom, spring)


def top(recipe):
    """From above, the bottom housing shows around the outer edge."""
    im = load('clear-top.png')
    h, w = im.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    edge = np.maximum(np.abs(xx - w / 2), np.abs(yy - h / 2)) / (w / 2)
    bottom = np.clip((edge - 0.74) / 0.06, 0, 1) * 0.85
    return recolor(im, recipe, bottom)


def main():
    for name, recipe in RECIPES.items():
        for view, make in (('front', front), ('top', top)):
            out = SRC / f'{name}-{view}.webp'
            make(recipe).save(out, 'WEBP', quality=88, method=6)
            print(out.relative_to(ROOT), out.stat().st_size // 1024, 'KiB')


if __name__ == '__main__':
    main()
