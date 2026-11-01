"""Verify curated private evidence without putting source passages in the build."""
import json,re,sys,hashlib
from pathlib import Path
from collections import Counter,defaultdict
root=Path(__file__).resolve().parent.parent
norm=lambda s:re.sub(r'\s+',' ',s.lower().replace('’',"'")).strip()
chapters={n:norm((root/'private'/f'chapter-{n:02d}.txt').read_text()) for n in range(1,18)}
items=[];errors=[];warnings=[]
for file in sys.argv[1:]:
 cards=json.loads((root/file).read_text())
 for i,c in enumerate(cards):
  ident=f'{file}:{i}:{c.get("phrase")}'
  for field in ['phrase','type','meaning','note','example','translation','chapters','evidence']:
   if not c.get(field):errors.append(f'{ident} missing {field}')
  if c['type'] not in ['phrasal','idiom','collocation']:errors.append(f'{ident} type')
  if set(c['chapters']) != {ev['chapter'] for ev in c['evidence']}:errors.append(f'{ident} chapters differ from evidence')
  for ev in c['evidence']:
   if len(ev['match'].split())>10:errors.append(f'{ident} evidence over 10 words')
   if norm(ev['match']) not in chapters.get(ev['chapter'],''):errors.append(f'{ident} source match failed in {ev["chapter"]}')
  if norm(c['example']) in ' '.join(chapters.values()):errors.append(f'{ident} example copied from book')
  words=norm(c['example']).split()
  for start in range(max(0,len(words)-9)):
   fragment=' '.join(words[start:start+10])
   if any(fragment in source for source in chapters.values()):warnings.append(f'{ident} 10-word overlap in original example');break
  if re.search(r'\b(Harry|Hogwarts|Hermione|Dumbledore|Voldemort|Dursley|Quidditch)\b',c['example']):warnings.append(f'{ident} example uses book character/world')
  items.append(c)
summary={'cardsBeforeMerge':len(items),'types':dict(Counter(c['type'] for c in items)),'chapterCards':{n:sum(n in c['chapters'] for c in items) for n in chapters},'evidenceCount':sum(len(c['evidence']) for c in items),'errors':errors,'warnings':warnings}
(root/'private/validation-report.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
if errors:sys.exit(1)
