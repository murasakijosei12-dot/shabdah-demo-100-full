/* ================================================================
   MOBILE LOOKUP ENGINE
   Provides dictionary lookup for the PWA without requiring the
   full kuromoji tokenizer. Uses lazy-loaded dictionary with
   IndexedDB caching for offline support.
   ================================================================ */

// ── Configuration ───────────────────────────────────────────────
const DICT_CONFIG = {
  // Path to the full JMdict dictionary (57MB, ~13MB over the wire once the
  // host gzips it). Relative, not absolute: hardcoding the production origin
  // meant the lookup could never be exercised on localhost or a Netlify
  // deploy preview -- it either hit production's copy or, once that copy
  // turned out not to exist, simply 404'd everywhere with no way to tell
  // whether the engine itself worked.
  dictionaryUrl: 'data/dictionary.json',
  // IndexedDB database name and version
  dbName: 'ptw-dictionary',
  dbVersion: 1,
  // Store name for the dictionary
  storeName: 'dictionary',
  // Maximum entries to show in results
  maxResults: 20,
};

// ── State ───────────────────────────────────────────────────────
let ptwMobileDictionary = null;
let ptwDictionaryLoading = null;
let ptwDictionaryStatus = 'not-loaded'; // 'not-loaded' | 'loading' | 'loaded' | 'error'

// ── IndexedDB Helpers ───────────────────────────────────────────
function openDictDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DICT_CONFIG.dbName, DICT_CONFIG.dbVersion);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(DICT_CONFIG.storeName)) {
        db.createObjectStore(DICT_CONFIG.storeName);
      }
    };
  });
}

async function getCachedDictionary() {
  try {
    const db = await openDictDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DICT_CONFIG.storeName, 'readonly');
      const store = tx.objectStore(DICT_CONFIG.storeName);
      const request = store.get('full-dictionary');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  } catch (e) {
    console.warn('IndexedDB not available:', e);
    return null;
  }
}

async function cacheDictionary(dictionary) {
  try {
    const db = await openDictDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DICT_CONFIG.storeName, 'readwrite');
      const store = tx.objectStore(DICT_CONFIG.storeName);
      const request = store.put(dictionary, 'full-dictionary');

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (e) {
    console.warn('Failed to cache dictionary:', e);
  }
}

// ── Dictionary Loading ──────────────────────────────────────────
async function loadMobileDictionary(progressCallback) {
  // Already loaded
  if (ptwMobileDictionary) {
    return ptwMobileDictionary;
  }

  // Already loading - wait for it
  if (ptwDictionaryLoading) {
    return ptwDictionaryLoading;
  }

  ptwDictionaryStatus = 'loading';

  ptwDictionaryLoading = (async () => {
    try {
      // Try IndexedDB cache first
      if (progressCallback) progressCallback('Checking cache...');
      const cached = await getCachedDictionary();

      if (cached) {
        if (progressCallback) progressCallback('Loading from cache...');
        ptwMobileDictionary = cached;
        ptwDictionaryStatus = 'loaded';
        return ptwMobileDictionary;
      }

      // Download from network
      if (progressCallback) progressCallback('Downloading dictionary (8MB)...');

      const response = await fetch(DICT_CONFIG.dictionaryUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Track download progress if possible
      const contentLength = response.headers.get('content-length');
      if (contentLength && progressCallback) {
        const total = parseInt(contentLength, 10);
        const reader = response.body.getReader();
        let received = 0;
        const chunks = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const pct = Math.round((received / total) * 100);
          progressCallback(`Downloading... ${pct}%`);
        }

        // Combine chunks and parse
        const blob = new Blob(chunks);
        const text = await blob.text();
        ptwMobileDictionary = JSON.parse(text);
      } else {
        // No content-length, just fetch directly
        if (progressCallback) progressCallback('Downloading dictionary...');
        ptwMobileDictionary = await response.json();
      }

      // Cache for offline use
      if (progressCallback) progressCallback('Caching for offline...');
      await cacheDictionary(ptwMobileDictionary);

      ptwDictionaryStatus = 'loaded';
      if (progressCallback) progressCallback('Ready');

      return ptwMobileDictionary;
    } catch (e) {
      console.error('Failed to load dictionary:', e);
      ptwDictionaryStatus = 'error';
      ptwDictionaryLoading = null;
      throw e;
    }
  })();

  return ptwDictionaryLoading;
}

