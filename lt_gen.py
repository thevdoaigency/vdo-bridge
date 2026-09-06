#!/usr/bin/env python3
"""Render a lower-third card to a transparent PNG.

Text is measured, not estimated, so the accent badge always fits its name.
Design follows the AWC portfolio graphic builder: solid accent badge holding an
uppercase name, muted title strip beneath. Adds a soft drop shadow, which the
builder doesn't need on its light card but video does over bright footage.

Usage: lt_gen.py OUT.png --name "Giovanni Luciano" --title "Project Manager"
                          --accent f5c800 --name-text 000000 [--w 1920 --h 1080]
"""
import argparse
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

FONT_CANDIDATES_BOLD = [
    os.path.join(HERE, "fonts", "HelveticaNowDisplay-Bold.ttf"),
    "/usr/local/share/fonts/HelveticaNowDisplay-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_CANDIDATES_REG = [
    os.path.join(HERE, "fonts", "HelveticaNowDisplay-Regular.ttf"),
    "/usr/local/share/fonts/HelveticaNowDisplay-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def pick(paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    raise SystemExit("no usable font found")


def hex2rgb(h):
    # NB: lstrip("0x") would eat the leading zeros of "000000" too.
    h = h.strip().lstrip("#")
    if h.lower().startswith("0x"):
        h = h[2:]
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def draw_tracked(draw, xy, text, font, fill, track=0):
    """Draw text with letter-spacing; returns the advance width."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + track
    return x - xy[0] - (track if text else 0)


def measure_tracked(draw, text, font, track=0):
    w = sum(draw.textlength(c, font=font) for c in text)
    return w + track * max(0, len(text) - 1)


def render(args):
    W, H = args.w, args.h
    # Geometry authored against a 1920x1080 frame, then driven by whichever
    # dimension is the constraint — scaling off height alone blows the card up
    # to full width on a vertical delivery. --scale multiplies on top.
    scale = min(W / 1920.0, H / 1080.0) * args.scale

    name = args.name.upper()
    title = args.title

    name_size = int(round(34 * scale))
    title_size = int(round(20 * scale))
    pad_x = int(round(22 * scale))
    pad_y = int(round(14 * scale))
    t_pad_y = int(round(9 * scale))
    track = 2 * scale
    # Margins follow the frame, not the type, so the card keeps its inset.
    left = int(round(args.left_frac * W))
    base_y = int(round(args.base_frac * H))  # badge bottom, px up from bottom

    f_bold = ImageFont.truetype(pick(FONT_CANDIDATES_BOLD), name_size)
    f_reg = ImageFont.truetype(pick(FONT_CANDIDATES_REG), title_size)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    name_w = measure_tracked(d, name, f_bold, track)
    title_w = d.textlength(title, font=f_reg) if title else 0

    badge_w = int(round(name_w + pad_x * 2))
    badge_h = int(round(name_size * 1.05 + pad_y * 2))
    strip_w = int(round(title_w + pad_x * 2)) if title else 0
    strip_h = int(round(title_size * 1.15 + t_pad_y * 2)) if title else 0

    badge_top = H - base_y - badge_h
    strip_top = H - base_y

    # Shadow layer first, blurred, so the card reads over bright footage.
    if args.shadow:
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.rectangle([left, badge_top, left + badge_w, badge_top + badge_h],
                     fill=(0, 0, 0, 150))
        if title:
            sd.rectangle([left, strip_top, left + strip_w, strip_top + strip_h],
                         fill=(0, 0, 0, 130))
        sh = sh.filter(ImageFilter.GaussianBlur(int(round(14 * scale))))
        img = Image.alpha_composite(img, sh)
        d = ImageDraw.Draw(img)

    accent = hex2rgb(args.accent)
    d.rectangle([left, badge_top, left + badge_w, badge_top + badge_h],
                fill=accent + (255,))

    if title:
        d.rectangle([left, strip_top, left + strip_w, strip_top + strip_h],
                    fill=hex2rgb(args.strip) + (int(args.strip_alpha * 255),))

    # Vertically centre each string inside its plate using real glyph metrics.
    na, nd = f_bold.getmetrics()
    ty = badge_top + (badge_h - (na + nd)) / 2
    draw_tracked(d, (left + pad_x, ty), name, f_bold, hex2rgb(args.name_text) + (255,), track)

    if title:
        ra, rd = f_reg.getmetrics()
        tty = strip_top + (strip_h - (ra + rd)) / 2
        d.text((left + pad_x, tty), title, font=f_reg,
               fill=hex2rgb(args.title_text) + (255,))

    # Crop to actual content (shadow included) and report where it goes. A
    # tight card keeps the wipe mask small, which is most of the render cost.
    box = img.getbbox()
    if box:
        img = img.crop(box)
        ox, oy = box[0], box[1]
        # ffmpeg's colour sources round to even dimensions for chroma
        # subsampling, so an odd-sized card desyncs from its wipe mask by a
        # pixel and blend refuses to run. Pad rather than crop, to keep content.
        cw, chh = img.size
        if cw % 2 or chh % 2:
            padded = Image.new("RGBA", (cw + cw % 2, chh + chh % 2), (0, 0, 0, 0))
            padded.paste(img, (0, 0))
            img = padded
    else:
        ox = oy = 0
    img.save(args.out)
    print(f"{ox} {oy} {img.size[0]} {img.size[1]}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--name", required=True)
    p.add_argument("--title", default="")
    p.add_argument("--accent", default="f5c800")
    p.add_argument("--name-text", default="000000")
    p.add_argument("--title-text", default="f2f2f2")
    p.add_argument("--strip", default="111111")
    p.add_argument("--strip-alpha", type=float, default=0.82)
    p.add_argument("--w", type=int, default=1920)
    p.add_argument("--h", type=int, default=1080)
    p.add_argument("--scale", type=float, default=2.0)
    p.add_argument("--left-frac", type=float, default=0.031)
    p.add_argument("--base-frac", type=float, default=0.139)
    p.add_argument("--shadow", action="store_true", default=True)
    p.add_argument("--no-shadow", dest="shadow", action="store_false")
    render(p.parse_args())
