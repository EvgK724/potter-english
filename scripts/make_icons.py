from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
for size,name in [(512,'icon-512.png'),(192,'icon-192.png'),(180,'apple-touch-icon.png'),(512,'icon-maskable.png')]:
    im=Image.new('RGB',(size,size),'#1b1e24'); d=ImageDraw.Draw(im)
    s=size/512
    def rect(box,**kw): d.rounded_rectangle(tuple(int(x*s) for x in box),radius=int(kw.pop('radius',0)*s),**kw)
    rect((85,71,427,441),radius=50,fill='#242830',outline='#78604c',width=max(1,int(3*s)))
    rect((122,116,390,405),radius=13,fill='#3a302a',outline='#d49a63',width=max(1,int(3*s)))
    d.line((148*s,117*s,148*s,404*s),fill='#aa7d55',width=max(1,int(3*s)))
    font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Georgia.ttf',int(207*s))
    d.text((177*s,137*s),'P',font=font,fill='#ecc79c')
    cx,cy=332*s,184*s; r=23*s
    d.polygon([(cx,cy-r),(cx+r*.25,cy-r*.25),(cx+r,cy),(cx+r*.25,cy+r*.25),(cx,cy+r),(cx-r*.25,cy+r*.25),(cx-r,cy),(cx-r*.25,cy-r*.25)],fill='#9cbee7')
    d.line((182*s,365*s,335*s,365*s),fill='#d49a63',width=max(1,int(3*s)))
    im.save(ROOT/'icons'/name)
print('Created four app icons')
