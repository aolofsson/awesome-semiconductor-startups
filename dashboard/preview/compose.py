"""Arrange the panels captured by capture.mjs into one image.

Usage: python3 compose.py <capture dir> <output png>
Needs Pillow. Every panel is scaled by the same factor, so text stays the
same size across the collage.
"""
import sys
from PIL import Image
BG = (238, 241, 244); PAD, GAP, W = 64, 48, 3000
names = ["wafer","tech","map","founded","exityear","exitvalue","acquirers","age"]
im = {k: Image.open(f"{sys.argv[1]}/{k}.png").convert("RGB") for k in names}
inner = W - 2 * PAD
# One scale for every capture, so text is the same size across the collage.
s = (inner - 2 * GAP) / (im["wafer"].width + im["tech"].width + im["map"].width)
row2 = ["exityear", "exitvalue", "acquirers", "age"]
s = min(s, (inner - 3 * GAP) / sum(im[k].width for k in row2))
r = {k: v.resize((round(v.width * s), round(v.height * s)), Image.LANCZOS) for k, v in im.items()}
H1 = max(r["wafer"].height, r["tech"].height, r["map"].height + GAP + r["founded"].height)
H2 = max(r[k].height for k in row2)
canvas = Image.new("RGB", (W, PAD * 2 + H1 + GAP + H2), BG)
x = PAD
for k in ("wafer", "tech"):
    canvas.paste(r[k], (x, PAD)); x += r[k].width + GAP
canvas.paste(r["map"], (x, PAD)); canvas.paste(r["founded"], (x, PAD + r["map"].height + GAP))
used = sum(r[k].width for k in row2) + 3 * GAP
x = PAD + (inner - used) // 2
for k in row2:
    canvas.paste(r[k], (x, PAD + H1 + GAP)); x += r[k].width + GAP
out = canvas.resize((1600, round(canvas.height * 1600 / W)), Image.LANCZOS)
out.save(sys.argv[2], optimize=True)
print(round(s, 3), out.size)
