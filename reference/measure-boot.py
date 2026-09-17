"""Measure the local 25 fps reference; generated images stay in the ignored folder."""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.tools'))
import cv2
import numpy as np
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
out = root / 'boot-frames'
angles = np.linspace(0, 2*np.pi, 1440, endpoint=False)
radii = np.arange(85, 2201, .5)
mx = (960 + radii[:, None]*np.cos(angles)).astype(np.float32)
my = (540 + radii[:, None]*np.sin(angles)).astype(np.float32)

def segments(mask):
    # Close sub-degree compression holes, then unwrap at a gap.
    mask = np.array(mask, dtype=np.uint8)
    mask = cv2.morphologyEx(np.tile(mask, 3)[None,:], cv2.MORPH_CLOSE, np.ones((1,7),np.uint8))[0,1440:2880]
    gaps = np.where(mask == 0)[0]
    if len(gaps) == 0: return [(0,360)]
    origin = gaps[0]
    rolled = np.roll(mask, -origin)
    edges = np.diff(np.r_[0,rolled,0].astype(int))
    return sorted([(((a+origin)%1440)/4,(b-a)/4) for a,b in zip(np.where(edges==1)[0],np.where(edges==-1)[0]) if b-a>12], key=lambda x:-x[1])

rows=[]
for f in range(487,569):
    im=cv2.imread(str(out/f'{f:04}.jpg'))
    polar=cv2.remap(im,mx,my,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=(128,128,128))
    black=polar.max(axis=2)<100
    white=polar.min(axis=2)>248
    row={'frame':f}
    # Outer arcs occupy much more of a concentric radius than text/background.
    for name,mask,lo,hi in [('outer',black,240,2200),('white',white,220,1500),('inner',black,85,140)]:
        valid=(radii>=lo)&(radii<=hi)
        counts=mask.sum(axis=1)*valid
        idx=int(np.argmax(counts))
        row[name]=[float(radii[idx]),segments(mask[max(0,idx-1):idx+2].any(axis=0))[:2]]
    orange=(im[:,:,2]>190)&(im[:,:,1]>65)&(im[:,:,1]<190)&(im[:,:,0]<100)
    n,labels,stats,centers=cv2.connectedComponentsWithStats(orange.astype(np.uint8))
    dots=[(float(x),float(y),int(s[4])) for s,(x,y) in zip(stats[1:],centers[1:]) if s[4]>8 and 500<x<1420 and 200<y<880]
    row['dots']=dots
    rows.append(row)
(out/'measurements.json').write_text(json.dumps(rows,indent=2))
brand=[]
for f in range(277,316):
    im=cv2.imread(str(out/f'{f:04}.jpg'),0)
    bands=[]
    for top,bottom in [(120,158),(163,181),(187,215)]:
        roi=im[top:bottom,40:700]
        yy,xx=np.where(roi<185)
        bands.append([int(xx.min()+40),int(np.percentile(roi[yy,xx],10))] if len(xx) else None)
    brand.append([f,*bands])
(out/'brand-measurements.json').write_text(json.dumps(brand,indent=2))
company=[]
for f in range(588,622):
    im=cv2.imread(str(out/f'{f:04}.jpg'),0)
    xs=np.where(im[472,748:1170]<170)[0]
    company.append([f,int(xs.max()+748) if len(xs) else None])
(out/'company-measurements.json').write_text(json.dumps(company,indent=2))
for name,frames,crop,size,cols in [('ring-detail',range(518,546),(655,235,1265,845),(366,366),7),('company-detail',range(588,609),(748,468,1168,530),(630,93),3),('brand-detail',range(277,307),(40,110,650,225),(610,115),3)]:
    frames=list(frames);w,h=size
    sheet=Image.new('RGB',(cols*w,((len(frames)+cols-1)//cols)*(h+25)),'#242424');draw=ImageDraw.Draw(sheet)
    for i,f in enumerate(frames):
        x=i%cols*w;y=i//cols*(h+25)
        sheet.paste(Image.open(out/f'{f:04}.jpg').crop(crop).resize(size),(x,y+25))
        draw.text((x+8,y+5),f'{f} / {f/25:.2f}s',fill='white')
    sheet.save(out/f'{name}.jpg',quality=96)
print(json.dumps(rows[::5],indent=2))
