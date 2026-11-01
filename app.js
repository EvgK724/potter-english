import { BOOK_CARDS, BOOK_META } from './data.js';
import { filterCards, parseBook, validateDeck, scheduleReview, MAX_BOOK_BYTES } from './engine.js';
import { OfflineManager } from './offline.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const KEY = 'potter-english-v1';
const TYPE = { phrasal: 'Фразовый / предложный глагол', idiom: 'Идиома / устойчивый оборот', collocation: 'Коллокация' };
const REQUIRED_AUDIO = new Map(BOOK_CARDS.flatMap(c=>[[c.audioPhrase,c.phrase],[c.audioExample,c.example]]));
const E = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT = { version: 1, bookmarks: [], reviews: {}, source: 'corpus', book: null, rate: 1 };
let state = { ...DEFAULT }, storageError = false;
function cleanState(value) {
  if (!value || value.version !== 1) throw new Error('Это не резервная копия Potter English.');
  const result = { ...DEFAULT, bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks.filter(x => typeof x === 'string' && /^[a-z0-9_-]{1,110}$/i.test(x)).slice(0,5000) : [], reviews: {}, rate: [0.8,1,1.15].includes(value.rate) ? value.rate : 1 };
  if (value.reviews && typeof value.reviews === 'object') for (const [id,r] of Object.entries(value.reviews).slice(0,5000)) {
    if (/^[a-z0-9_-]{1,110}$/i.test(id) && r && Number.isInteger(r.stage) && r.stage>=0 && r.stage<=3 && Number.isFinite(r.dueAt) && Number.isFinite(r.reviewedAt)) result.reviews[id] = {stage:r.stage,dueAt:r.dueAt,reviewedAt:r.reviewedAt,reviews:Number.isSafeInteger(r.reviews)?r.reviews:1,intervalDays:[1,3,7,14][r.stage],lastChoice:r.lastChoice==='again'?'again':'later'};
  }
  if (value.book && Array.isArray(value.book.cards)) {
    const cards = value.book.cards.length ? validateDeck(value.book.cards).map((card,i) => ({...card,id:value.book.cards[i].id||card.id,needsSenseReview:value.book.coverage==='dictionary-matches'&&value.book.cards[i].needsSenseReview===undefined?true:card.needsSenseReview})) : [];
    const chapters = Array.isArray(value.book.chapters) ? value.book.chapters.slice(0,17).filter(c => Number.isInteger(c.number)&&c.number>=1&&c.number<=17).map(c=>({number:c.number,title:String(c.title??`Глава ${c.number}`).slice(0,100),wordCount:Number.isFinite(c.wordCount)?c.wordCount:0,matches:cards.filter(x=>x.chapter===c.number).length})) : [];
    result.book = {title:String(value.book.title||'Мой текст').slice(0,160),filename:String(value.book.filename||'Мой текст').slice(0,160),wordCount:Number.isFinite(value.book.wordCount)?value.book.wordCount:0,coverage:value.book.coverage==='dictionary-matches'?'dictionary-matches':'user-deck',chapters,cards};
    result.source = value.source==='book'?'book':'corpus';
  }
  return result;
}
try { const raw=localStorage.getItem(KEY); if(raw) state=cleanState(JSON.parse(raw)); } catch { storageError=true; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); storageError=false; return true; } catch { storageError=true; toast('Не удалось сохранить прогресс. Проверь свободное место или сохрани резервную копию.'); return false; } }
let filters={query:'',type:'all',chapter:'all',bookmarkedOnly:false}, visible=12, view='library';
let practiceQueue=[], practicePosition=0, practiceRevealed=false, detailId=null, toastTimer;
let audio = new Audio(), playingPath=null, playToken=0, audioTimeout;
audio.preload='none';
let manifestReady=false, downloaded=false, offlineBusy=false;
const allCards=()=>state.source==='book' && state.book ? state.book.cards : BOOK_CARDS;
const findCard=id=>allCards().find(c=>c.id===id)||BOOK_CARDS.find(c=>c.id===id);
const pathsFor=cards=>[...new Set(cards.flatMap(c=>[c.audioPhrase,c.audioExample]).filter(Boolean))];
const size=bytes=>`${(bytes/1024/1024).toLocaleString('ru-RU',{maximumFractionDigits:1,minimumFractionDigits:1})} МБ`;
function toast(message){ $('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500); }
function show(viewName, updateHash=true) {
  if(!['library','practice','book','offline'].includes(viewName)) viewName='library';
  view=viewName; $$('.view').forEach(el=>el.hidden=el.id!==`view-${view}`);
  $$('.nav-item').forEach(el=>{const active=el.dataset.view===view;el.classList.toggle('active',active);active?el.setAttribute('aria-current','page'):el.removeAttribute('aria-current');});
  if(updateHash) history.replaceState(null,'',`#${view}`);
  if(view==='practice') { if(!practiceQueue.length) startPractice(); else renderPractice(); }
  if(view==='book') renderBook();
  if(view==='offline' && !offlineBusy) refreshOffline();
  window.scrollTo({top:0,behavior:'instant'});
}
function audioButton(path,label,cardId,kind='phrase') {
  if(!path)return '<span class="quiet-label">Запись Ryan пока не добавлена</span>';
  return `<button class="audio-button${playingPath===path?' playing':''}" type="button" data-audio="${E(path||'')}" data-card="${E(cardId)}" data-kind="${kind}" data-label="${E(label)}" aria-pressed="${playingPath===path}" aria-label="${E(label)}"><span class="audio-icon" aria-hidden="true">${playingPath===path?'■':'▷'}</span><span>${playingPath===path?'Остановить':kind==='example'?'Слушать пример':'Слушать · Ryan'}</span></button>`;
}
function starButton(card){return `<button class="icon-button${state.bookmarks.includes(card.id)?' saved':''}" type="button" data-star="${E(card.id)}" aria-label="${state.bookmarks.includes(card.id)?'Убрать из избранного':'В избранное'}: ${E(card.phrase)}" aria-pressed="${state.bookmarks.includes(card.id)}">${state.bookmarks.includes(card.id)?'★':'☆'}</button>`;}
function cardMarkup(card){return `<article class="expression-card"><div class="card-top"><span class="type-label ${card.type}">${TYPE[card.type]}</span>${starButton(card)}</div><h3 lang="en" class="card-phrase">${E(card.phrase)}</h3><p class="card-meaning">${E(card.meaning)}</p>${card.needsSenseReview?'<p class="candidate-note">Совпадение в TXT · проверь значение</p>':''}<div class="card-footer">${audioButton(card.audioPhrase,`Слушать выражение ${card.phrase}`,card.id)}<button class="card-open" type="button" data-open="${E(card.id)}" aria-label="Разобрать ${E(card.phrase)}">Разобрать <span aria-hidden="true">↗</span></button></div></article>`;}
function renderLibrary(){
  const cards=allCards(), matches=filterCards(cards,{...filters,bookmarks:state.bookmarks});
  $('#dictionary-count').textContent=cards.length;
  $('#source-description').textContent=state.source==='corpus'?`${BOOK_CARDS.length} выражений · ${BOOK_META.chapters.length} глав · текст US edition, голос Ryan (UK).`:`Мой текст · ${cards.length} карточек. ${state.book.coverage==='dictionary-matches'?'Словарные совпадения; полнота не подтверждена.':'Импортированный учебный набор.'}`;
  $('.source-banner .source-badge').textContent=state.source==='corpus'?'17 ГЛАВ':'МОЙ ТЕКСТ';
  $('#results-line').textContent=`${matches.length} из ${cards.length} · ${state.source==='corpus'?'оригинальные учебные примеры':'только локально на этом устройстве'}`;
  $('#card-list').innerHTML=matches.slice(0,visible).map(cardMarkup).join('');
  $('#empty').hidden=matches.length>0;$('#load-more').hidden=matches.length<=visible;
  $('#bookmark-filter').setAttribute('aria-pressed',String(filters.bookmarkedOnly));$('#bookmark-filter').textContent=filters.bookmarkedOnly?'★ Избранное':'☆ Избранное';
  $$('[data-type]').forEach(el=>{el.classList.toggle('active',el.dataset.type===filters.type);el.setAttribute('aria-pressed',String(el.dataset.type===filters.type));});
}
function updateChapterOptions(){
  const chapters=state.source==='book'&&state.book?state.book.chapters:BOOK_META.chapters;
  $('#chapter-filter').innerHTML='<option value="all">Все главы</option>'+chapters.map(c=>`<option value="${c.number}">Глава ${c.number} · ${E(c.title)}</option>`).join('');
  $('#chapter-filter').value=filters.chapter;
  $('#chapter-filter').disabled=!chapters.length;
  $('#chapter-filter').title=chapters.length?'Выбери главу':'Главы появятся после импорта текста';
  $('#offline-chapter').innerHTML='<option value="all">Вся доступная озвучка</option>'+chapters.map(c=>`<option value="${c.number}">Глава ${c.number} · ${E(c.title)}</option>`).join('');
}
function exampleMarkup(card){return `<div class="example-block"><div class="eyebrow">ПРИМЕР ДЛЯ ПРАКТИКИ</div><p class="example-text" lang="en">${E(card.example)}</p><p class="example-translation">${E(card.translation)}</p>${audioButton(card.audioExample,`Слушать пример: ${card.example}`,card.id,'example')}</div><p class="note-box">${E(card.note)}</p>`;}
function openDetail(id){const card=findCard(id);if(!card)return;detailId=id;$('#detail-content').innerHTML=`<span class="type-label ${card.type}">${TYPE[card.type]}${card.chapters?.length>1?` · ${card.chapters.length} глав`:card.chapter?` · Глава ${card.chapter}`:''}</span><h2 class="card-phrase detail-phrase" lang="en">${E(card.phrase)}</h2><p class="detail-meaning">${E(card.meaning)}</p><div class="detail-actions">${audioButton(card.audioPhrase,`Слушать выражение ${card.phrase}`,id)}${starButton(card)}</div>${exampleMarkup(card)}${card.needsSenseReview?`<div class="note-box">Найдено совпадение написания в TXT. Значение в этом контексте ещё не проверено. Сверь его со своим текстом перед практикой.</div><button class="primary" type="button" data-confirm-sense="${E(card.id)}">Это значение подходит</button>`:''}<p class="footnote">${card.source==='book'?`Подтверждено в главах: ${(card.chapters||[card.chapter]).join(', ')}. Пример создан для обучения, не цитата.`:'Карточка из твоего локального набора.'}</p>`;if(!$('#detail-dialog').open)$('#detail-dialog').showModal();}
function startPractice(force=false){
  const now=Date.now();practiceQueue=filterCards(allCards(),{...filters,bookmarks:state.bookmarks}).filter(c=>!c.needsSenseReview&&(force||!state.reviews[c.id]||state.reviews[c.id].dueAt<=now));
  practicePosition=0;practiceRevealed=false;renderPractice();
}
function renderPractice(){
  const card=practiceQueue[practicePosition];const total=practiceQueue.length;
  $('#practice-summary').textContent=total?`Карточка ${Math.min(practicePosition+1,total)} из ${total} · ${state.source==='corpus'?'Sorcerer’s Stone · US edition':'мой текст'}`:'Повторение без спешки';
  if(!card){$('#practice-card').innerHTML=`<div class="practice-end"><h2>${total?'На сегодня готово.':'Сейчас нет карточек к повторению.'}</h2><p>${total?(storageError?'Повторы доступны только в этом сеансе: сохранить их не удалось. Экспортируй резервную копию в разделе «Книга».':'Ты вернулся к выражениям и вспомнил их. Следующие повторы сохранены на этом устройстве.'):'Можно изменить фильтры в словаре или подтвердить значения карточек, найденных при TXT‑импорте.'}</p><button class="primary" type="button" id="practice-again">Повторить набор</button></div>`;return;}
  $('#practice-card').innerHTML=`<article class="practice-box"><div class="card-top"><span class="type-label ${card.type}">${TYPE[card.type]}</span>${starButton(card)}</div><div class="quiet-label">КАК СКАЗАТЬ ПО‑АНГЛИЙСКИ?</div><h2 class="meaning-prompt">${E(card.meaning)}</h2><button class="${practiceRevealed?'outline':'primary'}" type="button" id="reveal-answer" aria-expanded="${practiceRevealed}" aria-controls="practice-answer">${practiceRevealed?'Скрыть ответ':'Показать ответ'}</button><div id="practice-answer" class="practice-answer" ${practiceRevealed?'':'hidden'}><h3 class="card-phrase" lang="en">${E(card.phrase)}</h3>${audioButton(card.audioPhrase,`Слушать выражение ${card.phrase}`,card.id)}${exampleMarkup(card)}<div class="practice-actions"><button class="outline" type="button" data-review="again">Ещё раз · завтра</button><button class="primary" type="button" data-review="later">Позже <span aria-hidden="true">→</span></button></div></div></article>`;
}
function renderBook(){
  $('#corpus-explanation').textContent=`${BOOK_CARDS.length} выражений из 17 глав: фразовые глаголы, идиомы и коллокации. Для каждого — русский смысл, пояснение, пример, перевод и две записи Ryan.`;
  $('#use-corpus').textContent=state.source==='corpus'?'Основной набор выбран':'Открыть основной набор';
  const book=state.book || {title:BOOK_META.title,wordCount:BOOK_META.wordCount,chapters:BOOK_META.chapters,cards:BOOK_CARDS,coverage:'source-reviewed'};
  const isSource=!state.book;
  $('#book-summary').innerHTML=`<div class="panel"><div class="eyebrow">${isSource?'ПРОВЕРЕННЫЙ ИСТОЧНИК':'ЛОКАЛЬНЫЙ ИСТОЧНИК'}</div><h2>${E(book.title)}</h2><p>${book.wordCount?`${book.wordCount.toLocaleString('ru-RU')} слов · `:''}${book.chapters.length} глав · ${book.cards.length} карточек</p><p class="footnote">${isSource?'Все 17 глав прочитаны; принадлежность выражений проверена по загруженному EPUB. Устойчивые сочетания отобраны по смыслу. Абсолютная полнота коллокаций не заявляется: граница этой категории открыта. Издатель и ISBN файла не подтверждены.':book.coverage==='dictionary-matches'?'Найдены только буквальные совпадения с учебным словарём. Изменённые формы, разрывные конструкции и другие выражения могут быть пропущены. Полнота не подтверждена.':'Подготовленный пользователем набор. Полнота и принадлежность выбранному изданию не проверены приложением.'}</p>${isSource?'':`<div class="button-row"><button class="primary" id="use-book" type="button">Открыть мой набор</button><button class="outline" id="delete-book" type="button">Удалить мой набор</button></div>`}</div>`;
  const displayBook=state.source==='book'&&state.book?state.book:{chapters:BOOK_META.chapters,cards:BOOK_CARDS};
  $('#chapter-list').innerHTML=displayBook.chapters.map(ch=>`<button class="chapter-row" type="button" data-chapter="${ch.number}"><span><span class="chapter-num">${String(ch.number).padStart(2,'0')}</span><span class="chapter-title">${E(ch.title)}</span></span><small>${displayBook.cards.filter(c=>c.chapters?c.chapters.includes(ch.number):c.chapter===ch.number).length} выражений ↗</small></button>`).join('');
}
function setSource(source){state.source=source;filters={query:'',type:'all',chapter:'all',bookmarkedOnly:false};$('#search').value='';visible=12;practiceQueue=[];save();updateChapterOptions();renderLibrary();show('library');}
function stopAudio(){playToken++;clearTimeout(audioTimeout);audio.pause();audio.removeAttribute('src');audio.load();playingPath=null;syncAudioButtons();}
function syncAudioButtons(){ $$('[data-audio]').forEach(el=>{const active=!!playingPath&&el.dataset.audio===playingPath;el.classList.toggle('playing',active);el.setAttribute('aria-pressed',String(active));el.setAttribute('aria-label',active?'Остановить озвучку':el.dataset.label);el.querySelector('.audio-icon').textContent=active?'■':'▷';el.lastElementChild.textContent=active?'Остановить':el.dataset.kind==='example'?'Слушать пример':'Слушать · Ryan';}); }
function audioFailure(message){stopAudio();toast(message);const host=$('#detail-dialog').open?$('#detail-content'):view==='practice'?$('#practice-card'):$('.dictionary');if(host){const old=host.querySelector?.('.audio-error');old?.remove();const error=document.createElement('p');error.className='audio-error';error.setAttribute('role','alert');error.textContent=message;host.append(error);}}
async function play(path,cardId,kind){
  if(playingPath===path){stopAudio();return;}
  stopAudio();
  if(!path||!/^audio\/[a-z0-9_-]+\.mp3$/i.test(path)){audioFailure('Для этой карточки запись Ryan пока не добавлена.');return;}
  if(manifestReady && !offline.manifest.files.some(file=>file.path===path)){audioFailure('Для этой карточки запись Ryan отсутствует в проверенном каталоге.');return;}
  const card=findCard(cardId), recorded=offline.manifest?.clips?.[path];
  if(recorded&&card&&recorded.text!==card[kind==='example'?'example':'phrase']){audioFailure('Запись Ryan не соответствует тексту этой карточки. Нужна новая запись.');return;}
  const token=++playToken;playingPath=path;audio.src=new URL(path,import.meta.url).href;audio.playbackRate=state.rate;syncAudioButtons();
  audioTimeout=setTimeout(()=>{if(token===playToken)audioFailure('Запись не загрузилась. Проверь интернет или сохрани её в разделе «Офлайн».');},15000);
  try{await audio.play();if(token===playToken)clearTimeout(audioTimeout);}catch(error){if(token!==playToken)return;audioFailure(error.name==='NotAllowedError'?'Браузер не разрешил запуск. Нажми кнопку воспроизведения ещё раз.':'Запись недоступна. Подключись к интернету и скачай озвучку в разделе «Офлайн».');}
}
audio.addEventListener('ended',()=>{playingPath=null;clearTimeout(audioTimeout);syncAudioButtons();});
audio.addEventListener('error',()=>{if(playingPath)audioFailure('Не удалось открыть запись Ryan. Проверь, сохранена ли она в разделе «Офлайн».');});
function selectedAudioPaths(){const chapter=$('#offline-chapter').value;if(chapter==='all')return undefined;return pathsFor(allCards().filter(c=>c.chapters?c.chapters.includes(Number(chapter)):String(c.chapter)===chapter));}
function catalogComplete(){const m=offline.manifest;if(!m)return false;const paths=new Set(m.files.map(f=>f.path));return [...REQUIRED_AUDIO].every(([path,text])=>paths.has(path)&&m.clips?.[path]?.text===text&&m.clips[path].voice==='en-GB-RyanNeural');}
function requireCatalog(){if(!catalogComplete())throw new Error('Каталог озвучки ещё не содержит все записи этого набора. Обнови приложение с интернетом.');}
function showOfflineStatus(info){
  if(info.complete&&!catalogComplete()){info={...info,complete:false,error:'Каталог озвучки неполный. Обнови приложение с интернетом.'};}
  if(info.error){$('#offline-status').textContent=info.error;$('#header-status').textContent='Проверить офлайн';return;}
  if(!info.supported){$('#offline-status').textContent='Офлайн‑сохранение недоступно. Открой HTTPS‑ссылку в Safari или Chrome.';$('#download-all').disabled=true;return;}
  if(!offlineBusy){$('#download-count').textContent=`${info.cached} из ${info.total} записей`;$('#download-size').textContent=`${size(info.bytes)} / ${size(info.totalBytes)}`;$('#download-progress').max=info.totalBytes||1;$('#download-progress').value=info.bytes;}
  $('#offline-status').textContent=info.complete?`Готово офлайн: приложение и ${info.cached} записей Ryan сохранены.`:info.shellReady?`Приложение сохранено. Озвучка: ${info.cached} из ${info.total} записей.`:'Файлы приложения ещё не сохранены. Повтори с интернетом.';
  if($('#offline-chapter').value==='all'){downloaded=info.complete;$('#header-status').textContent=downloaded?'Готово офлайн':info.shellReady?'Скачать аудио':'Офлайн';}
}
const offline=new OfflineManager({onStatus:showOfflineStatus,onProgress:info=>{
  $('#download-progress').max=info.totalBytes||1;$('#download-progress').value=info.bytes;$('#download-count').textContent=`${info.cached} из ${info.total} записей`;$('#download-size').textContent=`${size(info.bytes)} / ${size(info.totalBytes)}`;
  if(info.phase==='downloading')$('#offline-status').textContent=`Сохраняем Ryan… ${info.percent}%`;
  if(info.phase==='checking')$('#offline-status').textContent='Проверяем уже сохранённые записи…';
}});
async function refreshOffline(){try{if(!offline.manifest){await offline.init();requireCatalog();manifestReady=true;}else {requireCatalog();await offline.inspect(selectedAudioPaths());}}catch(error){$('#offline-status').textContent=error.message;$('#header-status').textContent='Проверить офлайн';}}
function busy(value){offlineBusy=value;$('#download-all').disabled=value;$('#cancel-download').hidden=!value;$('#offline-chapter').disabled=value;$('#clear-audio').disabled=value;}

$('#navigation').addEventListener('click',e=>{const button=e.target.closest('[data-view]');if(button)show(button.dataset.view);});
$$('[data-goto]').forEach(el=>el.addEventListener('click',()=>show(el.dataset.goto)));
$('.brand').addEventListener('click',e=>{e.preventDefault();show('library');});
$('#header-offline').addEventListener('click',()=>show('offline'));
$('#start-practice').addEventListener('click',()=>{startPractice();show('practice');});
$('#search').addEventListener('input',e=>{filters.query=e.target.value;visible=12;renderLibrary();practiceQueue=[];});
$$('[data-type]').forEach(el=>el.addEventListener('click',()=>{filters.type=el.dataset.type;visible=12;renderLibrary();practiceQueue=[];}));
$('#chapter-filter').addEventListener('change',e=>{filters.chapter=e.target.value;visible=12;renderLibrary();practiceQueue=[];});
$('#bookmark-filter').addEventListener('click',()=>{filters.bookmarkedOnly=!filters.bookmarkedOnly;visible=12;renderLibrary();practiceQueue=[];});
$('#reset-filters').addEventListener('click',()=>{filters={query:'',type:'all',chapter:'all',bookmarkedOnly:false};$('#search').value='';$('#chapter-filter').value='all';practiceQueue=[];renderLibrary();});
$('#load-more').addEventListener('click',()=>{visible+=12;renderLibrary();});
$('#close-dialog').addEventListener('click',()=>$('#detail-dialog').close());
$('#detail-dialog').addEventListener('click',e=>{if(e.target===$('#detail-dialog')){const rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)e.target.close();}});
$('#detail-dialog').addEventListener('close',()=>{detailId=null;stopAudio();});
$('#use-corpus').addEventListener('click',()=>setSource('corpus'));
$('#playback-rate').value=state.rate;
$('#playback-rate').addEventListener('change',e=>{state.rate=Number(e.target.value);audio.playbackRate=state.rate;save();});
document.addEventListener('click',e=>{
  const audioBtn=e.target.closest('[data-audio]');if(audioBtn){play(audioBtn.dataset.audio,audioBtn.dataset.card,audioBtn.dataset.kind);return;}
  const star=e.target.closest('[data-star]');if(star){const id=star.dataset.star;state.bookmarks=state.bookmarks.includes(id)?state.bookmarks.filter(x=>x!==id):[...state.bookmarks,id];save();renderLibrary();if(detailId)openDetail(detailId);if(view==='practice')renderPractice();return;}
  const confirmSense=e.target.closest('[data-confirm-sense]');if(confirmSense){const candidate=state.book?.cards.find(c=>c.id===confirmSense.dataset.confirmSense);if(candidate){candidate.needsSenseReview=false;const saved=save();practiceQueue=[];renderLibrary();openDetail(candidate.id);if(saved)toast('Значение подтверждено. Карточка доступна в практике.');}return;}
  const open=e.target.closest('[data-open]');if(open){openDetail(open.dataset.open);return;}
  if(e.target.closest('#reveal-answer')){practiceRevealed=!practiceRevealed;renderPractice();$('#reveal-answer').focus();return;}
  const review=e.target.closest('[data-review]');if(review&&practiceRevealed){const card=practiceQueue[practicePosition];state.reviews[card.id]=scheduleReview(state.reviews[card.id],review.dataset.review);save();stopAudio();practicePosition++;practiceRevealed=false;renderPractice();return;}
  if(e.target.closest('#practice-again')){startPractice(true);return;}
  if(e.target.closest('#use-book')){setSource('book');return;}
  if(e.target.closest('#delete-book')){if(confirm('Удалить локальный набор книги? Основной набор и история повторений останутся.')){state.book=null;setSource('corpus');}return;}
  const chapter=e.target.closest('[data-chapter]');if(chapter){const source=state.source;setSource(source);filters.chapter=chapter.dataset.chapter;$('#chapter-filter').value=filters.chapter;renderLibrary();return;}
});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();show('library');$('#search').focus();}});
window.addEventListener('hashchange',()=>show(location.hash.slice(1),false));
$('#import-file').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  const result=$('#import-result');result.textContent='Читаем файл на устройстве…';result.className='quiet-label';
  try{
    if(file.size>MAX_BOOK_BYTES)throw new Error('Файл больше 5 МБ. Выбери TXT или JSON меньшего размера.');
    if(!/\.(txt|json)$/i.test(file.name))throw new Error('Поддерживаются TXT в UTF-8 и JSON с карточками.');
    const text=await file.text();let book;
    if(/\.json$/i.test(file.name)){
      const cards=validateDeck(text);const nums=[...new Set(cards.map(c=>c.chapter).filter(Boolean))].sort((a,b)=>a-b);
      book={title:file.name.replace(/\.json$/i,''),filename:file.name,wordCount:0,coverage:'user-deck',cards,chapters:nums.map(number=>({number,title:`Глава ${number}`,wordCount:0,matches:cards.filter(c=>c.chapter===number).length}))};
    }else book=parseBook(text,file.name,BOOK_CARDS);
    state.book=book;state.source='book';const persisted=save();filters={query:'',type:'all',chapter:'all',bookmarkedOnly:false};$('#search').value='';practiceQueue=[];updateChapterOptions();renderLibrary();renderBook();result.className='success-text';result.textContent=`Готово: ${book.cards.length} карточек, ${book.chapters.length} глав. ${book.coverage==='dictionary-matches'?'Это кандидаты: проверь значения в разборе карточки перед практикой. ':''}${persisted?'Набор сохранён на этом устройстве.':'Набор доступен только в текущем сеансе: хранилище недоступно.'} Исходный текст не сохраняется.`;
  }catch(error){result.className='error-text';result.textContent=error.message;}
  e.target.value='';
});
$('#export-progress').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`potter-english-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);});
$('#restore-progress').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>MAX_BOOK_BYTES)throw new Error('Резервная копия больше 5 МБ.');const restored=cleanState(JSON.parse(await file.text()));if(!confirm('Заменить текущий прогресс и локальный набор данными из резервной копии?'))return;state=restored;const persisted=save();filters={query:'',type:'all',chapter:'all',bookmarkedOnly:false};$('#search').value='';practiceQueue=[];updateChapterOptions();renderLibrary();renderBook();$('#playback-rate').value=state.rate;if(persisted)toast('Резервная копия восстановлена.');}catch(error){toast(error.message||'Не удалось прочитать резервную копию.');}finally{e.target.value='';}});
$('#download-all').addEventListener('click',async()=>{busy(true);try{if(!offline.manifest){await offline.init();manifestReady=!!offline.manifest;}requireCatalog();await offline.download(selectedAudioPaths());toast('Приложение и выбранная озвучка готовы офлайн.');}catch(error){$('#offline-status').textContent=error.name==='AbortError'?'Загрузка приостановлена. Сохранённые записи останутся; можно продолжить.':error.message;toast($('#offline-status').textContent);}finally{busy(false);}});
$('#cancel-download').addEventListener('click',()=>offline.cancel());
$('#offline-chapter').addEventListener('change',()=>refreshOffline());
$('#clear-audio').addEventListener('click',async()=>{if(!confirm($('#offline-chapter').value==='all'?'Удалить скачанную озвучку с этого устройства? Карточки и прогресс останутся.':'Удалить скачанную озвучку выбранной главы? Общие с другими главами записи тоже удалятся. Карточки и прогресс останутся.'))return;stopAudio();try{await offline.clearAudio(selectedAudioPaths());toast('Скачанная озвучка удалена.');}catch(error){toast(error.message);}});
window.addEventListener('online',()=>{if(!offlineBusy)refreshOffline();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!offlineBusy)refreshOffline();});
updateChapterOptions();renderLibrary();renderBook();show(location.hash.slice(1)||'library',false);
refreshOffline();
if(storageError)toast('Не удалось прочитать сохранённые данные. Работаем в текущем сеансе; доступна резервная копия.');
