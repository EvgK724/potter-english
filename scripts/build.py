#!/usr/bin/env python3
"""Validate the exact offline release and copy public assets only."""
import hashlib, json, re, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
manifest=json.loads((ROOT/'audio/manifest.json').read_text())
assert manifest['voice']=='en-GB-RyanNeural'
data=(ROOT/'data.js').read_text()
start=re.search(r'export const BOOK_CARDS\s*=\s*',data).end()
cards,_=json.JSONDecoder().raw_decode(data[start:])
expected=set(re.findall(r'"audio(?:Phrase|Example)":\s*"([^"]+)"',data))
actual={item['path'] for item in manifest['files']}
assert expected==actual, f'Audio coverage mismatch: {expected ^ actual}'
for item in manifest['files']:
    raw=(ROOT/item['path']).read_bytes()
    assert len(raw)==item['bytes'], item['path']
    assert hashlib.sha256(raw).hexdigest()==item['sha256'], item['path']
files=['index.html','styles.css','app.js','engine.js','data.js','offline.js','sw.js','manifest.webmanifest']
dest=ROOT/'dist'
if dest.exists(): shutil.rmtree(dest)
dest.mkdir()
for name in files: shutil.copy2(ROOT/name,dest/name)
shutil.copytree(ROOT/'icons',dest/'icons')
(dest/'audio').mkdir()
shutil.copy2(ROOT/'audio/manifest.json',dest/'audio/manifest.json')
for filename in sorted(actual): shutil.copy2(ROOT/filename,dest/filename)
if (ROOT/'coverage.json').exists(): shutil.copy2(ROOT/'coverage.json',dest/'coverage.json')
(dest/'.nojekyll').touch()
print(json.dumps({'build':'passed','cards':len(cards),'audio':len(actual),'bytes':sum(i['bytes'] for i in manifest['files']),'output':str(dest)},ensure_ascii=False))
