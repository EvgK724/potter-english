import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBook, filterCards, scheduleReview, validateDeck, MAX_BOOK_BYTES, MAX_DECK_CARDS } from '../engine.js';

const card = { id: 'demo-001', phrase: 'pick up', type: 'phrasal', meaning: 'поднять; забрать', note: 'Ещё один смысл', example: 'Please pick up your bag.', translation: 'Пожалуйста, подними свою сумку.', chapter: null, source: 'demo', variants: ['picked up', 'picks up'], audioPhrase: 'audio/demo-001-phrase.mp3', audioExample: 'audio/demo-001-example.mp3' };

test('matches whole expressions, variants, whitespace and counts without copying text', () => {
  const result = parseBook('I pick\nup a bag. She picked up a pen. Not pick upper.', '/private/book.txt', [card, { ...card, id: 'duplicate' }]);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].occurrences, 2);
  assert.equal(result.cards[0].source, 'imported');
  assert.equal(result.cards[0].needsSenseReview, true);
  assert.equal(result.filename, 'book.txt');
  assert.equal(result.chapters[0].title, 'Загруженный текст');
  assert.equal(result.coverage, 'dictionary-matches');
  assert.ok(!JSON.stringify(result).includes('Not pick upper'));
  assert.ok(!('text' in result));
  assert.equal(card.chapter, null);
});

test('recognises chapter words, numbers and Roman numerals, deduplicates by chapter', () => {
  const result = parseBook('CHAPTER ONE\nFIRST TITLE\nI pick up a bag.\nCHAPTER 2 — SECOND TITLE\nWe picked up a pen.\nCHAPTER III\nTHIRD TITLE\nNothing matches here.', 'book.txt', [card]);
  assert.deepEqual(result.chapters.map(chapter => chapter.number), [1, 2, 3]);
  assert.deepEqual(result.chapters.map(chapter => chapter.matches), [1, 1, 0]);
  assert.equal(result.chapters[0].title, 'FIRST TITLE');
  assert.equal(result.chapters[1].title, 'SECOND TITLE');
  assert.equal(result.cards.length, 2);
  assert.notEqual(result.cards[0].id, result.cards[1].id);
});

test('ignores a compact repeated contents section and dotted page entries', () => {
  const text = 'CONTENTS\nCHAPTER ONE\nFIRST TITLE\nCHAPTER TWO\nSECOND TITLE\nCHAPTER ONE\nFIRST TITLE\nI pick up a bag.\nCHAPTER TWO\nSECOND TITLE\nWe picked up a pen.';
  const result = parseBook(text, 'book.txt', [card]);
  assert.equal(result.cards.length, 2);
  assert.deepEqual(result.cards.map(entry => entry.occurrences), [1, 1]);
  const dotted = parseBook('CONTENTS\nCHAPTER ONE ..... 4\nCHAPTER TWO ..... 9\nCHAPTER ONE\nFIRST TITLE\nI pick up a bag.', 'book.txt', [card]);
  assert.equal(dotted.chapters.length, 1);
});

test('regex characters are literal, Unicode boundaries avoid partial words', () => {
  const special = { ...card, phrase: 'a+b' };
  const result = parseBook('a+b aaab xa+b a+bя A+B', 'book.txt', [special]);
  assert.equal(result.cards[0].occurrences, 2);
});

test('rejects empty, binary, incorrectly decoded and oversized books', () => {
  assert.throws(() => parseBook('  ', 'x.txt', [card]), /нет текста/);
  assert.throws(() => parseBook('a\0b', 'x.txt', [card]), /UTF-8/);
  assert.throws(() => parseBook('\uFFFD'.repeat(6), 'x.txt', [card]), /UTF-8/);
  assert.throws(() => parseBook('a'.repeat(MAX_BOOK_BYTES + 1), 'x.txt', [card]), /5 МБ/);
});

test('search combines filters, normalises ё, and accepts saved IDs', () => {
  const other = { ...card, id: 'demo-002', type: 'idiom', chapter: 2, phrase: 'a piece of cake', example: 'This task is a piece of cake.' };
  assert.equal(filterCards([card, other], { query: 'ЕЩЕ PICK' }).length, 1);
  assert.deepEqual(filterCards([card, other], { type: 'idiom', chapter: '2', bookmarkedOnly: true, bookmarks: new Set(['demo-002']) }), [other]);
  assert.equal(filterCards([card], { bookmarkedOnly: true, bookmarks: {} }).length, 0);
  assert.equal(filterCards([card], { bookmarkedOnly: true, bookmarks: { 'demo-001': true } }).length, 1);
});

test('explicit review actions produce 1, 3, 7, 14 day progression and reset', () => {
  let review;
  for (const days of [1, 3, 7, 14, 14]) {
    review = scheduleReview(review, 'later', 1000);
    assert.equal(review.intervalDays, days);
    assert.equal(review.dueAt, 1000 + days * 86_400_000);
  }
  const again = scheduleReview(review, 'again', 2000);
  assert.equal(again.intervalDays, 1);
  assert.equal(again.stage, 0);
  assert.equal(again.reviews, 6);
  assert.throws(() => scheduleReview(review, 'fake'), /Неизвестное/);
});

