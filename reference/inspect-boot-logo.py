"""Enlarged consecutive-frame sheets for the drawn contour and moving cut."""
from pathlib import Path
from PIL import Image,ImageDraw
out=Path(__file__).resolve().parent/'boot-frames'
for first,last,crop in [(229,249,(795,450,1125,650)),(249,269,(795,450,1125,650)),(440,460,(505,450,825,650)),(460,480,(505,450,825,650)),(480,487,(505,450,825,650))]:
 w,h=640,390;cols=4
 sheet=Image.new('RGB',(cols*w,((last-first+cols-1)//cols)*(h+24)),'#242424');d=ImageDraw.Draw(sheet)
 for i,f in enumerate(range(first,last)):
  x=i%cols*w;y=i//cols*(h+24)
  sheet.paste(Image.open(out/f'{f:04}.jpg').crop(crop).resize((w,h)),(x,y+24))
  d.text((x+8,y+5),f'{f} / {f/25:.2f}s',fill='white')
 sheet.save(out/f'logo-detail-{first}.jpg',quality=96)
