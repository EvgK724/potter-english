/** Run after build. Uses a local HTTP server with actual connection failures. */
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..'),DIST=path.join(ROOT,'dist');let disconnected=false;
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.mp3':'audio/mpeg','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=http.createServer((req,res)=>{
 if(disconnected){req.socket.destroy();return;}
 const url=new URL(req.url,'http://localhost');
 if(!url.pathname.startsWith('/potter-english/')){res.writeHead(404);res.end();return;}
 let name=decodeURIComponent(url.pathname.slice('/potter-english/'.length))||'index.html';
 const file=path.resolve(DIST,name);if(!file.startsWith(DIST+path.sep)){res.writeHead(403);res.end();return;}
 try{res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
const BASE='http://127.0.0.1:4175/potter-english/';
(async()=>{
 await new Promise(r=>server.listen(4175,'127.0.0.1',r));fs.mkdirSync(path.join(ROOT,'evidence'),{recursive:true});const report=[];
 for(const [name,type] of Object.entries({chromium,webkit})){
  disconnected=false;const browser=await type.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1});
  await context.addInitScript(()=>{const Original=window.Audio;window.Audio=function(...args){const a=new Original(...args);window.__testAudio=a;return a;};});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelectorAll('.expression-card').length>0);
  const cards=await page.evaluate(async()=>{const d=await import('./data.js');return d.BOOK_CARDS;});
  for(const width of [320,360,375,390,430,820,1280]){
   await page.setViewportSize({width,height:900});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,`${name} overflow ${width}`);
   if(width===390||width===1280)await page.screenshot({path:path.join(ROOT,`evidence/${name}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:320,height:900});
  await page.addStyleTag({content:'p,.card-meaning,.example-translation,.example-text,.note-box{font-size:22px!important}'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,`${name} large text overflow`);
  await page.reload({waitUntil:'networkidle'});await page.setViewportSize({width:390,height:844});
  await page.locator('#search').fill(cards[0].phrase);
  assert.ok(await page.locator('.expression-card').count()>0,'Search');
  await page.locator('#search').fill('невозможный-поиск-1729');assert.ok(await page.locator('#empty').isVisible(),'Empty');
  await page.locator('#reset-filters').click();
  await page.locator('[data-type="idiom"]').click();
  assert.ok((await page.locator('.type-label').allTextContents()).every(x=>x.startsWith('Идиома')),'Type filter');
  await page.locator('[data-type="all"]').click();
  await page.locator('#chapter-filter').selectOption('17');
  const expected=cards.filter(c=>c.chapters.includes(17)).length;
  assert.ok((await page.locator('#results-line').textContent()).startsWith(String(expected)+' '),'Chapter filter');
  await page.locator('#chapter-filter').selectOption('all');
  await page.locator('[data-star]').first().click();await page.locator('#bookmark-filter').click();assert.equal(await page.locator('.expression-card').count(),1,'Bookmark');await page.locator('#bookmark-filter').click();
  await page.locator('[data-open]').first().click();assert.ok(await page.locator('#detail-dialog').isVisible());
  await page.locator('#detail-content [data-audio]').first().click();
  await page.waitForFunction(()=>window.__testAudio?.currentTime>.1&&!window.__testAudio.paused);
  await page.locator('#detail-content [data-audio]').last().click();
  await page.waitForFunction(()=>window.__testAudio?.currentTime>.1&&!window.__testAudio.paused);
  await page.locator('#close-dialog').click();await page.locator('#start-practice').click();
  assert.equal(await page.locator('#practice-answer').isVisible(),false);await page.locator('#reveal-answer').click();assert.ok(await page.locator('#practice-answer').isVisible());await page.screenshot({path:path.join(ROOT,`evidence/${name}-practice.png`),fullPage:true});await page.locator('[data-review="later"]').click();
  assert.ok(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('potter-english-v1')).reviews).length)>0,'Review persisted');
  await page.locator('[data-view="offline"]').click();await page.locator('#offline-chapter').selectOption('17');await page.locator('#download-all').click();
  await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.startsWith('Готово офлайн')&&!document.querySelector('#download-all').disabled,null,{timeout:180000});
  const chapterFiles=new Set(cards.filter(c=>c.chapters.includes(17)).flatMap(c=>[c.audioPhrase,c.audioExample]));
  assert.ok((await page.locator('#download-count').textContent()).startsWith(`${chapterFiles.size} из ${chapterFiles.size}`),'Chapter audio coverage');
  await page.locator('#offline-chapter').selectOption('all');await page.locator('#download-all').click();
  await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.startsWith('Готово офлайн')&&!document.querySelector('#download-all').disabled,null,{timeout:180000});
  await page.screenshot({path:path.join(ROOT,`evidence/${name}-offline.png`),fullPage:true});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  disconnected=true;await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>document.querySelector('#offline-status').textContent.startsWith('Готово офлайн')&&!document.querySelector('#download-all').disabled);
  await page.locator('[data-view="library"]').click();await page.locator('#search').fill(cards.at(-1).phrase);await page.locator('[data-open]').last().click();await page.locator('#detail-content [data-audio]').last().click();
  await page.waitForFunction(()=>window.__testAudio?.currentTime>.1&&!window.__testAudio.paused);
  assert.equal(await page.locator('.audio-error').count(),0);await page.locator('#close-dialog').click();
  const page2=await context.newPage();page2.on('pageerror',e=>errors.push(e.message));await page2.goto(BASE,{waitUntil:'load'});await page2.waitForFunction(()=>document.querySelectorAll('.expression-card').length>0);
  // Remove an uncached target while network is physically disconnected: no fallback voice.
  await page2.evaluate(async target=>{const c=await caches.open('hp-pocket-audio-v1');await c.delete(new URL(target,location.href).href);},cards[0].audioPhrase);
  await page2.locator('[data-audio]').first().click();await page2.waitForFunction(()=>document.querySelector('.audio-error'));
  // New import stays literal text and on device; malformed JSON is rejected.
  await page2.locator('[data-view="book"]').click();
  await page2.locator('#import-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});
  await page2.waitForFunction(()=>document.querySelector('#import-result').classList.contains('error-text'));
  assert.ok((await page2.locator('#import-result').textContent()).includes('JSON'));
  await page2.locator('#import-file').setInputFiles({name:'senses.txt',mimeType:'text/plain',buffer:Buffer.from('CHAPTER ONE\nThe flight will take off soon. Please take off your coat.')});
  await page2.waitForFunction(()=>document.querySelector('#import-result').classList.contains('success-text'));
  await page2.locator('#use-book').click();assert.ok(await page2.locator('.candidate-note').count()>0);
  await page2.locator('#start-practice').click();assert.equal(await page2.locator('#reveal-answer').count(),0,'Unconfirmed import excluded from practice');
  await page2.locator('[data-view="library"]').click();await page2.locator('[data-open]').first().click();await page2.locator('[data-confirm-sense]').click();await page2.locator('#close-dialog').click();await page2.locator('#start-practice').click();assert.ok(await page2.locator('#reveal-answer').isVisible(),'Confirmed candidate reaches practice');
  await page2.locator('[data-view="book"]').click();
  const malicious={cards:[{id:'xss',phrase:'<img src=x onerror=alert(1)>',type:'idiom',meaning:'Безопасный текст',example:'This is a local test.',translation:'Это локальная проверка.',note:'Проверка',chapter:1}]};
  await page2.locator('#import-file').setInputFiles({name:'test.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malicious))});
  await page2.waitForFunction(()=>document.querySelector('#import-result').classList.contains('success-text'));
  await page2.locator('#use-book').click();assert.equal(await page2.locator('#card-list .card-phrase img').count(),0);assert.ok((await page2.locator('#card-list .card-phrase').textContent()).includes('<img'));
  await page2.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError');};});
  await page2.locator('#start-practice').click();await page2.locator('#reveal-answer').click();await page2.locator('[data-review="later"]').click();assert.ok((await page2.locator('#practice-card').textContent()).includes('только в этом сеансе'),'Storage failure is not reported as saved');
  assert.equal(errors.length,0,errors.join('\n'));
  report.push({browser:name,cards:cards.length,viewportWidths:[320,360,375,390,430,820,1280],lessonText22px:true,search:true,types:true,chapters:true,bookmarks:true,hiddenRecall:true,reviewPersistence:true,phraseAndExamplePlayback:true,chapterDownload:true,allAudioDownload:true,offlineReload:true,offlineNewPage:true,unplayedExampleOffline:true,audioMissingError:true,importValidation:true,ambiguousImportNeedsConfirmation:true,storageFailureHonest:true,pageErrors:errors});
  await browser.close();
 }
 fs.writeFileSync(path.join(ROOT,'evidence/browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));server.close();
})().catch(error=>{console.error(error);server.close();process.exit(1)});
