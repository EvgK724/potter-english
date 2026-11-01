"""Extract the user-provided book into git-ignored private chapter files."""
import hashlib,json,re,zipfile,xml.etree.ElementTree as E
from pathlib import Path
root=Path(__file__).resolve().parent.parent
source=root/'private/dzhoan_rouling_harry_potter_and_.epub'
with zipfile.ZipFile(source) as z:
 if 'META-INF/encryption.xml' in z.namelist():raise RuntimeError('Encrypted EPUB: stop; no DRM bypass')
 opf=E.fromstring(z.read('OPS/content.opf')); ns={'dc':'http://purl.org/dc/elements/1.1/'}
 title=opf.find('.//dc:title',ns).text; language=opf.find('.//dc:language',ns).text
 chapters=[]
 for number in range(1,18):
  path=f'OPS/ch1-{number+1}.xhtml';doc=E.fromstring(z.read(path))
  paras=[''.join(p.itertext()) for p in doc.iter() if p.tag.split('}')[-1]=='p']
  heading=paras[0];text='\n\n'.join(paras[1:]); dest=root/'private'/f'chapter-{number:02d}.txt';dest.write_text(text)
  chapters.append({'number':number,'title':heading.split('. ',1)[-1].title(),'wordCount':len(re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*",text)),'sourceFile':path,'sha256':hashlib.sha256(text.encode()).hexdigest()})
 info={'title':title,'language':language,'edition':'US wording / user-provided EPUB; publisher and ISBN unverified','sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'chapters':chapters,'wordCount':sum(c['wordCount'] for c in chapters),'drm':'no encryption manifest'}
 (root/'private/source-metadata.json').write_text(json.dumps(info,ensure_ascii=False,indent=2))
 print(json.dumps(info,ensure_ascii=False,indent=2))
