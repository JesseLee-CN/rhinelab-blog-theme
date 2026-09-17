"""Inspect every source frame around the authorization-to-orbit transition."""
import sys,json
from pathlib import Path
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root.parent/'.tools'))
import cv2
import numpy as np
from PIL import Image,ImageDraw
out=root/'boot-frames'
rows=[]
for f in range(540,569):
 im=cv2.imread(str(out/f'{f:04}.jpg'),0)
 row={'frame':f,'sides':[]}
 for side,(cx,cy) in enumerate([(830,552),(1090,528)]):
  # The source circles' centers move towards the horizontal axis. A fixed
  # annulus clips the lower/upper stroke late in the animation.
  cy=round(np.interp(f,[544,548,551,555,560,568],[558,557,552,546,542,540]) if side==0 else np.interp(f,[544,548,551,555,560,568],[520,523,527,533,537,539]))
  y,x=np.mgrid[cy-48:cy+49,cx-48:cx+49]
  radius=np.hypot(x-cx,y-cy)
  mask=(im[cy-48:cy+49,cx-48:cx+49]<130)&(radius>33)&(radius<44)
  if f<547:
   # Permission lettering occupies these rows and is not part of the arc.
   mask&=(y<526)|(y>554)
  xx,yy=x[mask],y[mask]
  if len(xx)<8:row['sides'].append(None);continue
  a,b,c=np.linalg.lstsq(np.c_[2*xx,2*yy,np.ones(len(xx))],xx*xx+yy*yy,rcond=None)[0]
  r=np.sqrt(c+a*a+b*b)
  angles=np.sort(np.mod(np.degrees(np.arctan2(yy-b,xx-a)),360))
  gaps=np.diff(np.r_[angles,angles[0]+360]);i=int(np.argmax(gaps))
  start=angles[(i+1)%len(angles)];sweep=360-gaps[i]
  row['sides'].append([round(float(v),2) for v in [a,b,r,start,sweep]])
 roi=im[478:603,898:1023]
 n,labels,stats,centers=cv2.connectedComponentsWithStats((roi<120).astype(np.uint8))
 row['dots']=[[round(float(x+898),2),round(float(y+478),2),int(s[4]),round(float(np.sqrt(s[4]/np.pi)),2)] for s,(x,y) in zip(stats[1:],centers[1:]) if s[4]>=3 and s[2]<90 and s[3]<90]
 rows.append(row)
(out/'scan-detail-measurements.json').write_text(json.dumps(rows,indent=2))
for start,end in [(540,554),(554,569)]:
 w,h=760,440;cols=3
 sheet=Image.new('RGB',(w*cols,((end-start+cols-1)//cols)*(h+24)),'#242424');d=ImageDraw.Draw(sheet)
 for i,f in enumerate(range(start,end)):
  x=i%cols*w;y=i//cols*(h+24)
  sheet.paste(Image.open(out/f'{f:04}.jpg').crop((770,430,1150,650)).resize((w,h)),(x,y+24))
  d.text((x+8,y+5),f'{f} / {f/25:.2f}s',fill='white')
 sheet.save(out/f'scan-center-{start}.jpg',quality=96)
print(json.dumps(rows,indent=2))
