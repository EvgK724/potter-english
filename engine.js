// Pure, local-only study helpers. No text is sent to a service or retained here.
export const MAX_BOOK_BYTES = 5 * 1024 * 1024;
export const MAX_DECK_CARDS = 2000;
const DAY = 86_400_000;
const TYPES = new Set(['phrasal', 'idiom', 'collocation']);
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'];
const ROMAN_NUMBERS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii'];

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/ё/g, 'е').replace(/[’‘]/g, "'").replace(/\s+/gu, ' ').trim();
}

function stableKey(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function words(text) {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

function chapterNumber(value) {
  const token = value.toLowerCase();
  if (/^\d{1,2}$/.test(token)) return Number(token);
  const word = NUMBER_WORDS.indexOf(token);
  if (word !== -1) return word + 1;
  return ROMAN_NUMBERS.indexOf(token) + 1;
}

function chapterSections(text) {
  const headings = [];
  const headingPattern = /^[ \t]*chapter[ \t]+([a-z]+|\d{1,2})(?:[ \t]*[:.\-–—][ \t]*(.{1,100})|[ \t]+(.{1,100}))?[ \t]*$/gim;
  let match;
  while ((match = headingPattern.exec(text))) {
    const number = chapterNumber(match[1]);
    if (number < 1 || number > 17) continue;
    // Dotted page leaders are a table-of-contents entry, not a chapter boundary.
    if (/\.{2,}\s*\d+\s*$/.test(match[0])) continue;
    let title = (match[2] || match[3] || '').trim();
    if (!title) {
      const nextLine = text.slice(headingPattern.lastIndex).match(/^\s*\n?([^\n]{1,100})/);
      const candidate = nextLine?.[1]?.trim() || '';
      // A short uppercase line is a conventional chapter title. Ordinary body
      // prose is never copied into the saved metadata as a title.
      if (candidate && /[A-Z]/.test(candidate) && candidate === candidate.toUpperCase() && !/^CHAPTER\b/i.test(candidate) && !/[.!?]$/.test(candidate)) title = candidate;
    }
    headings.push({ number, title: title || `Глава ${number}`, start: match.index, bodyStart: headingPattern.lastIndex });
  }
  if (!headings.length) return [{ number: 1, title: 'Загруженный текст', text }];

  // A repeated chapter 1 commonly marks the transition from contents to book.
  // Drop a preceding compact sequence only; do not discard actual long chapters.
  let first = 0;
  for (let index = 1; index < headings.length; index++) {
    if (headings[index].number !== 1) continue;
    const preceding = headings.slice(first, index);
    const isCompact = preceding.every((heading, offset) => {
      const next = headings[first + offset + 1];
      return words(text.slice(heading.bodyStart, next.start)) < 120;
    });
    if (isCompact) first = index;
  }
  const selected = headings.slice(first);
  const sections = [];
  for (let index = 0; index < selected.length; index++) {
    const heading = selected[index];
    const body = text.slice(heading.bodyStart, selected[index + 1]?.start ?? text.length);
    // Repeated running chapter headers belong to the same chapter.
    const existing = sections.find(section => section.number === heading.number);
    if (existing) existing.text += '\n' + body;
    else sections.push({ number: heading.number, title: heading.title, text: body });
  }
  return sections;
}

function expressionPattern(card) {
  const variants = [card.phrase, ...(Array.isArray(card.variants) ? card.variants : [])];
  const alternatives = [...new Set(variants.filter(item => typeof item === 'string' && item.trim() && item.length <= 180).map(normalize))];
  if (!alternatives.length) return null;
  alternatives.sort((a, b) => b.length - a.length);
  const escaped = alternatives.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
}

/** Dictionary candidates only: neither exhaustive nor contextually disambiguated. */
export function parseBook(text, filename = 'Мой текст.txt', lexicon = []) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('В файле нет текста. Выберите текстовый файл UTF-8.');
  if (new TextEncoder().encode(text).byteLength > MAX_BOOK_BYTES) throw new Error('Файл больше 5 МБ. Разделите текст на части.');
  if (text.includes('\0') || (text.match(/\uFFFD/g)?.length || 0) > 5) throw new Error('Не удалось прочитать текст. Сохраните книгу как TXT в кодировке UTF-8.');
  if (!Array.isArray(lexicon) || lexicon.length > MAX_DECK_CARDS) throw new Error('Некорректный учебный словарь.');
  const cleanText = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const safeFilename = String(filename).split(/[\\/]/).pop().slice(0, 160) || 'Мой текст.txt';
  const chapters = [];
  const cards = [];
  const dictionary = [];
  const known = new Set();
  for (const card of lexicon) {
    if (!card || typeof card.phrase !== 'string' || !card.phrase.trim()) continue;
    const key = normalize(card.phrase) + '|' + normalize(card.meaning);
    if (known.has(key)) continue;
    const pattern = expressionPattern(card);
    if (pattern) dictionary.push({ card, key, pattern });
    known.add(key);
  }
  for (const section of chapterSections(cleanText)) {
    const normalizedText = normalize(section.text);
    let matches = 0;
    for (const { card, key, pattern } of dictionary) {
      pattern.lastIndex = 0;
      const occurrences = [...normalizedText.matchAll(pattern)].length;
      if (!occurrences) continue;
      if (cards.length >= MAX_DECK_CARDS) {
        throw new Error('Найдено больше 2000 карточек-кандидатов. Разделите TXT на части и повторите импорт.');
      }
      matches++;
      cards.push({ ...card, id: `book-${stableKey(key)}-ch${section.number}`, chapter: section.number, chapters: [section.number], source: 'imported', occurrences, needsSenseReview: true });
    }
    chapters.push({ id: `chapter-${String(section.number).padStart(2, '0')}`, number: section.number, title: section.title, wordCount: words(section.text), matches });
  }
  return {
    title: safeFilename.replace(/\.txt$/i, ''),
    filename: safeFilename,
    importedAt: new Date().toISOString(),
    wordCount: words(cleanText),
    chapters,
    cards,
    coverage: 'dictionary-matches'
  };
}

export function filterCards(cards, { query = '', type = 'all', chapter = 'all', bookmarkedOnly = false, bookmarks = [] } = {}) {
  const terms = normalize(query).split(' ').filter(Boolean);
  const saved = bookmarks instanceof Set ? bookmarks : new Set(Array.isArray(bookmarks) ? bookmarks : Object.keys(bookmarks || {}).filter(key => bookmarks[key]));
  return cards.filter(card => {
    if (type && type !== 'all' && card.type !== type) return false;
    if (chapter !== 'all' && chapter !== '' && chapter !== null && chapter !== undefined && !(Array.isArray(card.chapters) ? card.chapters.includes(Number(chapter)) : String(card.chapter) === String(chapter))) return false;
    if (bookmarkedOnly && !saved.has(card.id)) return false;
    const searchable = normalize([card.phrase, ...(card.aliases || []), card.meaning, card.example, card.translation, card.note].join(' '));
    return terms.every(term => searchable.includes(term));
  });
}

/** The interval changes only after an explicit review action. */
export function scheduleReview(previous, choice, now = Date.now()) {
  if (choice !== 'again' && choice !== 'later') throw new Error('Неизвестное действие повторения.');
  if (!Number.isFinite(now) || now < 0) throw new Error('Некорректная дата повторения.');
  const priorStage = Number.isInteger(previous?.stage) && previous.stage >= 0 && previous.stage <= 3 ? previous.stage : -1;
  const stage = choice === 'again' ? 0 : Math.min(priorStage + 1, 3);
  const intervalDays = [1, 3, 7, 14][stage];
  const reviews = Number.isSafeInteger(previous?.reviews) && previous.reviews >= 0 ? previous.reviews + 1 : 1;
  return { stage, intervalDays, reviewedAt: now, dueAt: now + intervalDays * DAY, reviews, lastChoice: choice };
}

function validatedString(card, name, limit, required = true) {
  const value = card[name];
  if (!required && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error(`Поле «${name}» отсутствует или слишком длинное.`);
  return value.trim();
}

function validatedAudio(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 180 || !/^audio\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.mp3$/.test(value)) throw new Error('Аудио должно ссылаться на локальный файл audio/имя.mp3.');
  return value;
}

/** Accept a JSON string, an array, or {cards: []}; keep only known fields. */
export function validateDeck(input) {
  let parsed = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_BOOK_BYTES) throw new Error('Набор больше 5 МБ.');
    try { parsed = JSON.parse(input); } catch { throw new Error('Не удалось прочитать JSON набора.'); }
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(items) || !items.length || items.length > MAX_DECK_CARDS) throw new Error('Набор должен содержать от 1 до 2000 карточек.');
  const ids = new Set();
  return items.map((card, index) => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error(`Карточка ${index + 1} имеет неверный формат.`);
    if (!TYPES.has(card.type)) throw new Error(`Неизвестный тип карточки ${index + 1}.`);
    const phrase = validatedString(card, 'phrase', 180);
    const meaning = validatedString(card, 'meaning', 600);
    const example = validatedString(card, 'example', 1200);
    const translation = validatedString(card, 'translation', 1200);
    const note = validatedString(card, 'note', 1000, false);
    const chapter = card.chapter === undefined || card.chapter === null ? null : card.chapter;
    if (chapter !== null && (!Number.isInteger(chapter) || chapter < 1 || chapter > 17)) throw new Error('Номер главы должен быть от 1 до 17.');
    if (card.needsSenseReview !== undefined && typeof card.needsSenseReview !== 'boolean') throw new Error('Поле needsSenseReview должно быть true или false.');
    let id = `import-${stableKey(normalize(phrase) + '|' + (chapter ?? 'none'))}`;
    if (card.id !== undefined) {
      if (typeof card.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(card.id.replace(/^import-/, ''))) throw new Error('Некорректный идентификатор карточки.');
      id = `import-${card.id.replace(/^import-/, '')}`;
    }
    if (ids.has(id)) throw new Error('В наборе повторяются идентификаторы или выражения одной главы.');
    ids.add(id);
    return { id, phrase, type: card.type, meaning, note, example, translation, chapter, source: 'imported', needsSenseReview: card.needsSenseReview === true, audioPhrase: validatedAudio(card.audioPhrase), audioExample: validatedAudio(card.audioExample) };
  });
}