function getDictionaryStatus() {
  return ptwDictionaryStatus;
}

function isDictionaryLoaded() {
  return ptwMobileDictionary !== null;
}

// ── Kana/Kanji Conversion ───────────────────────────────────────
// Hiragana to Katakana conversion
function hiraganaToKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

// Katakana to Hiragana conversion
function katakanaToHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// Romaji to Hiragana conversion (basic)
const ROMAJI_MAP = {
  'a': 'あ', 'i': 'い', 'u': 'う', 'e': 'え', 'o': 'お',
  'ka': 'か', 'ki': 'き', 'ku': 'く', 'ke': 'け', 'ko': 'こ',
  'sa': 'さ', 'shi': 'し', 'si': 'し', 'su': 'す', 'se': 'せ', 'so': 'そ',
  'ta': 'た', 'chi': 'ち', 'ti': 'ち', 'tsu': 'つ', 'tu': 'つ', 'te': 'て', 'to': 'と',
  'na': 'な', 'ni': 'に', 'nu': 'ぬ', 'ne': 'ね', 'no': 'の',
  'ha': 'は', 'hi': 'ひ', 'fu': 'ふ', 'hu': 'ふ', 'he': 'へ', 'ho': 'ほ',
  'ma': 'ま', 'mi': 'み', 'mu': 'む', 'me': 'め', 'mo': 'も',
  'ya': 'や', 'yu': 'ゆ', 'yo': 'よ',
  'ra': 'ら', 'ri': 'り', 'ru': 'る', 're': 'れ', 'ro': 'ろ',
  'wa': 'わ', 'wo': 'を', 'n': 'ん', 'nn': 'ん',
  'ga': 'が', 'gi': 'ぎ', 'gu': 'ぐ', 'ge': 'げ', 'go': 'ご',
  'za': 'ざ', 'ji': 'じ', 'zi': 'じ', 'zu': 'ず', 'ze': 'ぜ', 'zo': 'ぞ',
  'da': 'だ', 'di': 'ぢ', 'du': 'づ', 'de': 'で', 'do': 'ど',
  'ba': 'ば', 'bi': 'び', 'bu': 'ぶ', 'be': 'べ', 'bo': 'ぼ',
  'pa': 'ぱ', 'pi': 'ぴ', 'pu': 'ぷ', 'pe': 'ぺ', 'po': 'ぽ',
  'kya': 'きゃ', 'kyu': 'きゅ', 'kyo': 'きょ',
  'sha': 'しゃ', 'shu': 'しゅ', 'sho': 'しょ', 'sya': 'しゃ', 'syu': 'しゅ', 'syo': 'しょ',
  'cha': 'ちゃ', 'chu': 'ちゅ', 'cho': 'ちょ', 'tya': 'ちゃ', 'tyu': 'ちゅ', 'tyo': 'ちょ',
  'nya': 'にゃ', 'nyu': 'にゅ', 'nyo': 'にょ',
  'hya': 'ひゃ', 'hyu': 'ひゅ', 'hyo': 'ひょ',
  'mya': 'みゃ', 'myu': 'みゅ', 'myo': 'みょ',
  'rya': 'りゃ', 'ryu': 'りゅ', 'ryo': 'りょ',
  'gya': 'ぎゃ', 'gyu': 'ぎゅ', 'gyo': 'ぎょ',
  'ja': 'じゃ', 'ju': 'じゅ', 'jo': 'じょ', 'jya': 'じゃ', 'jyu': 'じゅ', 'jyo': 'じょ',
  'bya': 'びゃ', 'byu': 'びゅ', 'byo': 'びょ',
  'pya': 'ぴゃ', 'pyu': 'ぴゅ', 'pyo': 'ぴょ',
  // Double consonants
  'kk': 'っk', 'ss': 'っs', 'tt': 'っt', 'pp': 'っp', 'cc': 'っc',
};

