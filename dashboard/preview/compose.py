"""Arrange the panels captured by capture.mjs into one image.

Usage: python3 compose.py <capture dir> <output png>
Needs Pillow. Every panel is scaled by the same factor, so text stays the
same size across the collage.

Layout:
  row 1: wafer | technology | map over founded-per-year
  row 2: the four exit charts in a 2x2 grid | ecosystem map
"""
import sys
from PIL import Image
BG = (238, 241, 244); PAD, GAP, W = 64, 48, 3000
names = ["wafer", "tech", "map", "founded", "exityear", "exitvalue", "acquirers", "age", "network"]
im = {k: Image.open(f"{sys.argv[1]}/{k}.png").convert("RGB") for k in names}
inner = W - 2 * PAD
grid = [["exityear", "exitvalue"], ["acquirers", "age"]]
gw = lambda row: sum(im[k].width for k in row)
# One scale for every capture, chosen so both rows fit the inner width.
s = min((inner - 2 * GAP) / (im["wafer"].width + im["tech"].width + im["map"].width),
        (inner - 2 * GAP) / (im["network"].width + max(gw(r) for r in grid)))
r = {k: v.resize((round(v.width * s), round(v.height * s)), Image.LANCZOS) for k, v in im.items()}
H1 = max(r["wafer"].height, r["tech"].height, r["map"].height + GAP + r["founded"].height)
row_h = [max(r[k].height for k in row) for row in grid]
grid_h = sum(row_h) + GAP
H2 = max(r["network"].height, grid_h)
canvas = Image.new("RGB", (W, PAD * 2 + H1 + GAP + H2), BG)
x = PAD
for k in ("wafer", "tech"):
    canvas.paste(r[k], (x, PAD)); x += r[k].width + GAP
canvas.paste(r["map"], (x, PAD)); canvas.paste(r["founded"], (x, PAD + r["map"].height + GAP))
y2 = PAD + H1 + GAP
# The network goes flush with the right margin; the exit grid takes the left.
canvas.paste(r["network"], (W - PAD - r["network"].width, y2))
gx = PAD
# Centre the exit grid vertically beside the taller network panel.
y = y2 + (H2 - grid_h) // 2
for row, h in zip(grid, row_h):
    x = gx
    for k in row:
        canvas.paste(r[k], (x, y)); x += r[k].width + GAP
    y += h + GAP
out = canvas.resize((1600, round(canvas.height * 1600 / W)), Image.LANCZOS)
out.save(sys.argv[2], optimize=True)
print(round(s, 3), out.size)
