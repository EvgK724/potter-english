"""Merge reviewed senses, strip private evidence, and preserve stable audio IDs."""
import hashlib,json,re
from pathlib import Path
from collections import Counter
root=Path(__file__).resolve().parent.parent
norm=lambda x:re.sub(r'\s+',' ',x.lower().replace('’',"'")).strip()
key=lambda c:hashlib.sha256('|'.join([norm(c['phrase']),c['type'],norm(c['meaning'])]).encode()).hexdigest()[:12]
files=['curated-01-04.json','curated-05-08.json','curated-09-12.json','curated-13-17.json','curated-qa-additions.json']
all_entries=[];entries={}
for filename in files:
 for c in json.loads((root/'private'/filename).read_text()):
  k=key(c);all_entries.append(c)
  if k in entries:
   entries[k]['chapters']=sorted(set(entries[k]['chapters']+c['chapters']))
   entries[k]['evidence']+=c['evidence']
  else:entries[k]=dict(c)
parents={k:k for k in entries}
def find(k):
 while parents[k]!=k:k=parents[k]
 return k
plan=json.loads((root/'private/merge-plan.json').read_text())
for group in plan['groups']:
 keys=group['keys'];assert all(k in entries for k in keys),f'Stale merge keys: {keys}'
 first=find(keys[0])
 for other in keys[1:]:parents[find(other)]=first
clusters={}
for k in entries:clusters.setdefault(find(k),[]).append(k)
merged=[];membership={}
for leader,keys in clusters.items():
 chosen=entries[leader];result=dict(chosen)
 result['chapters']=sorted({n for k in keys for n in entries[k]['chapters']})
 result['evidence']=[e for k in keys for e in entries[k]['evidence']]
 result['aliases']=sorted({entries[k]['phrase'] for k in keys if entries[k]['phrase']!=chosen['phrase']})
 result['id']='hp-'+leader;result['chapter']=result['chapters'][0];result['source']='book'
 result['_mergedKeys']=keys
 merged.append(result)
 for k in keys:membership[k]=result
applied=[]
for qafile in sorted((root/'private').glob('qa-*.json')):
 qa=json.loads(qafile.read_text())
 for fix in qa.get('fixes',[]):
  updates=fix.get('suggested_fields',{})
  if not updates:continue
  matches=[k for k,c in entries.items() if c['phrase']==fix['phrase'] and c['meaning']==fix['meaning']]
  for k in matches:
   membership[k].update(updates);applied.append({'id':membership[k]['id'],'fields':list(updates),'review':qafile.name})
taxonomy_path=root/'private/final-educational-audit.json'
taxonomy=json.loads(taxonomy_path.read_text()) if taxonomy_path.exists() else {'sampled':[],'fixes':[]}
excluded=[]
for fix in taxonomy['fixes']:
    matched=next((c for c in merged if c['id']==fix['id']),None)
    if not matched: raise ValueError('Taxonomy fix references unknown id: '+fix['id'])
    if fix['action']=='exclude':
        excluded.append(fix['id']);merged.remove(matched)
    elif fix['action']=='reclassify':
        matched['type']=fix['newType'];matched.update(fix.get('suggested_fields',{}))

# Keep the full merge provenance locally, never in public card data.
(root/'private/merged-with-evidence.json').write_text(json.dumps(merged,ensure_ascii=False,indent=2))
public=[]
for c in sorted(merged,key=lambda c:(c['chapter'],['phrasal','idiom','collocation'].index(c['type']),norm(c['phrase']),c['meaning'])):
 p={k:c[k] for k in ['id','phrase','type','meaning','note','example','translation','chapter','chapters','source']}
 if c['aliases']:p['aliases']=c['aliases'];p['variants']=c['aliases']
 p['audioPhrase']='audio/phrase-'+hashlib.sha256(p['phrase'].encode()).hexdigest()[:12]+'.mp3'
 p['audioExample']='audio/'+p['id']+'-example.mp3'
 public.append(p)
source=json.loads((root/'private/source-metadata.json').read_text())
meta={'title':source['title'],'editionLabel':'US text · British Ryan voice','editionNote':'Title and wording verified in the supplied EPUB; publisher and ISBN unverified.','sourceSha256':source['sha256'],'wordCount':source['wordCount'],'chapters':[{k:c[k] for k in ['number','title','wordCount']} for c in source['chapters']],'reviewedDate':'2026-11-01'}
(root/'data.js').write_text('export const BOOK_META = '+json.dumps(meta,ensure_ascii=False,indent=2)+';\n\nexport const BOOK_CARDS = '+json.dumps(public,ensure_ascii=False,indent=2)+';\n')
coverage={'title':source['title'],'sourceSha256':source['sha256'],'edition':meta['editionNote'],'chaptersRead':17,'sourceWords':source['wordCount'],'wordCountMethod':'English alphabetic tokens including apostrophe compounds; chapter headings excluded.','cardsBeforeCrossChapterMerge':len(all_entries),'uniqueExpressionSenses':len(public),'types':dict(Counter(c['type'] for c in public)),'verifiedEvidenceCount':sum(len(c['evidence']) for c in merged),'qaFixesApplied':len(applied),'educationalSamplesReviewed':len(taxonomy['sampled']),'falsePositivesExcluded':len(excluded),'taxonomyChanges':sum(f['action']=='reclassify' for f in taxonomy['fixes']),'method':'Full reading of all 17 supplied chapters; semantic selection of phrasal verbs, idioms/fixed formulas and conventional collocations; short exact-source evidence verified privately; cross-chapter deduplication retaining different senses; original B2 examples and Russian explanations. Chapter lists mean verified appearances, not an exhaustive concordance.','completeness':'All chapters were reviewed. Absolute exhaustiveness of the open class of collocations is not claimed.','sourceTextPublished':False,'chapters':[dict(c,expressionSenses=sum(c['number'] in x['chapters'] for x in public)) for c in meta['chapters']]}
(root/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2)+'\n')
(root/'private/merge-result.json').write_text(json.dumps({'before':len(all_entries),'exactUnique':len(entries),'after':len(public),'qaFixes':applied},ensure_ascii=False,indent=2))
print(json.dumps({'before':len(all_entries),'after':len(public),'types':coverage['types'],'qaFixes':len(applied)},ensure_ascii=False))