function romajiToHiragana(romaji) {
  let result = '';
  let i = 0;
  const lower = romaji.toLowerCase();

  while (i < lower.length) {
    // Try 3-char, then 2-char, then 1-char matches
    let matched = false;
    for (let len = 3; len >= 1; len--) {
      const chunk = lower.substring(i, i + len);
      if (ROMAJI_MAP[chunk]) {
        result += ROMAJI_MAP[chunk];
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += lower[i];
      i++;
    }
  }

  // Handle remaining double consonant markers
  result = result.replace(/っ([kstp])/g, (m, c) => 'っ');

  return result;
}

// ── Basic Deinflection ──────────────────────────────────────────
// Simple verb/adjective deinflection without kuromoji
const DEINFLECT_RULES = [
  // Verb endings (ichidan/godan)
  { suffix: 'ます', replace: 'る', type: 'polite' },
  { suffix: 'ました', replace: 'た', type: 'polite-past' },
  { suffix: 'ません', replace: 'ない', type: 'polite-neg' },
  { suffix: 'て', replace: 'る', type: 'te-form' },
  { suffix: 'た', replace: 'る', type: 'past' },
  { suffix: 'ない', replace: 'る', type: 'negative' },
  { suffix: 'られる', replace: 'る', type: 'potential' },
  { suffix: 'させる', replace: 'る', type: 'causative' },
  { suffix: 'れる', replace: 'る', type: 'passive' },
  // Godan verb endings
  { suffix: 'った', replace: 'う', type: 'past-u' },
  { suffix: 'った', replace: 'つ', type: 'past-tsu' },
  { suffix: 'った', replace: 'る', type: 'past-ru' },
  { suffix: 'いた', replace: 'く', type: 'past-ku' },
  { suffix: 'いだ', replace: 'ぐ', type: 'past-gu' },
  { suffix: 'んだ', replace: 'む', type: 'past-mu' },
  { suffix: 'んだ', replace: 'ぬ', type: 'past-nu' },
  { suffix: 'んだ', replace: 'ぶ', type: 'past-bu' },
  { suffix: 'した', replace: 'す', type: 'past-su' },
  // I-adjective
  { suffix: 'くない', replace: 'い', type: 'adj-neg' },
  { suffix: 'かった', replace: 'い', type: 'adj-past' },
  { suffix: 'くて', replace: 'い', type: 'adj-te' },
  // Na-adjective / noun + copula
  { suffix: 'だった', replace: '', type: 'copula-past' },
  { suffix: 'じゃない', replace: '', type: 'copula-neg' },
  { suffix: 'です', replace: '', type: 'copula-polite' },
];

// Polite forms attach to the ren'youkei stem, which for a godan verb ends in
// an i-row kana standing in for the dictionary form's u-row one.
const POLITE_SUFFIXES = ['ませんでした', 'ましょう', 'ません', 'ました', 'まして', 'ます'];
const I_ROW_TO_U_ROW = {
  'き': 'く', 'ぎ': 'ぐ', 'し': 'す', 'ち': 'つ', 'に': 'ぬ',
  'ひ': 'ふ', 'び': 'ぶ', 'み': 'む', 'り': 'る', 'い': 'う',
};

function deinflectOnce(word) {
  const out = [];

  // Polite forms first: the generic table below turns 食べました into 食べた
  // (still inflected) and 書きました into 書きた (not a word at all), because
  // 'ました' was listed as if it were a plain past-tense ending. Handling the
  // stem directly gets both verb classes right in one step.
  for (const suffix of POLITE_SUFFIXES) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    if (!stem) continue;
    out.push(stem + 'る');                       // ichidan: 食べ -> 食べる
    // The irregulars go ahead of the godan mapping below: for します the
    // generic i-row rule produces す ("be; is"), a real entry that would
    // otherwise win over する purely by being pushed first.
    if (stem.endsWith('し')) out.push(stem.slice(0, -1) + 'する');  // し -> する
    if (stem.endsWith('き')) out.push(stem.slice(0, -1) + 'くる');  // き -> 来る
    const last = stem.slice(-1);
    if (I_ROW_TO_U_ROW[last]) {
      out.push(stem.slice(0, -1) + I_ROW_TO_U_ROW[last]);   // godan: 書き -> 書く
    }
    break;
  }

  for (const rule of DEINFLECT_RULES) {
    if (word.endsWith(rule.suffix)) {
      const stem = word.slice(0, -rule.suffix.length);
      if (stem.length > 0) {
        out.push(stem + rule.replace);
        // Also try just the stem for する verbs
        if (rule.replace === 'る' && stem.endsWith('す')) {
          out.push(stem + 'る');
        }
      }
    }
  }

  // Handle する verbs
  if (word.endsWith('した')) {
    out.push(word.slice(0, -2) + 'する');
  } else if (word.endsWith('して')) {
    out.push(word.slice(0, -2) + 'する');
  } else if (word.endsWith('しない')) {
    out.push(word.slice(0, -3) + 'する');
  }

  return out;
}

