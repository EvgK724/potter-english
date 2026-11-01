import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_CARDS, BOOK_META } from '../data.js';

test('the study corpus covers each source chapter with validated public fields',()=>{
  assert.equal(BOOK_META.chapters.length,17);
  const ids=new Set(),audio=new Map();
  for(const card of BOOK_CARDS){
    assert.ok(!ids.has(card.id),`Duplicate ${card.id}`);ids.add(card.id);
    assert.ok(['phrasal','idiom','collocation'].includes(card.type));
    assert.equal(card.source,'book');assert.ok(!('evidence' in card));
    for(const field of ['phrase','meaning','note','example','translation']) assert.ok(typeof card[field]==='string'&&card[field].trim().length>1,`${card.id}: ${field}`);
    assert.match(card.meaning,/[а-яё]/i);assert.match(card.translation,/[а-яё]/i);
    assert.ok(card.chapters.length>0&&card.chapters.every(n=>Number.isInteger(n)&&n>=1&&n<=17));
    for(const [field,text] of [['audioPhrase','phrase'],['audioExample','example']]){
      assert.match(card[field],/^audio\/[a-z0-9_-]+\.mp3$/i);
      if(audio.has(card[field]))assert.equal(audio.get(card[field]),card[text],'Shared audio text mismatch');
      audio.set(card[field],card[text]);
    }
  }
  for(let n=1;n<=17;n++)assert.ok(BOOK_CARDS.some(c=>c.chapters.includes(n)),`No cards in chapter ${n}`);
});
