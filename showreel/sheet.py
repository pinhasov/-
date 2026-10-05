# Contact sheet of stills with safe-area overlay.
import sys, glob
from PIL import Image, ImageDraw
files = sorted(glob.glob(sys.argv[1] + '/g*.png')); cols = 8; sc = 0.25
w, h = int(1080*sc), int(1920*sc)
rows = (len(files)+cols-1)//cols
sheet = Image.new('RGB', (cols*w, rows*(h+20)), 'white')
for i, f in enumerate(files):
    im = Image.open(f).convert('RGB').resize((w, h))
    d = ImageDraw.Draw(im)
    s = lambda v: int(v*sc)
    d.line([(s(80),s(250)),(s(1000),s(250)),(s(1000),s(960)),(s(940),s(960)),(s(940),s(1570)),(s(80),s(1570)),(s(80),s(250))], fill=(0,255,255), width=1)
    x, y = (i%cols)*w, (i//cols)*(h+20)
    sheet.paste(im, (x, y+20)); ImageDraw.Draw(sheet).text((x+4, y+4), f.split('/')[-1], fill='black')
sheet.save(sys.argv[2])