// Applied repeatedly, because real forms stack: 食べさせられなかった is a
// causative on a passive on a negative on a past. A single pass could only
// ever undo the outermost one, so anything beyond the simplest conjugation
// reached the dictionary still inflected and missed. Depth is bounded -- the
// rules can cycle (る -> た -> る), and every extra round multiplies the
// candidate set for no further gain.
function deinflect(word) {
  const seen = new Set([word]);
  let frontier = [word];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const w of frontier) {
      for (const cand of deinflectOnce(w)) {
        if (!cand || seen.has(cand)) continue;
        seen.add(cand);
        next.push(cand);
      }
    }
    frontier = next;
  }
  return [...seen];
}

// ── Dictionary Lookup ─────────────────────────────────────────
// Exact-match lookup only: query (and its hiragana/katakana/romaji/
// deinflected variants) must equal a real dictionary headword. No
// prefix-fallback here -- this is what sentence segmentation uses to test
// "is this exact candidate substring a real word", where a loose prefix
// match would make the tokenizer swallow extra characters that aren't
// actually part of the word.
function exactLookupInDictionary(query) {
  if (!ptwMobileDictionary || !query) {
    return [];
  }

  const results = [];
  const seen = new Set();

  // Generate search variants
  const variants = [query];

  // Add hiragana/katakana variants
  if (/[\u3041-\u3096]/.test(query)) {
    variants.push(hiraganaToKatakana(query));
  }
  if (/[\u30A1-\u30F6]/.test(query)) {
    variants.push(katakanaToHiragana(query));
  }

  // Add romaji conversion if it looks like romaji
  if (/^[a-zA-Z]+$/.test(query)) {
    const hiragana = romajiToHiragana(query);
    if (hiragana !== query.toLowerCase()) {
      variants.push(hiragana);
      variants.push(hiraganaToKatakana(hiragana));
    }
  }

  // Add deinflected forms
  const deinflected = [];
  for (const v of variants) {
    deinflected.push(...deinflect(v));
  }
  variants.push(...deinflected);

  // Search dictionary
  for (const variant of variants) {
    if (ptwMobileDictionary[variant] && !seen.has(variant)) {
      seen.add(variant);
      const entries = ptwMobileDictionary[variant];
      for (const entry of entries) {
        results.push({
          headword: variant,
          reading: entry.reading || variant,
          gloss: entry.gloss || [],
          pos: entry.pos || '',
          entry: entry,
        });
      }
    }
  }

  return results;
}

function lookupInDictionary(query) {
  if (!ptwMobileDictionary) {
    return [];
  }

  const results = exactLookupInDictionary(query);
  if (results.length) {
    return results.slice(0, DICT_CONFIG.maxResults);
  }

  // Longest-prefix match, the standard fallback for Japanese popup
  // dictionaries: a tapped run is usually a real word followed by something
  // that isn't part of it -- a particle (公園 + で), okurigana already tried
  // above, or the start of the next word -- so the answer is the longest
  // dictionary entry the query STARTS with.
  //
  // This replaced a scan of all 432,572 keys accepting any key where
  // `key.includes(query) || query.includes(key)`. Because that walked the
  // dictionary in insertion order and took whatever matched first, 昨日は
  // answered with 日 ("day"), 友達と with と ("if; when"), and 公園で with 公
  // ("government"). Every one of those is a substring of the query, so the
  // old test was satisfied and the right entry -- 昨日, 友達, 公園, all of
  // them real JMdict headwords -- was never reached. Results were tagged
  // isPartialMatch, but callers read results[0] and showed it as the answer.
  //
  // NOTE: this still only recovers ONE word (the longest prefix) out of a
  // multi-word query -- it exists for the single-word popup/search box, not
  // for whole sentences. Whole-sentence input is tokenized word-by-word
  // BEFORE reaching this function; see segmentSentence() in script.js, which
  // calls exactLookupInDictionary() per token in a loop that keeps scanning
  // after each match instead of stopping at the first one.
  if (query.length >= 2) {
    const seen = new Set(results.map(r => r.headword));
    for (let len = query.length - 1; len >= 1; len--) {
      const prefix = query.slice(0, len);
      for (const variant of [prefix, ...deinflect(prefix)]) {
        const entries = ptwMobileDictionary[variant];
        if (!entries || seen.has(variant)) continue;
        seen.add(variant);
        for (const entry of entries) {
          results.push({
            headword: variant,
            reading: entry.reading || variant,
            gloss: entry.gloss || [],
            pos: entry.pos || '',
            entry: entry,
            isPartialMatch: true,
            matchedLength: len,
          });
        }
      }
      if (results.length) break;   // longest wins; stop at the first length that hits
    }
  }

  return results.slice(0, DICT_CONFIG.maxResults);
}