test('JSON importer validates shape, retains literal text, and strips untrusted extra fields', () => {
  const imported = validateDeck(JSON.stringify({ cards: [{ ...card, phrase: '<img src=x onerror=alert(1)>', source: 'demo', secret: 'discard' }] }));
  assert.equal(imported[0].phrase, '<img src=x onerror=alert(1)>');
  assert.equal(imported[0].source, 'imported');
  assert.equal(imported[0].id, 'import-demo-001');
  assert.ok(!('secret' in imported[0]));
  assert.ok(!('variants' in imported[0]));
  assert.throws(() => validateDeck('{ broken'), /JSON/);
  assert.throws(() => validateDeck([]), /2000/);
  assert.throws(() => validateDeck(Array(2001).fill(card)), /2000/);
  assert.throws(() => validateDeck([{ ...card, type: 'unknown' }]), /тип/);
  assert.throws(() => validateDeck([{ ...card, chapter: '1' }]), /главы/);
  assert.throws(() => validateDeck([{ ...card, meaning: 42 }]), /meaning/);
  assert.throws(() => validateDeck([{ ...card, phrase: 'x'.repeat(181) }]), /phrase/);
  assert.throws(() => validateDeck([card, card]), /повторяются/);
});

test('JSON importer rejects remote audio, traversal, queries and executable URLs', () => {
  for (const path of ['https://example.com/a.mp3', '//evil/a.mp3', 'audio/../secret.mp3', 'audio/a.mp3?token=x', 'audio/%2e%2e/a.mp3', 'javascript:alert(1)', '/audio/a.mp3']) {
    assert.throws(() => validateDeck([{ ...card, audioPhrase: path }]), /локальный файл/);
  }
  assert.equal(validateDeck([{ ...card, audioPhrase: '', audioExample: undefined }])[0].audioExample, '');
});

test('one expression can be found in every verified source chapter',()=>{
  const cards=[{id:'a',phrase:'look up',meaning:'искать',type:'phrasal',chapter:1,chapters:[1,7,17]}];
  assert.equal(filterCards(cards,{chapter:'7'}).length,1);
  assert.equal(filterCards(cards,{chapter:'2'}).length,0);
});

test('imported chapters replace the built-in chapter footprint',()=>{
  const source=[{id:'source',phrase:'look up',type:'phrasal',meaning:'искать',chapters:[1,7,17],chapter:1}];
  const book=parseBook('CHAPTER TWO\nLook up the address.','source.txt',source);
  assert.deepEqual(book.cards[0].chapters,[2]);
  assert.equal(filterCards(book.cards,{chapter:'7'}).length,0);
});

test('a maximal custom id survives repeated JSON validation',()=>{
  const cards=[{id:'x'.repeat(100),phrase:'look up',type:'phrasal',meaning:'найти',example:'Look up the address.',translation:'Найди адрес.'}];
  const first=validateDeck(cards);const second=validateDeck(first);
  assert.equal(second[0].id,first[0].id);
});

test('TXT matching retains different senses with stable unique IDs and marks every result as a candidate', () => {
  const clothes = { ...card, id: 'clothes', phrase: 'take off', meaning: 'снять одежду', variants: [], needsSenseReview: false };
  const flight = { ...clothes, id: 'flight', meaning: 'взлететь' };
  const duplicate = { ...clothes, id: 'duplicate', phrase: ' TAKE OFF ', meaning: ' СНЯТЬ ОДЕЖДУ ' };
  const text = 'CHAPTER TWO\nPlease take off your coat. The flight will take off soon.';
  const result = parseBook(text, 'senses.txt', [clothes, flight, duplicate]);
  assert.deepEqual(result.cards.map(entry => entry.meaning), ['снять одежду', 'взлететь']);
  assert.equal(new Set(result.cards.map(entry => entry.id)).size, 2);
  assert.ok(result.cards.every(entry => entry.needsSenseReview === true));
  assert.deepEqual(result.cards.map(entry => entry.occurrences), [2, 2], 'literal occurrences are not assigned a contextual sense');
  assert.deepEqual(result.cards.map(entry => entry.chapters), [[2], [2]]);
  const reversed = parseBook(text, 'senses.txt', [flight, clothes]);
  assert.deepEqual(new Set(result.cards.map(entry => entry.id)), new Set(reversed.cards.map(entry => entry.id)));
});

test('TXT output at the deck limit round-trips, while a larger candidate set is rejected rather than truncated', () => {
  const dictionary = Array.from({ length: 125 }, (_, index) => ({ ...card, id: `source-${index}`, phrase: `candidate ${index}`, meaning: `значение ${index}`, variants: [] }));
  const chapterBody = dictionary.map(entry => entry.phrase).join('; ');
  const makeText = count => Array.from({ length: count }, (_, index) => `CHAPTER ${index + 1}\n${chapterBody}`).join('\n');
  const result = parseBook(makeText(16), 'limit.txt', dictionary);
  assert.equal(result.cards.length, MAX_DECK_CARDS);
  assert.equal(validateDeck(result.cards).length, MAX_DECK_CARDS);
  assert.throws(() => parseBook(makeText(17), 'too-many.txt', dictionary), /больше 2000 карточек-кандидатов/);
});

test('candidate flags survive backup validation; prepared JSON defaults to confirmed and rejects non-booleans', () => {
  const candidates = parseBook('Please pick up the bag.', 'candidate.txt', [card]).cards;
  const once = validateDeck(JSON.stringify({ cards: candidates }));
  const twice = validateDeck(JSON.stringify({ cards: once }));
  assert.equal(once[0].needsSenseReview, true);
  assert.equal(twice[0].needsSenseReview, true);
  assert.equal(twice[0].id, once[0].id);
  assert.equal(validateDeck([card])[0].needsSenseReview, false);
  assert.equal(validateDeck([{ ...card, needsSenseReview: false }])[0].needsSenseReview, false);
  for (const value of ['true', 'false', 0, 1, null]) {
    assert.throws(() => validateDeck([{ ...card, needsSenseReview: value }]), /needsSenseReview/);
  }
});
