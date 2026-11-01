"""Prepare original study texts only; private evidence never goes to TTS."""
import hashlib,json,re,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
files=sys.argv[2:]
normalize=lambda x: re.sub(r'\s+',' ',x.lower().replace('’',"'")).strip()
items={}
for filename in files:
 for c in json.loads((root/filename).read_text()):
  key='|'.join([normalize(c['phrase']),c['type'],normalize(c['meaning'])])
  id='hp-'+hashlib.sha256(key.encode()).hexdigest()[:12]
  if id in items:continue
  phrase_id=hashlib.sha256(c['phrase'].encode()).hexdigest()[:12]
  items[id]={k:c[k] for k in ['phrase','type','meaning','note','example','translation']}
  items[id].update(id=id,chapter=min(c['chapters']),chapters=c['chapters'],source='book',audioPhrase=f'audio/phrase-{phrase_id}.mp3',audioExample=f'audio/{id}-example.mp3')
output=root/sys.argv[1]
output.write_text('export const BOOK_CARDS = '+json.dumps(list(items.values()),ensure_ascii=False,indent=2)+';\n')
print(len(items),'cards queued')
