"""Create and decode the actual deployed app URL; no QR network service."""
import sys
from pathlib import Path
import qrcode
from PIL import Image,ImageDraw,ImageFont
import zxingcpp
url=sys.argv[1]
assert url.startswith('https://evgk724.github.io/')
root=Path(__file__).resolve().parent.parent
qr=qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,box_size=12,border=4)
qr.add_data(url);qr.make(fit=True)
im=qr.make_image(fill_color='#17191d',back_color='white').convert('RGB')
out=root/'evidence/potter-english-qr.png';im.save(out)
decoded=zxingcpp.read_barcode(Image.open(out))
assert decoded and decoded.text==url
print('Verified QR:',decoded.text, str(out))