// ── Text Segmentation (without kuromoji) ────────────────────────
// Simple regex-based word boundary detection for Japanese
function segmentJapaneseText(text) {
  const segments = [];
  let current = '';
  let currentType = null;

  for (const char of text) {
    const type = getCharType(char);

    if (type !== currentType && current) {
      segments.push({ text: current, type: currentType });
      current = '';
    }

    current += char;
    currentType = type;
  }

  if (current) {
    segments.push({ text: current, type: currentType });
  }

  return segments;
}

function getCharType(char) {
  const code = char.charCodeAt(0);

  // Hiragana
  if (code >= 0x3041 && code <= 0x3096) return 'hiragana';
  // Katakana
  if (code >= 0x30A1 && code <= 0x30F6) return 'katakana';
  // Kanji
  if (code >= 0x4E00 && code <= 0x9FFF) return 'kanji';
  // CJK Extension
  if (code >= 0x3400 && code <= 0x4DBF) return 'kanji';
  // Latin
  if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) return 'latin';
  // Numbers
  if (code >= 0x30 && code <= 0x39) return 'number';
  // Punctuation/space
  return 'other';
}

// Find word at a given character position in text
function findWordAtPosition(text, position) {
  const segments = segmentJapaneseText(text);
  let currentPos = 0;

  for (const segment of segments) {
    const segEnd = currentPos + segment.text.length;

    if (position >= currentPos && position < segEnd) {
      // Found the segment containing the position
      if (segment.type === 'other') {
        return null; // Punctuation/space
      }

      // For kanji/hiragana/katakana, try to find the longest match
      // by looking at surrounding segments too
      const idx = segments.indexOf(segment);
      let word = segment.text;

      // Try combining with next segment(s) for compound words
      for (let i = idx + 1; i < Math.min(idx + 3, segments.length); i++) {
        if (segments[i].type === 'other') break;
        const combined = word + segments[i].text;
        // Check if combined form exists in dictionary
        if (ptwMobileDictionary && ptwMobileDictionary[combined]) {
          word = combined;
        }
      }

      return {
        word: word,
        start: currentPos,
        end: currentPos + word.length,
        type: segment.type,
      };
    }

    currentPos = segEnd;
  }

  return null;
}

// ── Public API ──────────────────────────────────────────────────
window.ptwMobileLookup = {
  // Load the dictionary (lazy, cached in IndexedDB)
  load: loadMobileDictionary,

  // Check if dictionary is loaded
  isLoaded: isDictionaryLoaded,

  // Get loading status
  getStatus: getDictionaryStatus,

  // Look up a word in the dictionary
  lookup: lookupInDictionary,

  // Exact-match-only lookup (no prefix fallback) -- used by sentence
  // segmentation to test whether a candidate substring is a real word.
  lookupExact: exactLookupInDictionary,

  // Find word at position in text
  findWordAt: findWordAtPosition,

  // Segment Japanese text
  segment: segmentJapaneseText,

  // Convert romaji to hiragana
  romajiToHiragana: romajiToHiragana,

  // Deinflect a word
  deinflect: deinflect,
};
