# make_icons.py
from PIL import Image
from pathlib import Path
import sys

SIZES = [16, 48, 128]  # edit if you want more

def make_square(img: Image.Image, size: int, mode="contain"):
    """
    mode='contain' keeps the whole image and pads to square.
    mode='cover' fills the square and may crop edges.
    """
    if mode not in ("contain", "cover"):
        mode = "contain"

    if mode == "contain":
        # scale to fit within the square, keep aspect, pad with transparent
        img = img.convert("RGBA")
        img.thumbnail((size, size), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        x = (size - img.width) // 2
        y = (size - img.height) // 2
        canvas.paste(img, (x, y))
        return canvas

    # cover
    img = img.convert("RGBA")
    w, h = img.size
    scale = max(size / w, size / h)
    nw, nh = int(w * scale), int(h * scale)
    img = img.resize((nw, nh), Image.LANCZOS)
    # center-crop
    left = (nw - size) // 2
    top = (nh - size) // 2
    return img.crop((left, top, left + size, top + size))

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 make_icons.py <source-image> [outdir] [contain|cover]")
        sys.exit(1)

    src = Path(sys.argv[1])
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("icons")
    mode = sys.argv[3] if len(sys.argv) > 3 else "contain"

    outdir.mkdir(parents=True, exist_ok=True)
    base = src.stem

    img = Image.open(src)
    for s in SIZES:
        out = outdir / f"{base}{s}.png"
        square = make_square(img, s, mode=mode)
        square.save(out, format="PNG", optimize=True)
        print(f"Wrote {out}")

if __name__ == "__main__":
    main()
