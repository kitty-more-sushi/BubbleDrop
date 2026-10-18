"""Builds every app icon from assets/mascot.jpg (run from the BubbleDrop folder):
    python assets/make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "mascot.jpg")
FACE_BOX = (46, 26, 194, 174)  # her head + sunglasses + bubble
PINK, LILAC = (255, 111, 174), (178, 141, 255)


def gradient(size, a=PINK, b=LILAC):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g


def circle_mask(size, inset=0):
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse((inset * 4, inset * 4, (size - inset) * 4 - 1, (size - inset) * 4 - 1), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def face(size):
    return Image.open(SRC).convert("RGB").crop(FACE_BOX).resize((size, size), Image.LANCZOS)


def badge(size, full_bleed=False):
    """Round pink badge with the mascot's face; transparent outside the circle."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ring = max(2, size // 22)
    bg = gradient(size).convert("RGBA")
    out.paste(bg, (0, 0), circle_mask(size))
    inner = size - 2 * ring
    f = face(inner).convert("RGBA")
    out.paste(f, (ring, ring), circle_mask(inner))
    # glossy bubble highlight
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(hl)
    d.ellipse((size * 0.16, size * 0.10, size * 0.40, size * 0.26), fill=(255, 255, 255, 70))
    hl = hl.filter(ImageFilter.GaussianBlur(size / 60))
    out = Image.alpha_composite(out, hl)
    if full_bleed:
        sq = gradient(size).convert("RGBA")
        sq.alpha_composite(out)
        return sq
    return out


def save(img, *parts):
    p = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)
    print("wrote", os.path.relpath(p, ROOT))


def main():
    # shared web UI
    save(Image.open(SRC).convert("RGB"), "web", "mascot.jpg")
    save(badge(256), "web", "icon.png")
    # desktop
    big = badge(512)
    save(big, "desktop", "build", "icon.png")
    big.save(os.path.join(ROOT, "desktop", "build", "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote desktop/build/icon.ico")
    save(badge(32), "desktop", "build", "tray.png")
    # android legacy + round + adaptive foreground
    res = os.path.join("android", "app", "src", "main", "res")
    for name, dp in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
        s = int(48 * dp)
        save(badge(s), res, f"mipmap-{name}", "ic_launcher.png")
        save(badge(s), res, f"mipmap-{name}", "ic_launcher_round.png")
        fg_size = int(108 * dp)
        fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
        inner = int(70 * dp)
        off = (fg_size - inner) // 2
        f = face(inner).convert("RGBA")
        fg.paste(f, (off, off), circle_mask(inner))
        save(fg, res, f"mipmap-{name}", "ic_launcher_foreground.png")


if __name__ == "__main__":
    main()
