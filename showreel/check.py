import sys, json, numpy as np
from PIL import Image
d = sys.argv[1]; meta = json.load(open(d + '/meta.json'))
TH = 40; GAP = 3
def dil(m, r):
    o = m.copy()
    for dy in range(-r, r+1):
        for dx in range(-r, r+1):
            o |= np.roll(np.roll(m, dy, 0), dx, 1)
    return o
yy, xx = np.mgrid[0:1920, 0:1080]
outside = (yy < 250) | (yy >= 1570) | (xx < 80) | (xx >= 1000) | ((yy >= 960) & (xx >= 940))
bad_safe, bad_touch, slide_out = [], [], []
minmargin = 1e9
for m in meta:
    a = np.asarray(Image.open(f"{d}/f{m['i']:04d}.png").convert('RGB')).astype(int)
    ch = [a[..., k] > TH for k in range(3)]
    anyink = ch[0] | ch[1] | ch[2]
    n_out = int((anyink & outside).sum())
    if n_out:
        (slide_out if m['slideIn'] else bad_safe).append((m['i'], round(m['t'], 3), n_out))
    if anyink.any():
        ys, xs = np.nonzero(anyink)
        right_limit = np.where(ys >= 960, 940, 1000)
        mg = min(xs.min() - 80, (right_limit - 1 - xs).min(), ys.min() - 250, 1569 - ys.max())
        if not m['slideIn']: minmargin = min(minmargin, mg)
    # touching: any two channels within GAP px of each other
    present = [k for k in range(3) if ch[k].any()]
    for p in range(len(present)):
        for q in range(p+1, len(present)):
            A, B = ch[present[p]], ch[present[q]]
            if (dil(A, GAP) & B).any(): bad_touch.append((m['i'], round(m['t'], 3), present[p], present[q]))
print('frames', len(meta))
print('safe-area violations:', len(bad_safe), bad_safe[:12])
print('slide-in frames starting outside (allowed):', len(slide_out), slide_out[:3], slide_out[-2:])
print('touching neighbours:', len(bad_touch), bad_touch[:12])
print('min margin to safe edge (px):', minmargin)
