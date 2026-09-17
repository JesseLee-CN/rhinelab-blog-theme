"""Compare matching source/DOM crops after capturing the review page."""
from pathlib import Path
from PIL import Image,ImageDraw
out=Path(__file__).resolve().parent/'boot-frames'
for name,frames in [('logo',[237,248,258,460,474,479]),('orbits',[546,551,556,560,564,568])]:
 sheet=Image.new('RGB',(1520,len(frames)*464),'#242424');d=ImageDraw.Draw(sheet)
 for i,f in enumerate(frames):
  crop=(780,440,1140,660) if f<265 else (500,440,840,660) if f<500 else (770,430,1150,650)
  a=Image.open(out/f'{f:04}.jpg').crop(crop).resize((760,440))
  b=Image.open(out/f'detail-replica-{f}.jpg').resize((760,440))
  y=i*464;d.text((8,y+5),f'{f} / {f/25:.2f}s  reference / replica',fill='white')
  sheet.paste(a,(0,y+24));sheet.paste(b,(760,y+24))
  pair=Image.new('RGB',(1520,440));pair.paste(a,(0,0));pair.paste(b,(760,0));pair.save(out/f'pair-{f}.jpg',quality=96)
 sheet.save(out/f'{name}-comparison.jpg',quality=96)
