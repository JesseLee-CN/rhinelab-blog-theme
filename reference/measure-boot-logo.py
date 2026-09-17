"""Sample the continuous infinity contour against the reference's black ink."""
import sys,json
from pathlib import Path
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root.parent/'.tools'))
import cv2
import numpy as np
from PIL import Image,ImageDraw
out=root/'boot-frames'
# Continuous version of the shared Bezier, with the printed logo's small gap filled.
curves=[[(295,73),(295,41),(273,15),(240,15)],[(240,15),(221,15),(207,23),(192,38)],[(192,38),(186,43),(181,47),(176,52)],[(176,52),(127,96),(103,128),(70,128)],[(70,128),(38,128),(15,101),(15,70)],[(15,70),(15,39),(37,15),(70,15)],[(70,15),(103,15),(127,48),(156,75)],[(156,75),(182,99),(208,128),(240,128)],[(240,128),(273,128),(295,105),(295,73)]]
p=[]
for c in curves:
 t=np.linspace(0,1,300)[:,None];a,b,d,e=np.array(c)
 p.extend((1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*d+t**3*e)
p=np.array(p);dist=np.r_[0,np.cumsum(np.linalg.norm(np.diff(p,axis=0),axis=1))]
params=np.linspace(0,1,2000,endpoint=False)
points=np.c_[np.interp(params*dist[-1],dist,p[:,0]),np.interp(params*dist[-1],dist,p[:,1])]
results=[]
for f in range(229,487):
 im=cv2.imread(str(out/f'{f:04}.jpg'),0)
 # Fit the final-size contour to its source bounding box; translation is
 # measured from stable leftmost ink once the left loop has been drawn.
 crop=im[464:608,490:1130]
 yy,xx=np.where(crop<90)
 left=float(xx.min()+490) if len(xx) and f>=238 else 815
 x=(points[:,0]-2)*(.955)+left
 y=(points[:,1]-2)*(.955)+465
 gray=cv2.remap(im,x.astype(np.float32)[None,:],y.astype(np.float32)[None,:],cv2.INTER_LINEAR)[0]
 mask=(gray<130).astype(np.uint8)
 # Remove tiny raster interruptions; do not fill a real moving cut.
 mask=cv2.morphologyEx(np.tile(mask,3)[None,:],cv2.MORPH_CLOSE,np.ones((1,8),np.uint8))[0,2000:4000]
 changes=np.diff(np.r_[0,mask,0].astype(int))
 runs=[(int(a),int(b)) for a,b in zip(np.where(changes==1)[0],np.where(changes==-1)[0]) if b-a>4]
 results.append({'frame':f,'left':left,'runs':runs,'coverage':round(float(mask.mean()),4)})
 if 247<=f<=268:
  mark=im[475:593,int(left):int(left)+294]
  n,labels,stats,centers=cv2.connectedComponentsWithStats((mark<110).astype(np.uint8))
  symbols=[]
  for s,(cx,cy) in zip(stats[1:],centers[1:]):
   if s[4]<4 or s[4]>2500 or not 30<cy<95:continue
   symbols.append([round(float(cx/.955+2),2),round(float((cy+10)/.955+2),2),int(s[2]),int(s[3]),int(s[4])])
  results[-1]['symbols']=symbols
 if f in [238,260,350,460]:print(f,'bbox',(int(xx.min()+490),int(yy.min()+464),int(xx.max()+490),int(yy.max()+464)))
(out/'logo-measurements.json').write_text(json.dumps(results,indent=2))
for a,b in [(229,265),(300,487)]:
 rows=[r for r in results if a<=r['frame']<b]
 img=Image.new('RGB',(1100,len(rows)*12),'#eeeeeb');draw=ImageDraw.Draw(img)
 for i,row in enumerate(rows):
  draw.text((0,i*12),str(row['frame']),fill='black')
  for start,end in row['runs']:draw.rectangle((70+start/2,i*12,70+end/2,i*12+10),fill='black')
 img.save(out/f'logo-ink-{a}.jpg')
print('Contour length',dist[-1])
