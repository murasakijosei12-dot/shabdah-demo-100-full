/* ================================================================
   PICTURE THE WORDS — Trilingual Concept Cards
   script.js v3.0
   Architecture: 15 PTW categories, cards.json (3 directions/concept),
   cross-language search_index.json, pre-rendered card images + audio.
   ================================================================ */

// ── State ──────────────────────────────────────────────────────
let CARDS = [];
let CATEGORIES = [];
let SEARCH_INDEX = {};
let GRAMMAR = [];

// Grammar is hidden from the live site for now (see updateGrammarEntryPoint) but its
// categories.json entry stays so grammar.json/the overlay keep working if re-enabled later.
// Every topic-listing/count surface should use this, not raw CATEGORIES, so Grammar doesn't
// appear as a 17th tile or inflate the topic count.
function visibleCategories() {
  return CATEGORIES.filter(cat => cat.id !== 'grammar');
}
let starred = new Set();
let currentCategoryId = null;
let currentConceptId = null;
let currentDirection = 'JA_EN';

// Professions & Specialisations State
let PROFESSIONS_DATA = null;
let PROFESSIONS_CONCEPTS_SET = new Set();
let PROFESSIONS_SUBCAT_MAP = {};
let PROFESSIONS_CAT_LIST = [];
let currentProfessionSubcat = 'all';

// Site-wide preferences (persisted): which direction opens by default,
// and which language the word labels under thumbnails are shown in.
//
// Validated against the pairs the product actually ships today: a stored
// value can go stale when a pair is discontinued (EN_JA was removed
// 2026-09-16 -- see pricing-config.js) and nothing migrates accounts that
// had it active. An unrecognised value here left the "Studying" selector
// blank and crashed the Review screen outright (concept.directions has no
// entry for a retired pair), so it's reset to the default instead of
// trusted as-is.
const PTW_VALID_DIRECTIONS = ['JA_EN', 'HI_EN', 'FR_EN'];
let prefDirection = localStorage.getItem('ptw_pref_direction') || 'JA_EN';
if (!PTW_VALID_DIRECTIONS.includes(prefDirection)) {
  prefDirection = 'JA_EN';
  localStorage.setItem('ptw_pref_direction', prefDirection);
}
let prefLang = localStorage.getItem('ptw_pref_lang') || 'en';

// Found 2026-10-03 (verified live): currentDirection (line 16) was hardcoded
// to 'JA_EN' and never read the stored preference above -- it only ever
// changed when a card was actually opened (firstAvailableDirection()) or its
// direction tab clicked (switchDirection()). A returning French- or Hindi-
// track learner who reloaded the site and used Quick Lookup (the homepage
// button, or the in-app "Lookup" toolbar button) BEFORE opening any card in
// that session had their query misrouted by detectScript() (used by
// quickLookupSearch() below), which only sends Latin-script text to the
// French general dictionary when currentDirection already starts with
// "FR" -- otherwise it falls through to the Japanese/English path and a
// real French word (e.g. "ornithorynque") came back "No matches found" even
// though the 57k-word French dictionary has it. Reproduced directly: the
// same search failed from a fresh homepage load and succeeded once a French
// card had been opened first. Hindi is unaffected (Devanagari is detected by
// script, not by direction). Initializing from the already-validated stored
// preference here, before anything else can read currentDirection, fixes it
// at the source rather than patching every call site.
currentDirection = prefDirection;

function setPrefDirection(v) {
  prefDirection = v;
  // Keep currentDirection in sync too -- detectScript()'s French-dictionary
  // branch (used by Quick Lookup) only fires when currentDirection already
  // starts with "FR" (see the fix note above, line 36). Without this, the
  // same misrouting bug reappears the moment a user switches direction via
  // the "Studying" dropdown mid-session, instead of only at page load.
  currentDirection = v;
  localStorage.setItem('ptw_pref_direction', v);
  renderConceptGrid();   // sort order depends on direction
  renderAllowanceBadge();
}

// Visible "X/200" indicator for the shared free allowance (see
// entitlement.js) -- lives in the global topbar next to the direction
// selector, not just the Profile tab, so it's visible while browsing.
// Called from setPrefDirection (pair change) and from entitlement.js's
// loadUnlockedItems/ensureUnlocked whenever the underlying count changes.
function renderAllowanceBadge() {
  const el = document.getElementById('pref-allowance-badge');
  if (!el || typeof unlockedCountForPair !== 'function') return;
  el.classList.remove('hidden');
  // A licensed pair has no cap left to count against -- show a plain
  // "Unlocked" state, never a number, once purchased.
  if (typeof isPairLicensedCached === 'function' && isPairLicensedCached(prefDirection)) {
    el.textContent = '✓ Unlocked';
    el.onclick = null;
    el.style.cursor = 'default';
    return;
  }
  const n = unlockedCountForPair(prefDirection);
  el.onclick = () => { location.href = 'pricing.html'; };
  el.style.cursor = 'pointer';
  if (n >= 200) {
    el.textContent = '200/200 · Unlock all →';
  } else {
    el.textContent = `${n}/200`;
  }
}
function setPrefLang(v) {
  prefLang = v;
  localStorage.setItem('ptw_pref_lang', v);
  renderConceptGrid(); // refresh visible labels immediately
}
function labelFor(concept) {
  return (concept.labels && concept.labels[prefLang]) || concept.english;
}

// ── Boot ───────────────────────────────────────────────────────
async function boot() {
  renderCatSkeleton();
  // These three fetches previously had no error handling at all: if any
  // one of them failed (a real possibility offline -- especially on a
  // first load before the service worker has cached everything, or if a
  // large file's install-time cache attempt silently failed), the
  // Promise.all rejected unhandled and boot() stopped dead. Everything
  // after this point -- buildHomepage, buildSidebar, showPage -- never
  // ran, leaving the skeleton grid on screen forever with no explanation
  // and no way to recover short of a hard reload once back online.
  let cardsRes, catRes, searchRes;
  try {
    [cardsRes, catRes, searchRes] = await Promise.all([
      fetch('data/cards.json'),
      fetch('data/categories.json'),
      fetch('data/search_index.json'),
    ]);
    if (!cardsRes.ok || !catRes.ok || !searchRes.ok) throw new Error('core data fetch not ok');
    CARDS = await cardsRes.json();
    CATEGORIES = await catRes.json();
    SEARCH_INDEX = await searchRes.json();
    // Must run AFTER the CARDS assignment above, not just from
    // auth.js's own DOMContentLoaded handler (updateAuthNav) -- that
    // listener is registered first (auth.js loads before script.js) and
    // would otherwise merge custom cards into CARDS only to have this
    // very assignment wipe them out moments later. Safe to not await:
    // a custom card merged in a beat after the initial render just
    // means "My Created Cards" and any tile it's starred/categorized
    // into fill in slightly after first paint, same as the other
    // fire-and-forget loads below.
    if (typeof loadCustomCardsIntoCards === 'function') loadCustomCardsIntoCards().catch(() => {});
    // 46 KB, and the card needs it synchronously when it renders. Kicked off
    // here rather than awaited, so a failure can never block the app starting
    // -- renderPhrases simply returns nothing until it lands.
    loadPhrases();
    loadJaCollocations();
    loadEnCollocations();
    loadFrCollocations();
    loadHiCollocations();
    loadInflectionExamples('ja');
    loadInflectionExamples('hi');
    loadInflectionExamples('fr');
  } catch (e) {
    const grid = document.getElementById('home-cat-grid');
    if (grid) {
      grid.innerHTML = `<p class="notes-empty" style="grid-column:1/-1;">
        You appear to be offline and this device hasn't fully cached the app yet.
        Open Shabdah once while connected, then it will keep working offline.
        <br><button class="btn-primary" style="margin-top:10px;" onclick="location.reload()">Try again</button>
      </p>`;
    }
    return;
  }
  loadStars();
  try {
    const enr = await fetch('data/card_enrichment.json').then(r => r.json());
    CARD_ENRICHMENT_LABELS = enr.labels || {};
  } catch (e) { /* labels are cosmetic; the cards still work */ }
  // Grammar is a separate, optional data file -- not yet shipped as part
  // of the core cards.json -- so its absence must not block the rest of
  // boot() the way a missing cards.json/categories.json does.
  try {
    GRAMMAR = await fetch('data/grammar.json').then(r => r.json());
  } catch (e) { GRAMMAR = []; }
  try {
    const profRes = await fetch('data/profession_categories.json');
    if (profRes.ok) {
      PROFESSIONS_DATA = await profRes.json();
      initProfessionsData();
    }
  } catch (e) { PROFESSIONS_DATA = null; }
  buildHomepage();
  updateGrammarEntryPoint();
  updateProfessionsEntryPoint();
  buildSidebar();
  populateDecoCards();
  if (typeof renderReviewsSection === 'function') renderReviewsSection();
  const dirSel = document.getElementById('pref-direction');
  const langSel = document.getElementById('pref-lang');
  if (dirSel) dirSel.value = prefDirection;
  if (langSel) langSel.value = prefLang;
  // openFromHash() must be checked BEFORE showPage('home') runs, not after.
  // showPage('home') was unconditional here, so a shared #/word/ link
  // visitor's browser rendered the homepage first and only swapped to the
  // actual card a beat later -- a visible flash that's exactly what "copy
  // link shows the homepage instead of the card" describes.
  if (!openFromHash()) {
    showPage('home');
    handleLaunchParams();
  }
  if (typeof renderUsageStats === 'function') renderUsageStats();
}

// Decorative "to study" cards on the homepage hero — pulled from the real
// generated card images (not hardcoded), so they always match whatever's
// actually on the site.
function populateDecoCards() {
  // Demo build: "to study" (concept 30) is purely decorative here and isn't
  // one of the 100 licensed concepts, so it isn't in this build's trimmed cards.json --
  // paths hardcoded from production instead of looked up via CARDS.find().
  const decoImages = {
    'JA_EN': "assets/cards/PTW_000088.webp",
    'HI_EN': "assets/cards_hindi/PTW_001030.jpg",
    'FR_EN': "assets/cards/PTW_003030.webp",
  };
  const order = ['JA_EN', 'HI_EN', 'FR_EN'];
  order.forEach((dir, i) => {
    const el = document.getElementById(`deco-card-${i + 1}`);
    if (el) el.src = decoImages[dir];
  });
}

// ── Page switching ──────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  if (page === 'home') {
    document.getElementById('page-home').classList.add('active');
    currentCategoryId = null;
  } else {
    document.getElementById('page-app').classList.add('active');
  }
  // Swapping the .active class does not move the viewport, so a category
  // opened from halfway down the home page used to render at that same
  // offset - which reads as the page starting from its middle.
  // behavior:'auto' because styles.css sets html { scroll-behavior: smooth },
  // and a page switch should be instant rather than animating the whole way.
  ptwScrollToTop();
}

function ptwScrollToTop() {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  } catch (err) {
    window.scrollTo(0, 0);          // older browsers: no options object
  }
  // Some layouts scroll an inner column rather than the window; reset that
  // too, harmlessly, when it exists.
  const main = document.querySelector('.app-main, #page-app');
  if (main && main.scrollTop) main.scrollTop = 0;
}

// ── Homepage ────────────────────────────────────────────────────
function buildHomepage() {
  const grid = document.getElementById('home-cat-grid');
  grid.innerHTML = visibleCategories().map(cat => `
    <div class="cat-tile" onclick="openCategory('${cat.id}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openCategory('${cat.id}')}"
         role="button" tabindex="0"
         aria-label="${cat.label}, ${countCategory(cat.id)} words"
         style="--tile-color:${cat.color}">
      <div class="cat-tile-icon">${iconForCategory(cat.label)}</div>
      <div class="cat-tile-name">${cat.label}</div>
      <div class="cat-tile-count">${countCategory(cat.id)} words</div>
    </div>
  `).join('');
  renderStatBar();
}

function countCategory(catId) {
  if (catId === 'professions') {
    return PROFESSIONS_CONCEPTS_SET && PROFESSIONS_CONCEPTS_SET.size ? PROFESSIONS_CONCEPTS_SET.size : 3515;
  }
  return CARDS.filter(c => c.category_id === catId).length;
}

// ── Grammar (separate list, not a 16th topic category) ────────────
function updateGrammarEntryPoint() {
  // Grammar category removed from the live site for now (pending a full spelling/matra
  // audit of grammar.json) -- entry point stays hidden regardless of data load state.
  return;
}

function openGrammar() {
  if (!GRAMMAR.length) return;
  document.getElementById('grammar-overlay').classList.add('open');
  showGrammarList();
}
function closeGrammar() {
  document.getElementById('grammar-overlay').classList.remove('open');
}
function showGrammarList() {
  document.getElementById('grammar-detail-view').style.display = 'none';
  document.getElementById('grammar-list-view').style.display = '';
  const groups = new Map();
  for (const g of GRAMMAR) {
    if (!groups.has(g.group)) groups.set(g.group, []);
    groups.get(g.group).push(g);
  }
  document.getElementById('grammar-groups').innerHTML = [...groups.entries()].map(([group, items]) => `
    <div class="grammar-group">
      <div class="grammar-group-title">${escapeEx(group)}</div>
      <div class="grammar-chips">
        ${items.map(g => `
          <button class="grammar-chip" onclick="showGrammarDetail('${g.concept_id}')">
            ${escapeEx(g.english)}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');
}
function showGrammarDetail(conceptId) {
  const g = GRAMMAR.find(x => x.concept_id === conceptId);
  if (!g) return;
  document.getElementById('grammar-list-view').style.display = 'none';
  document.getElementById('grammar-detail-view').style.display = '';
  document.getElementById('grammar-detail-body').innerHTML = `
    <div class="grammar-detail-en">${escapeEx(g.english)}</div>
    <div class="grammar-detail-def">${escapeEx(g.definition)} <span class="grammar-detail-group">(${escapeEx(g.group)})</span></div>
    <div class="grammar-detail-row">
      <span class="grammar-detail-flag">🇯🇵</span>
      <span class="grammar-detail-text">${escapeEx(g.japanese_kanji)} <span class="grammar-detail-reading">(${escapeEx(g.japanese_kana)} · ${escapeEx(g.japanese_romaji)})</span></span>
      <button class="grammar-audio-btn" onclick="playAudio('${escapeEx(g.audio.ja)}','${escapeEx(g.japanese_kana)}','ja')">🔊</button>
      <button class="grammar-usage-btn" onclick="openGrammarUsage('${conceptId}', 'JA_EN')">View usage</button>
    </div>
    <div class="grammar-detail-row">
      <span class="grammar-detail-flag">🇺🇸</span>
      <span class="grammar-detail-text">${escapeEx(g.english)}</span>
      <button class="grammar-audio-btn" onclick="playAudio('${escapeEx(g.audio.en)}','${escapeEx(g.english)}','en')">🔊</button>
    </div>
    <div class="grammar-detail-row">
      <span class="grammar-detail-flag">🇫🇷</span>
      <span class="grammar-detail-text">${escapeEx(g.french)}</span>
      <button class="grammar-audio-btn" onclick="playAudio('${escapeEx(g.audio.fr)}','${escapeEx(g.french)}','fr')">🔊</button>
      <button class="grammar-usage-btn" onclick="openGrammarUsage('${conceptId}', 'FR_EN')">View usage</button>
    </div>
    <div class="grammar-detail-row">
      <span class="grammar-detail-flag">🇮🇳</span>
      <span class="grammar-detail-text">${escapeEx(g.hindi)} <span class="grammar-detail-reading">(${escapeEx(g.hindi_romanized)})</span></span>
      <button class="grammar-audio-btn" onclick="playAudio('${escapeEx(g.audio.hi)}','${escapeEx(g.hindi)}','hi')">🔊</button>
      <button class="grammar-usage-btn" onclick="openGrammarUsage('${conceptId}', 'HI_EN')">View usage</button>
    </div>
    <button class="grammar-usage-all-btn" onclick="openGrammarUsage('${conceptId}', 'ALL')">🌐 View example sentences in all 4 languages</button>
  `;
}

// ── Grammar concept example sentences ─────────────────────────────
// Grammar concepts (data/grammar.json) share the same concept_id space as
// the 5,000 curated vocabulary concepts, and -- found 2026-10-04, contrary
// to what had been assumed -- already have real, human-verified (Tatoeba)
// example sentences sitting in the SAME unified corpus vocabulary cards
// read (data/examples.json), just never surfaced in the grammar detail
// view. So this reuses that corpus and the existing rendering helpers
// (loadUnifiedExamples/directionExampleRow/exAudioBtn/jaHtml) wholesale
// rather than building a second content pipeline -- the one gap is
// Japanese coverage (59 of 84 grammar concepts have a JA row; the other 25
// are mostly prepositions/determiners with no natural single-sentence JA
// equivalent -- "at", "under", "between" and similar don't map onto a
// lexical item in the Tatoeba corpus the way a pronoun or noun does).
// Opens the SAME #usage-overlay the inflected-forms "View usage" feature
// already uses (see openUsage/renderUsageBody above) -- a second,
// independent overlay system was not needed.
function openGrammarUsage(conceptId, pair) {
  const overlay = document.getElementById('usage-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  renderGrammarUsageBody(conceptId, pair);
}

function grammarAllLangRow(r) {
  const langs = ['ja', 'hi', 'fr', 'en'];
  const rows = langs.filter(l => r[l]).map(l => {
    const text = l === 'ja' ? jaHtml(r) : escapeEx(r[l]);
    const audio = exAudioBtn(r[`${l}_audio_url`], r[l], l);
    const furi = l === 'ja' && r.ja_furigana;
    return `<div class="pwa-ex-also${furi ? ' pwa-ex-has-furigana' : ''}"><span class="pwa-ex-lang-flag">${EX_LANG_FLAG[l]}</span>${audio}<span class="pwa-ex-text">${text}</span></div>`;
  }).join('');
  return `<div class="pwa-ex pwa-ex-multilingual">${rows}</div>`;
}

function renderGrammarUsageBody(conceptId, pair) {
  const body = document.getElementById('usage-body');
  if (!body) return;
  const g = GRAMMAR.find(x => x.concept_id === conceptId);
  body.innerHTML = '<p class="notes-empty">Loading…</p>';
  loadUnifiedExamples().then(unified => {
    const allRows = ((unified[conceptId] || {}).sentences) || [];
    let html, headLabel, shownRows;
    if (pair === 'ALL') {
      headLabel = (g ? g.english : conceptId) + ' · all 4 languages';
      shownRows = allRows;
      html = allRows.map(grammarAllLangRow).join('');
    } else {
      const [topLang, bottomLang] = pair.toLowerCase().split('_');
      headLabel = g ? g.english : conceptId;
      shownRows = allRows.filter(r => r[topLang] && r[bottomLang]);
      html = shownRows.map(directionExampleRow(topLang, bottomLang)).join('');
    }
    if (!html) {
      html = `<p class="notes-empty">No example sentences ${pair === 'ALL' ? '' : 'for this pair '}yet for "${escapeEx(g ? g.english : conceptId)}".</p>`;
    }
    body.innerHTML = `
      <div class="ptw-usage-head">
        <div class="ptw-usage-head-form">${escapeEx(headLabel)}</div>
      </div>
      ${html}
      <p class="pwa-ex-credit">${grammarUsageCredit(shownRows)}</p>
    `;
  });
}

// Found 2026-10-04 while adding the first ai_generated-sourced rows this
// view would ever show: it previously credited every row shown here to
// Tatoeba unconditionally, which was accurate for every row that existed
// when it was first written (all Tatoeba) but became a factually wrong
// attribution the moment a hand-verified AI-generated row (source starts
// "ai_generated") was added for a JA-gap concept. Mirrors the source-set
// reasoning examplesHtml() already uses for the main vocabulary examples
// block, scoped to just the rows actually being shown in this overlay.
function grammarUsageCredit(rows) {
  const sources = new Set((rows || []).map(r => r.source).filter(Boolean));
  const hasTatoeba = sources.has('Tatoeba');
  const hasAi = [...sources].some(s => s.startsWith('ai_generated'));
  const hasOtherUntagged = rows.some(r => !r.source);
  if (hasAi && !hasTatoeba && !hasOtherUntagged) {
    return 'Example sentences generated by AI, individually hand-verified.';
  }
  if (hasAi) {
    return 'Example sentences from <a href="https://tatoeba.org" target="_blank" rel="noopener">Tatoeba</a>, '
      + 'a free collaborative sentence database, plus some hand-verified AI-generated sentences.';
  }
  return 'Example sentences from <a href="https://tatoeba.org" target="_blank" rel="noopener">Tatoeba</a>, a free collaborative sentence database.';
}

// ── Professions & Specialisations ────────────────────────────
function initProfessionsData() {
  if (!PROFESSIONS_DATA) return;
  const cats = PROFESSIONS_DATA.categories || {};
  const concepts = PROFESSIONS_DATA.concepts || {};
  PROFESSIONS_CONCEPTS_SET = new Set(Object.keys(concepts));
  PROFESSIONS_SUBCAT_MAP = {};
  
  const counts = {};
  for (const [cid, clist] of Object.entries(concepts)) {
    for (const catKey of clist) {
      if (!PROFESSIONS_SUBCAT_MAP[catKey]) {
        PROFESSIONS_SUBCAT_MAP[catKey] = new Set();
      }
      PROFESSIONS_SUBCAT_MAP[catKey].add(cid);
      counts[catKey] = (counts[catKey] || 0) + 1;
    }
  }

  PROFESSIONS_CAT_LIST = Object.keys(cats).map(key => ({
    key,
    label: cats[key].label || key,
    count: counts[key] || 0
  })).sort((a, b) => b.count - a.count);

  populateProfessionsDropdown();
  renderProfessionHomeChips();
}

function populateProfessionsDropdown() {
  const sel = document.getElementById('prof-subcat-select');
  if (!sel || !PROFESSIONS_CAT_LIST.length) return;
  const total = PROFESSIONS_CONCEPTS_SET && PROFESSIONS_CONCEPTS_SET.size ? PROFESSIONS_CONCEPTS_SET.size : 3515;
  sel.innerHTML = `<option value="all">All Fields (${total.toLocaleString()} concepts)</option>` +
    PROFESSIONS_CAT_LIST.map(p =>
      `<option value="${p.key}" ${currentProfessionSubcat === p.key ? 'selected' : ''}>${escapeEx(p.label)} (${p.count})</option>`
    ).join('');
}

function updateProfessionsEntryPoint() {
  const section = document.getElementById('home-professions-section');
  const count = document.getElementById('prof-entry-count');
  if (!section) return;
  const total = PROFESSIONS_CONCEPTS_SET && PROFESSIONS_CONCEPTS_SET.size ? PROFESSIONS_CONCEPTS_SET.size : 3515;
  section.style.display = '';
  if (count) count.textContent = `${total.toLocaleString()} concepts · ${PROFESSIONS_CAT_LIST.length || 50} specialised fields`;
  renderProfessionHomeChips();
}

function renderProfessionHomeChips() {
  const grid = document.getElementById('profession-home-chips');
  if (!grid || !PROFESSIONS_CAT_LIST.length) return;
  const top = PROFESSIONS_CAT_LIST.slice(0, 12);
  grid.innerHTML = top.map(p => `
    <button class="profession-chip" onclick="openProfessionField('${p.key}')" title="Explore ${escapeEx(p.label)}">
      <span>${escapeEx(p.label)}</span>
      <span class="profession-chip-count">${p.count}</span>
    </button>
  `).join('');
}

function openProfessionField(key) {
  currentProfessionSubcat = key;
  openCategory('professions');
}

function setProfessionSubcat(subcatKey) {
  currentProfessionSubcat = subcatKey;
  renderConceptGrid();
  updateCatHeader('professions');
}

// ── Sidebar ─────────────────────────────────────────────────────
function buildSidebar() {
  const sb = document.getElementById('sidebar-nav');
  sb.innerHTML = visibleCategories().map(cat => `
    <div class="sb-domain" id="sbd-${cat.id}">
      <div class="sb-domain-head" onclick="openCategory('${cat.id}')" style="--dot-color:${cat.color}">
        <span class="sb-dot" style="background:${cat.color}"></span>
        <span class="sb-label">${cat.label}</span>
        <span class="sb-count">${countCategory(cat.id)}</span>
      </div>
    </div>
  `).join('');

  // Mirrors the sidebar's own options for phones, where the sidebar itself
  // is hidden (see the <select> comment in index.html for why).
  const mobileSel = document.getElementById('mobile-category-select');
  if (mobileSel) {
    mobileSel.innerHTML = '<option value="">Switch category…</option>' +
      visibleCategories().map(cat =>
        `<option value="${cat.id}">${cat.label} (${countCategory(cat.id)})</option>`
      ).join('');
  }
}

// ── Open a category ──────────────────────────────────────────────
function openCategory(catId) {
  currentCategoryId = catId;
  if (catId !== 'professions') {
    currentProfessionSubcat = 'all';
  }
  renderConceptGrid();
  showPage('app');
  updateActiveNav(catId);
  updateCatHeader(catId);
  document.querySelectorAll('.sb-domain').forEach(el => el.classList.remove('open'));
  const el = document.getElementById(`sbd-${catId}`);
  if (el) el.classList.add('open');
}

function updateActiveNav(catId) {
  document.querySelectorAll('.sb-domain-head').forEach(el => el.classList.remove('active'));
  const dEl = document.getElementById(`sbd-${catId}`)?.querySelector('.sb-domain-head');
  if (dEl) dEl.classList.add('active');
  // Keep the phone dropdown in sync when a category is opened any other
  // way (a card tile, search, a deep link) so it always reflects where
  // you actually are, not just changes triggered by the dropdown itself.
  const mobileSel = document.getElementById('mobile-category-select');
  if (mobileSel) mobileSel.value = catId;
}

function updateCatHeader(catId) {
  const cat = CATEGORIES.find(c => c.id === catId);
  if (!cat) return;
  const countEl = document.getElementById('cat-header-count');
  const labelEl = document.getElementById('cat-header-label');
  const profFilter = document.getElementById('prof-filter-container');

  if (catId === 'professions') {
    if (profFilter) profFilter.style.display = 'flex';
    let count = PROFESSIONS_CONCEPTS_SET && PROFESSIONS_CONCEPTS_SET.size ? PROFESSIONS_CONCEPTS_SET.size : 3515;
    let label = 'Professions & Specialisations';
    if (currentProfessionSubcat && currentProfessionSubcat !== 'all') {
      const sub = PROFESSIONS_CAT_LIST.find(p => p.key === currentProfessionSubcat);
      if (sub) {
        count = sub.count;
        label = sub.label;
      }
    }
    document.getElementById('cat-header').style.background =
      `linear-gradient(135deg, ${cat.color}dd 0%, ${cat.color}99 100%)`;
    if (labelEl) labelEl.textContent = label;
    if (countEl) countEl.textContent = `${count.toLocaleString()} words`;
    document.getElementById('topbar-crumb').textContent = label;
    const sel = document.getElementById('prof-subcat-select');
    if (sel) sel.value = currentProfessionSubcat || 'all';
  } else {
    if (profFilter) profFilter.style.display = 'none';
    const count = countCategory(catId);
    document.getElementById('cat-header').style.background =
      `linear-gradient(135deg, ${cat.color}dd 0%, ${cat.color}99 100%)`;
    if (labelEl) labelEl.textContent = cat.label;
    if (countEl) countEl.textContent = `${count.toLocaleString()} words`;
    document.getElementById('topbar-crumb').textContent = cat.label;
  }
}

// ── Concept grid (thumbnails) ────────────────────────────────────
function renderConceptGrid() {
  let concepts;
  if (currentCategoryId === 'professions') {
    if (currentProfessionSubcat && currentProfessionSubcat !== 'all') {
      const allowed = PROFESSIONS_SUBCAT_MAP[currentProfessionSubcat] || new Set();
      concepts = CARDS.filter(c => allowed.has(String(c.concept_id)));
    } else {
      concepts = CARDS.filter(c => PROFESSIONS_CONCEPTS_SET && PROFESSIONS_CONCEPTS_SET.has(String(c.concept_id)));
    }
  } else {
    concepts = CARDS.filter(c => c.category_id === currentCategoryId);
  }
  concepts = sortConcepts(concepts);
  const deck = document.getElementById('card-deck');
  deck.innerHTML = concepts.map(c => renderConceptTile(c)).join('');
  applyStarDisplay();
}

function firstAvailableDirection(concept) {
  if (concept.directions[prefDirection]) return prefDirection;
  return Object.keys(concept.directions)[0];
}

// removeOnclick is an optional raw JS expression (e.g. a function call)
// run when the tile's ✕ button is tapped -- used by My Categories/
// Favorites/History so a card can be taken off THAT list without
// unstarring it globally or opening it first. Omitted entirely on the
// ordinary category-browsing grid, where there is no "list" to remove
// a card from.
function renderConceptTile(c, removeOnclick) {
  const dir = firstAvailableDirection(c);
  const thumb = c.directions[dir];
  const isStarred = starred.has(c.concept_id);
  const label = labelFor(c);
  return `
  <div class="card-wrap" id="tile-${c.concept_id}" data-id="${c.concept_id}" onclick="openConcept('${c.concept_id}')">
    <button class="star-btn ${isStarred ? 'starred' : ''}" data-id="${c.concept_id}"
      onclick="toggleStar(event,'${c.concept_id}')">★</button>
    ${removeOnclick ? `<button class="tile-remove-btn" title="Remove from this list" onclick="event.stopPropagation(); ${removeOnclick}">✕</button>` : ''}
    <div class="front-img-wrap">
      <img src="${thumb.image_url}" alt="${label}" loading="lazy">
    </div>
    <div class="tile-label">${label}</div>
  </div>`;
}

// ── Concept detail (focus overlay, with direction tabs) ──────────
function openConcept(conceptId) {
  currentConceptId = conceptId;
  const concept = CARDS.find(c => c.concept_id === conceptId);
  if (!concept) return;
  // Custom cards (custom-cards.js) don't have the curated deck's
  // multi-direction/audio/related-words machinery -- a single lightweight
  // detail renderer instead, reusing the same #focus-overlay shell.
  if (concept.is_custom) {
    renderCustomCardDetail(concept);
  } else {
    currentDirection = firstAvailableDirection(concept);
    renderConceptDetail();
  }
  const focusOverlay = document.getElementById('focus-overlay');
  focusOverlay.classList.add('open');
  // History, My Notes, Favorites and My Categories all open a card from
  // inside #account-overlay/#notes-overlay (z-index 560) without closing
  // it first, so the list is still there to return to once the card is
  // closed. #focus-overlay's own z-index (500) is deliberately kept below
  // .app-topbar (550) so the avatar dropdown stays reachable while a card
  // opened directly (from category browsing) is on screen -- but that
  // reasoning doesn't apply once a list overlay is already covering the
  // topbar, so bump the card above it in that case specifically.
  const listOverlayOpen = document.getElementById('account-overlay').classList.contains('open')
    || document.getElementById('notes-overlay').classList.contains('open');
  focusOverlay.classList.toggle('above-list', listOverlayOpen);
  ensureFocusOverlayClearsTopbar();
  document.body.style.overflow = 'hidden';
  // Every way of viewing a card (category browse, search, deep link, My
  // Categories) converges here, so this is the one place history needs to
  // record from -- previously only searchGoTo() called recordLookup(),
  // which meant ordinary browsing (the primary way most views happen)
  // never appeared in History at all.
  if (typeof recordLookup === 'function') recordLookup(conceptId);
}

// On a phone, .app-topbar wraps its three groups (home/crumb, study
// prefs, search/starred/login) onto separate rows -- its real rendered
// height varies with content and viewport width, easily 300px+, far more
// than a fixed CSS guess could safely account for. #focus-overlay centers
// itself by default, which let the topbar (kept at a higher z-index on
// purpose, so the avatar dropdown still works with a card open) visually
// cover the top of the card -- including its own close button -- whenever
// the centered card's top edge landed underneath it. Measuring the
// topbar's actual height and using it as top padding guarantees the card
// always starts clear of it, on any screen size, without a magic number
// that breaks the next time the topbar's wrapped content changes.
function ensureFocusOverlayClearsTopbar() {
  const overlay = document.getElementById('focus-overlay');
  const closeBtn = overlay ? overlay.querySelector('.focus-close') : null;
  const topbar = document.querySelector('.app-topbar');
  if (!overlay) return;
  const h = topbar ? topbar.getBoundingClientRect().height : 0;
  if (window.innerWidth > 640 || h < 1) {
    overlay.style.paddingTop = '';
    overlay.style.alignItems = '';
    if (closeBtn) closeBtn.style.top = '';
    return;
  }
  overlay.style.alignItems = 'flex-start';
  overlay.style.paddingTop = `${h + 16}px`;
  // .focus-close is position:fixed (viewport-relative), so the padding
  // above doesn't move it -- left alone, it stays pinned at the very top
  // of the screen, now rendering (thanks to its z-index) ON TOP of the
  // topbar's own Log in/Sign up buttons instead of clearing them. Move it
  // down to sit at the card's actual top edge instead.
  if (closeBtn) closeBtn.style.top = `${h + 16}px`;
}
window.addEventListener('resize', () => {
  if (document.getElementById('focus-overlay')?.classList.contains('open')) {
    ensureFocusOverlayClearsTopbar();
  }
});

function closeFocus() {
  const focusOverlay = document.getElementById('focus-overlay');
  focusOverlay.classList.remove('open');
  focusOverlay.classList.remove('above-list');
  document.body.style.overflow = '';
  currentConceptId = null;
}

function switchDirection(direction) {
  currentDirection = direction;
  renderConceptDetail();
}

function renderConceptDetail() {
  const concept = CARDS.find(c => c.concept_id === currentConceptId);
  if (!concept) return;

  const availableDirections = Object.keys(concept.directions);
  const tabs = availableDirections.map(dir => `
    <button class="dir-tab ${dir === currentDirection ? 'active' : ''}" onclick="switchDirection('${dir}')">
      ${concept.directions[dir].label}
    </button>
  `).join('');

  const d = concept.directions[currentDirection];
  const card = d ? `
    <div class="focus-card-img-wrap">
      <img class="focus-card-img" src="${d.image_url}" alt="${concept.english}">
      <button class="focus-zoom-btn" onclick="toggleFocusZoom()" aria-label="Enlarge card" title="Enlarge card">⤢</button>
    </div>
    <div class="focus-audio-row">
      <button class="audio-btn" onclick="playAudio('${d.header_audio_url}')">🔊 Word</button>
      <button class="audio-btn" onclick="playAudio('${d.footer_audio_url}')">🔊 Meaning</button>
    </div>
    <div class="card-actions">
      <span id="review-add-btn" onclick="toggleReview('${concept.concept_id}', '${currentDirection}')"
        class="card-action">+ Add to Review</span>
      <span onclick="openAddToCategoryPicker('${concept.concept_id}', '${currentDirection}')"
        class="card-action">+ Add to Category</span>
      <span onclick="copyConceptLink('${concept.concept_id}')" class="card-action">Copy link</span>
      <span onclick="reportCardIssue('${concept.concept_id}', '${currentDirection}')"
        class="card-action card-action-quiet" title="Wrong translation, audio or illustration?">Report an issue</span>
    </div>
  ` : `<div class="back-empty">This direction isn't available for this concept yet.</div>`;

  // These three were written but never called - renderConceptDetail built
  // the image, audio, actions and note panel and stopped. Their styles are
  // already in styles.css, so the card had the room for them all along.
  // Only rendered when this direction actually has a card.
  const extras = d ? `
    ${renderAlsoMeans(concept)}
    ${renderRelatedWords(concept)}
    ${renderPhrases(concept)}
    ${renderJaCollocations(concept)}
    ${renderEnCollocations(concept)}
    ${renderFrCollocations(concept)}
    ${renderHiCollocations(concept)}
    ${renderInflections(concept)}
    <div id="pwa-ex-slot"></div>
  ` : '';

  document.getElementById('focus-card-inner').innerHTML = `
    <div class="dir-tabs">${tabs}</div>
    ${card}
    ${extras}
    <button class="note-panel-toggle" id="note-panel-toggle" onclick="toggleNotePanel()">
      <span>📝 My note</span>
      <span class="chevron">▾</span>
    </button>
    <div class="note-panel-body" id="note-panel-body">
      <div id="note-panel"></div>
    </div>
  `;
  if (d) updateReviewButton(concept.concept_id, currentDirection);
  if (typeof renderNotePanel === 'function') renderNotePanel(concept.concept_id, currentDirection);
  // The corpus is 10 MB, so it loads once on first use rather than with
  // the page; the slot fills in when it arrives instead of blocking.
  if (d) fillExamples(concept);
}

function toggleFocusZoom() {
  document.getElementById('focus-card-wrap').classList.toggle('zoomed');
}

function toggleNotePanel() {
  document.getElementById('note-panel-toggle').classList.toggle('expanded');
  document.getElementById('note-panel-body').classList.toggle('open');
}

// fallbackLang defaults to 'ja' so card word/meaning audio keeps its
// previous behavior unchanged when a clip is missing and the fallback
// text needs a Japanese voice.
/* ---- Mute -------------------------------------------------------------
   One switch for every sound the site makes: card audio, meanings and
   example sentences. A mute, not a pause -- the point is "make it stop",
   and a paused clip resuming later on a different card would be worse
   than useless. Persisted so it survives a reload. */
let PTW_MUTED = (function () {
  try { return localStorage.getItem('ptw_muted') === '1'; } catch (e) { return false; }
})();
function ptwIsMuted() { return PTW_MUTED === true; }
function ptwSetMuted(muted) {
  PTW_MUTED = !!muted;
  try { localStorage.setItem('ptw_muted', PTW_MUTED ? '1' : '0'); } catch (e) {}
  if (PTW_MUTED && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  document.querySelectorAll('.ptw-mute-btn').forEach(b => {
    b.textContent = PTW_MUTED ? '\u{1F507}' : '\u{1F50A}';
    b.title = PTW_MUTED ? 'Audio muted - click to unmute' : 'Mute audio';
    b.setAttribute('aria-pressed', PTW_MUTED ? 'true' : 'false');
  });
  return PTW_MUTED;
}
function ptwToggleMute() { return ptwSetMuted(!ptwIsMuted()); }

function playAudio(url, fallbackText, fallbackLang) {
  if (ptwIsMuted()) return;
  const speak = fallbackLang === 'en' ? speakEn : fallbackLang === 'hi' ? speakHi : fallbackLang === 'fr' ? speakFr : speakJa;
  if (!url) {
    if (fallbackText) speak(fallbackText);
    return;
  }
  const audio = new Audio(url);
  audio.play().catch(err => {
    console.log('Audio play error:', err);
    if (fallbackText) speak(fallbackText);
  });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('usage-overlay').classList.contains('open')) closeUsage();
    if (document.getElementById('focus-overlay').classList.contains('open')) closeFocus();
    if (document.getElementById('notes-overlay').classList.contains('open')) closeMyNotes();
    if (document.getElementById('account-overlay').classList.contains('open')) closeMyAccount();
  }
});

// ── Stars ───────────────────────────────────────────────────────
// Favourites: localStorage is always the instant, offline-safe source of
// truth for the UI (star toggles feel immediate and work with no
// account). When logged in, every change is also pushed to Supabase
// (best-effort, matching srs.js's existing "don't block the UI on the
// network" pattern for progress), and on load/reconnect the local set is
// merged with whatever the account has -- so a card starred on one
// device shows up on another the next time either one is online.
// A star made while offline simply queues as a local-only star until
// the next successful sync merges it up; nothing is lost, it just isn't
// visible on a second device until that sync happens.
function toggleStar(evt, id) {
  evt.stopPropagation();
  const nowStarred = !starred.has(id);
  if (nowStarred) starred.add(id); else starred.delete(id);
  saveStars();
  applyStarDisplay();
  syncStarChange(id, nowStarred).catch(() => {});
}

function saveStars() {
  try { localStorage.setItem('ptw_stars', JSON.stringify([...starred])); } catch(e){}
}

function loadStars() {
  try {
    const saved = JSON.parse(localStorage.getItem('ptw_stars') || '[]');
    starred = new Set(saved);
  } catch(e) { starred = new Set(); }
  syncStarsFromAccount().catch(() => {});
}

async function syncStarChange(conceptId, isNowStarred) {
  if (typeof getCurrentUser !== 'function') return;
  const user = await getCurrentUser();
  if (!user) return;
  if (isNowStarred) {
    await supabaseClient.from('favourites')
      .upsert({ user_id: user.id, concept_id: Number(conceptId) }, { onConflict: 'user_id,concept_id' });
  } else {
    await supabaseClient.from('favourites')
      .delete().eq('user_id', user.id).eq('concept_id', Number(conceptId));
  }
}

async function syncStarsFromAccount() {
  if (typeof getCurrentUser !== 'function') return;
  const user = await getCurrentUser();
  if (!user) return;
  const { data, error } = await supabaseClient
    .from('favourites').select('concept_id').eq('user_id', user.id);
  if (error || !data) return;

  // Union, don't replace: a star made on this device while offline (or
  // before ever logging in) must survive being merged with the account's
  // remote set, not get clobbered by it.
  const remoteIds = data.map(r => String(r.concept_id));
  let changed = false;
  for (const id of remoteIds) {
    if (!starred.has(id)) { starred.add(id); changed = true; }
  }
  // Anything starred locally that the account doesn't have yet (offline
  // star, or first sync right after logging in) needs pushing up too.
  for (const id of starred) {
    if (!remoteIds.includes(id)) {
      syncStarChange(id, true).catch(() => {});
    }
  }
  if (changed) { saveStars(); applyStarDisplay(); }
}

function applyStarDisplay() {
  document.querySelectorAll('.star-btn').forEach(btn => {
    const id = btn.dataset.id;
    btn.classList.toggle('starred', starred.has(id));
  });
}

// ── Stars-only filter ───────────────────────────────────────────
let starsOnly = false;
function toggleStarsOnly() {
  starsOnly = !starsOnly;
  document.getElementById('stars-btn').classList.toggle('active', starsOnly);
  document.querySelectorAll('.card-wrap').forEach(el => {
    const show = !starsOnly || starred.has(el.dataset.id);
    el.style.display = show ? '' : 'none';
  });
}

// ── Search — matches ANY written form in ANY of the 4 languages ──
// Powers the curated-vocabulary tier of Quick Lookup's single search box
// (runSingleWordLookup); the full lookup flow (word + sentence parsing,
// dictionary fallback, rendering) lives with Quick Lookup below.

const SEARCH_MAX_RESULTS = 20;
// Object.keys over 27,000+ terms on every keystroke is wasteful, and the index
// never changes after load.
let SEARCH_TERMS = null;
function searchTerms() {
  if (!SEARCH_TERMS) SEARCH_TERMS = Object.keys(SEARCH_INDEX || {});
  return SEARCH_TERMS;
}

/* Edit distance, abandoned as soon as it is certain to exceed `max` (-1 is
   returned in that case rather than the true distance, which is all the caller
   needs). Only the band of width `max` around the diagonal can still produce a
   result within budget, so the rest of each row is skipped.

   Adjacent transpositions count as ONE edit, not two -- "fsih" for "fish" is
   the most common typo there is, and plain Levenshtein scores it 2, which put
   it outside the budget for a query that short and returned nothing at all.

   Works on code units, so Japanese, Hindi and French are treated alike: a
   wrong kana in ひこうき or a missing accent in "café" is one edit the same way
   a slip in "orphan" is. */
function editDistanceWithin(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return -1;
  const OVER = max + 1;
  let prev2 = new Array(lb + 1).fill(OVER);
  let prev = new Array(lb + 1).fill(OVER);
  let curr = new Array(lb + 1).fill(OVER);
  for (let j = 0; j <= Math.min(lb, max); j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const from = Math.max(1, i - max);
    const to = Math.min(lb, i + max);
    curr.fill(OVER);
    if (i <= max) curr[0] = i;
    // curr[0] is a real cell of the row (deleting all of `a` so far), so it
    // counts toward the row minimum -- without it a comparison against an
    // empty string reports "over budget" for every row and returns -1.
    let best = i <= max ? i : OVER;
    for (let j = from; j <= to; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 &&
          a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
          a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      curr[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return -1;
    const t = prev2; prev2 = prev; prev = curr; curr = t;
  }
  return prev[lb] <= max ? prev[lb] : -1;
}

/* Tiered word search.
   Previously this was an exact hit on the index key, falling back to a
   substring scan that stopped at the first 20 concepts it happened to reach
   in object-key order -- so results were unranked (a query that WAS an
   indexed term could be pushed out by longer terms that merely contained it)
   and a single typo returned nothing at all. Terms are now scored:

     0  exact
     1  prefix           ("orph" -> "orphan")
     2  substring        ("phan" -> "orphan")
     3+ edit distance    ("orpan", "recieve", ひこうぎ)

   with shorter terms winning inside a tier, since a short term containing the
   query is a closer match than a long one. The fuzzy tier only runs when the
   literal tiers came up short -- it is the expensive one, and when someone has
   typed something that really is in the index there is nothing to correct. */
function searchWords(q) {
  const scored = [];
  for (const term of searchTerms()) {
    if (term === q) scored.push([0, term.length, term]);
    else if (term.startsWith(q)) scored.push([1, term.length, term]);
    else if (term.includes(q)) scored.push([2, term.length, term]);
  }

  let approximate = false;
  if (scored.length < 5 && q.length >= 3) {
    // One edit for a short query, two for anything longer: allowing two edits
    // on a 4-letter word matches half the dictionary.
    const max = q.length <= 5 ? 1 : 2;
    for (const term of searchTerms()) {
      const d = editDistanceWithin(term, q, max);
      if (d > 0) scored.push([3 + d, term.length, term]);
    }
    approximate = scored.length > 0 && scored.every(s => s[0] >= 3);
  }

  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const seen = new Set();
  const results = [];
  for (const [, , term] of scored) {
    for (const id of SEARCH_INDEX[term]) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      const card = CARDS.find(c => c.concept_id === String(id));
      if (card) results.push(card);
      if (results.length >= SEARCH_MAX_RESULTS) return { results, approximate };
    }
  }
  return { results, approximate };
}

// ── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// A star made while offline is queued locally (toggleStar always writes
// to localStorage first); this is what actually delivers it to the
// account, and to any other device, once connectivity comes back.
window.addEventListener('online', () => {
  if (typeof syncStarsFromAccount === 'function') syncStarsFromAccount().catch(() => {});
});

// ── Online/Offline Status UI ────────────────────────────────────
// Show/hide offline indicators and trigger sync when connectivity changes.

function updateOfflineIndicators() {
  const isOffline = !navigator.onLine;
  const indicators = document.querySelectorAll('.offline-indicator');
  indicators.forEach(el => {
    el.style.display = isOffline ? 'flex' : 'none';
  });

  // Update category tile badges if offline download manager is initialized
  if (window.offlineDownloadManager?.manifest) {
    updateCategoryDownloadBadges();
  }
}

function showSyncIndicator(show) {
  const indicator = document.getElementById('sync-indicator');
  if (indicator) {
    indicator.style.display = show ? 'flex' : 'none';
  }
}

function updateCategoryDownloadBadges() {
  const manager = window.offlineDownloadManager;
  if (!manager?.manifest) return;

  const statuses = manager.getAllCategoryStatuses();

  // Update home page category tiles
  document.querySelectorAll('.cat-tile').forEach(tile => {
    const onclick = tile.getAttribute('onclick');
    if (!onclick) return;

    const match = onclick.match(/openCategory\('([^']+)'\)/);
    if (!match) return;

    const categoryId = match[1];
    const status = statuses[categoryId];
    if (!status) return;

    // Remove existing badge
    const existingBadge = tile.querySelector('.cat-tile-download-badge');
    if (existingBadge) existingBadge.remove();

    // Add new badge
    const badge = document.createElement('div');
    badge.className = 'cat-tile-download-badge ' + status.status.replace('_', '-');

    if (status.status === 'downloaded') {
      badge.innerHTML = '&#10003;'; // checkmark
      badge.title = 'Available offline';
    } else if (status.status === 'downloading') {
      badge.innerHTML = `${status.progress}%`;
      badge.title = `Downloading: ${status.progress}%`;
    } else {
      badge.innerHTML = '&#9675;'; // empty circle
      badge.title = 'Not downloaded for offline';
    }

    tile.appendChild(badge);
  });
}

// Initialize offline indicators on load
document.addEventListener('DOMContentLoaded', () => {
  updateOfflineIndicators();

  // Initialize offline download manager
  if (window.offlineDownloadManager) {
    window.offlineDownloadManager.init().then(() => {
      updateCategoryDownloadBadges();

      // Listen for download state changes
      window.offlineDownloadManager.addListener(() => {
        updateCategoryDownloadBadges();
      });
    }).catch(err => {
      console.warn('Could not initialize offline download manager:', err);
    });
  }
});

// Handle online event - show sync indicator and trigger syncs
window.addEventListener('online', () => {
  updateOfflineIndicators();
  showSyncIndicator(true);

  // Hide sync indicator after a delay
  setTimeout(() => {
    showSyncIndicator(false);
  }, 3000);
});

// Handle offline event - show offline indicators
window.addEventListener('offline', () => {
  updateOfflineIndicators();
  showSyncIndicator(false);
});


/* ================================================================
   v4.1 ADDITIONS — homepage entry point, category icons, live stat
   bar, loading skeleton, and keyboard shortcuts.
   ================================================================ */

// ── Hero call to action ─────────────────────────────────────────
// Opens the first category rather than dumping the learner into an
// empty app shell. Falls back to search if data hasn't loaded yet.
function startLearning() {
  if (CATEGORIES && CATEGORIES.length) openCategory(CATEGORIES[0].id);
  else openQuickLookup();
}

// ── Stat bar ────────────────────────────────────────────────────
// Every figure is counted from the data actually shipped, so the bar
// can never drift out of step with the library.
function renderStatBar() {
  const concepts = CARDS.length;
  let cardCount = 0;
  // DISTINCT urls, not slots. Each concept has two directions and the
  // same two mp3 files serve both - JA_EN plays ja on the header and en
  // on the footer, EN_JA plays the same pair the other way round. The
  // old count added every slot, so 2,000 recordings were advertised as
  // 4,000. A Set counts the files that actually exist.
  const audioFiles = new Set();
  CARDS.forEach(c => {
    const dirs = Object.values(c.directions || {});
    cardCount += dirs.length;
    dirs.forEach(d => {
      if (d && d.header_audio_url) audioFiles.add(d.header_audio_url);
      if (d && d.footer_audio_url) audioFiles.add(d.footer_audio_url);
    });
  });
  const audioCount = audioFiles.size;

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value.toLocaleString();
  };
  set('stat-total', concepts);
  set('stat-cards', cardCount);
  set('stat-audio', audioCount);
  set('stat-topics', visibleCategories().length);
}

// ── Loading skeleton ────────────────────────────────────────────
// A blank grid reads as broken; a shimmering one reads as loading.
function renderCatSkeleton() {
  const grid = document.getElementById('home-cat-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 15 },
    () => '<div class="skeleton skel-tile"></div>').join('');
}

// ── Category icons ──────────────────────────────────────────────
// Matched on keywords in the category label rather than on ids, so
// renaming or reordering categories can't silently break the mapping.
const CATEGORY_ICONS = [
  [['nature', 'geograph'], '<path d="M3 20l6-9 4 5 3-4 5 8H3Z"/><circle cx="7" cy="6" r="2.5"/>'],
  [['emotion', 'mind', 'sense'], '<path d="M12 21s-7-4.4-7-9.5A4.5 4.5 0 0 1 12 8a4.5 4.5 0 0 1 7 3.5C19 16.6 12 21 12 21Z"/>'],
  [['home', 'everyday object'], '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'],
  [['society', 'culture', 'econom'], '<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M10 21v-5h4v5"/>'],
  [['people', 'family'], '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 20a5 5 0 0 1 5.5-4.9"/>'],
  [['value', 'relationship'], '<path d="M12 21s-7-4.4-7-9.5A4.5 4.5 0 0 1 12 8a4.5 4.5 0 0 1 7 3.5C19 16.6 12 21 12 21Z"/><path d="M9 12h6"/>'],
  [['action'], '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v6l-3 8M12 13l3 8M6 10l6-2 6 2"/>'],
  [['animal', 'insect'], '<circle cx="12" cy="14" r="5"/><path d="M8 6.5 6 3M16 6.5 18 3M12 9V4"/><path d="M7 14H3M21 14h-4"/>'],
  [['food', 'drink'], '<path d="M6 3v8a3 3 0 0 0 6 0V3"/><path d="M9 11v10"/><path d="M17 3c-1.5 3-1.5 6 0 9v9"/>'],
  [['place', 'transport'], '<path d="M4 16V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9"/><path d="M4 12h16"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/>'],
  [['body', 'health'], '<path d="M12 21s-7-4.4-7-9.5A4.5 4.5 0 0 1 12 8a4.5 4.5 0 0 1 7 3.5C19 16.6 12 21 12 21Z"/><path d="M12 10.5v4M10 12.5h4"/>'],
  [['technolog', 'number', 'communicat'], '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'],
  [['recreation', 'hobb'], '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17"/>'],
  [['time', 'change'], '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.4l3.5 2.1"/>'],
  [['colour', 'color', 'shape'], '<circle cx="9" cy="9" r="5"/><rect x="11" y="11" width="9" height="9" rx="1.5"/>'],
  [['profession', 'specialis', 'specializ'], '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M12 12v3"/>'],
];

function iconForCategory(label) {
  const l = (label || '').toLowerCase();
  const match = CATEGORY_ICONS.find(([keys]) => keys.some(k => l.includes(k)));
  const path = match ? match[1] : '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

// ── Keyboard shortcuts ──────────────────────────────────────────
// Ctrl/Cmd+K opens search, and "/" does too when you aren't typing —
// the conventions people already expect from tools they use daily.
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openQuickLookup();
    return;
  }
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openQuickLookup();
  }
});


/* ================================================================
   v4.3 ADDITIONS — shareable links, issue reporting, deep links.
   ================================================================ */

// ── Per-concept permalinks ──────────────────────────────────────
// A hash route rather than a real path, so it works on any static host
// with no redirect rules: shabdah.app/#/word/1234
function conceptLink(conceptId) {
  return `${location.origin}${location.pathname}#/word/${conceptId}`;
}

async function copyConceptLink(conceptId) {
  const url = conceptLink(conceptId);
  try {
    await navigator.clipboard.writeText(url);
    flashToast('Link copied');
  } catch (e) {
    // Clipboard access is refused over plain http, which includes
    // localhost testing on some browsers — show the link instead.
    prompt('Copy this link:', url);
  }
}

// Opens the concept named in the URL, so a shared link lands on the
// card rather than the homepage.
function openFromHash() {
  const m = (location.hash || '').match(/^#\/word\/(.+)$/);
  if (!m) return false;
  const concept = CARDS.find(c => String(c.concept_id) === decodeURIComponent(m[1]));
  if (!concept) return false;
  openCategory(concept.category_id);
  openConcept(concept.concept_id);
  return true;
}

// ── Report an issue ─────────────────────────────────────────────
// Hands the contact form a pre-filled message. Every report arrives
// naming the exact card and direction, so nothing has to be guessed.
function reportCardIssue(conceptId, direction) {
  const concept = CARDS.find(c => String(c.concept_id) === String(conceptId));
  const label = concept ? concept.english : conceptId;
  const params = new URLSearchParams({
    topic: 'card-issue',
    concept: `${label} (#${conceptId}, ${direction})`,
  });
  window.open(`contact.html?${params.toString()}`, '_blank', 'noopener');
}

// ── Small transient confirmation ────────────────────────────────
function flashToast(message) {
  let el = document.getElementById('ptw-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ptw-toast';
    el.className = 'ptw-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ── Entry points from the manifest and the share sheet ──────────
// Home-screen shortcuts arrive as ?action=..., and text shared from
// another app arrives as ?shared=... on Android.
function handleLaunchParams() {
  const q = new URLSearchParams(location.search);
  const action = q.get('action');
  const shared = q.get('shared') || q.get('title') || q.get('q');

  if (shared) {
    // Use the Quick Lookup overlay for shared text (mobile experience)
    openQuickLookup(shared);
    return;
  }
  if (action === 'search' || action === 'lookup') openQuickLookup();
  if (action === 'review' && typeof openReview === 'function') openReview();
}


/* ================================================================
   MOBILE EXTENSION EXPERIENCE — Quick Lookup
   Share target, clipboard lookup, and bookmarklet integration.
   ================================================================ */

// ── Quick Lookup Overlay ────────────────────────────────────────
function openQuickLookup(text) {
  const overlay = document.getElementById('quick-lookup-overlay');
  const input = document.getElementById('quick-lookup-input');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  if (text) {
    input.value = text;
    runQuickLookup(text);
  } else {
    input.value = '';
    document.getElementById('quick-lookup-results').innerHTML = '';
    // Check clipboard on open if no text provided
    checkClipboardForLookup();
  }

  input.focus();
}

function closeQuickLookup() {
  document.getElementById('quick-lookup-overlay').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('quick-lookup-input').value = '';
  document.getElementById('quick-lookup-results').innerHTML = '';
}

// ── Scan Overlay (Feature 4, narrowed) ──────────────────────────
// OCR reads text from a photo; the extracted text is handed to the exact
// same Quick Lookup pipeline above (searchWords -> gen-dict/JMdict
// fallback), so this feature is never less accurate than typing a word by
// hand. Tesseract.js (on-device OCR, no image ever leaves the browser) is
// lazy-loaded on first use, same "load it only when actually needed"
// pattern already used for the JMdict/gen-dict dictionaries.
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let tesseractLoadPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;
  tesseractLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_CDN;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('Could not load the OCR engine. Check your connection.'));
    document.head.appendChild(s);
  });
  return tesseractLoadPromise;
}

// Maps the current study direction to a Tesseract language code.
//
// French shares Latin script with English, so combining "eng+fra" in one
// worker is safe and lets a scan catch either language. Japanese and Hindi
// do NOT get English combined in: verified directly against this
// project's own test images 2026-09-20 that a combined "eng+jpn" worker
// misread a single, clear kanji character ("水") as the digits/letters
// "7K" -- the two scripts' glyph shapes compete inside one model. The
// SAME image read correctly, every time, as a "jpn"-only worker. Since
// the current study direction already tells us which script to expect,
// there's no need to combine scripts that would only hurt accuracy.
function scanOcrLangs() {
  const dir = (typeof prefDirection === 'string' && prefDirection) || 'JA_EN';
  const other = dir.split('_').find(part => part !== 'EN');
  if (other === 'JA') return 'jpn';
  if (other === 'HI') return 'hin';
  if (other === 'FR') return 'eng+fra';
  return 'eng';
}

function openScanOverlay() {
  document.getElementById('scan-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('scan-status').innerHTML = '';
  document.getElementById('scan-file-input').value = '';
}

function closeScanOverlay() {
  document.getElementById('scan-overlay').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('scan-status').innerHTML = '';
}

async function handleScanFile(file) {
  if (!file) return;
  const statusEl = document.getElementById('scan-status');
  statusEl.innerHTML = '<div class="ql-empty">Loading OCR engine…</div>';

  let Tesseract;
  try {
    Tesseract = await loadTesseract();
  } catch (e) {
    statusEl.innerHTML = `<div class="ql-empty">${e.message}</div>`;
    return;
  }

  statusEl.innerHTML = '<div class="ql-empty">Reading text from photo…</div>';
  const langs = scanOcrLangs();
  let text = '';
  try {
    // Tesseract's default page-segmentation mode (PSM 3, "fully automatic
    // page layout") is tuned for a full document page. A phone photo of a
    // sign/menu/single word is closer to PSM 6, "assume a single uniform
    // block of text" -- verified directly against this project's own test
    // images 2026-09-20: the default mode misread a single large kanji
    // character ("水") as "7K"; PSM 6 read it correctly.
    const worker = await Tesseract.createWorker(langs);
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
    const result = await worker.recognize(file);
    await worker.terminate();
    text = (result && result.data && result.data.text || '').trim();
  } catch (e) {
    statusEl.innerHTML = '<div class="ql-empty">Could not read this photo. Try a clearer, well-lit shot.</div>';
    return;
  }

  if (!text) {
    statusEl.innerHTML = '<div class="ql-empty">No text found in that photo. Try again with the text centered and in focus.</div>';
    return;
  }

  // Collapse OCR line breaks/whitespace into a single lookup string, then
  // hand off to the exact same, already-verified Quick Lookup flow used
  // everywhere else in the app -- nothing about the match/definition step
  // is new or unverified, only the text that seeds it.
  closeScanOverlay();
  openQuickLookup(text.replace(/\s+/g, ' ').trim());
}

// ── Clipboard detection ─────────────────────────────────────────
let clipboardCheckDismissed = false;

async function checkClipboardForLookup() {
  if (clipboardCheckDismissed) return;

  // Only check if the Clipboard API is available and we have focus
  if (!navigator.clipboard || !navigator.clipboard.readText) return;

  try {
    const text = await navigator.clipboard.readText();
    if (!text || text.trim().length === 0) return;

    const trimmed = text.trim();
    // Only show prompt for reasonable-length text
    if (trimmed.length > 100) return;

    // Check if it might be Japanese/useful text
    if (containsLookupableText(trimmed)) {
      showClipboardPrompt(trimmed);
    }
  } catch (e) {
    // Clipboard access denied or not available - fail silently
  }
}

function containsLookupableText(text) {
  // Check for Japanese characters (Hiragana, Katakana, Kanji)
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text);
  // Check for Hindi Devanagari
  const hasHindi = /[\u0900-\u097F]/.test(text);
  // Check for English (simple word pattern)
  const hasEnglish = /^[a-zA-Z\s'-]+$/.test(text);

  return hasJapanese || hasHindi || hasEnglish;
}

function showClipboardPrompt(text) {
  const resultsEl = document.getElementById('quick-lookup-results');
  const preview = text.length > 30 ? text.substring(0, 30) + '…' : text;

  resultsEl.innerHTML = `
    <div class="ql-clipboard-prompt">
      <div class="ql-clipboard-text">
        Look up copied text?<br><strong>${escapeHtml(preview)}</strong>
      </div>
      <button class="ql-clipboard-btn" onclick="useClipboardText('${escapeHtml(text.replace(/'/g, "\\'"))}')">Look up</button>
      <button class="ql-clipboard-dismiss" onclick="dismissClipboardPrompt()" aria-label="Dismiss">✕</button>
    </div>
  `;
}

function useClipboardText(text) {
  const input = document.getElementById('quick-lookup-input');
  input.value = text;
  runQuickLookup(text);
}

function dismissClipboardPrompt() {
  clipboardCheckDismissed = true;
  document.getElementById('quick-lookup-results').innerHTML = `
    <div class="ql-empty">
      <div class="ql-empty-icon">🔍</div>
      Type or paste text to look up
    </div>
  `;
}

// ── Quick Lookup search ─────────────────────────────────────────
async function runQuickLookup(text) {
  const resultsEl = document.getElementById('quick-lookup-results');
  const trimmed = text.trim();

  if (!trimmed) {
    resultsEl.innerHTML = `
      <div class="ql-empty">
        <div class="ql-empty-icon">🔍</div>
        Type or paste text to look up
      </div>
    `;
    return;
  }

  // Loaded before segmentSentence runs so its Japanese tokenizer can
  // recognize a conjugated word (e.g. 行きました) as one token via
  // INFLECTION_WORD_INDEX.ja_kana, the same data runSentenceLookup uses --
  // without this, segmentSentence's longest-match scan only knows
  // dictionary-form SEARCH_INDEX/JMdict entries, falls through to its
  // one-character-at-a-time fallback for anything conjugated, and that
  // fallback can match an unrelated single-kanji homograph for each
  // character (confirmed live: 行きました shredded into き -> 木 "tree" and
  // した -> 舌 "tongue"/下 "down", not just "not found" but actively wrong).
  await loadInflectionWordIndex();
  // runQuickLookup fires on every keystroke; the await above means two
  // rapid keystrokes can now resolve out of order (only matters before the
  // index is cached -- after the first load this await returns immediately).
  // Bail if this input is no longer what's in the box, same stale-response
  // guard already used for the dictionary-fallback fetches elsewhere here.
  const inputEl = document.getElementById('quick-lookup-input');
  if (inputEl && inputEl.value.trim() !== trimmed) return;

  const lang = detectScript(trimmed.toLowerCase());
  const tokens = segmentSentence(trimmed);

  // A single recognized token that IS the whole input keeps today's
  // single-word experience (fuzzy/typo-tolerant curated search, full
  // JMdict longest-prefix fallback) rather than the stricter exact-match
  // tokenization sentences need. Anything that segmented into more than
  // one token -- or into one token that is NOT the full input, which only
  // happens for an unspaced script once real words start being found in
  // it -- goes through the sentence path instead.
  if (tokens.length <= 1 && (tokens.length === 0 || tokens[0] === trimmed)) {
    runSingleWordLookup(trimmed.toLowerCase(), resultsEl);
    return;
  }

  runSentenceLookup(tokens, lang, trimmed, resultsEl);
}

// Tokenizes `text` into every recognized word, in the order it appears.
//
// Hindi, French and English are space-delimited, so splitting on
// whitespace already preserves order and completeness. Japanese has no
// spaces, so recognition has to drive segmentation: the old code treated
// an entire unspaced input as a single query, which fed it straight into
// the single-word dictionary lookup's longest-PREFIX fallback -- built to
// answer "what is the one real word at the START of this string", not
// "list every word in this sentence". That fallback found one match and
// stopped, discarding everything after it (confirmed live: pasting a full
// Japanese sentence returned one short, often-wrong word such as "nu"
// from JMdict/EDICT instead of the sentence's own words in order).
//
// This instead walks the string left to right and, at every position,
// asks "what is the LONGEST recognized word starting here" against both
// the curated 5,000 (SEARCH_INDEX, always available) and JMdict (once the
// full dictionary is loaded) -- takes that whole word, advances past it,
// and repeats for the rest of the string. A position where nothing
// matches (a bare particle, punctuation) is skipped one character at a
// time rather than aborting the scan, so recognizable words later in the
// sentence are still found.
// Whole words the curated 5,000 do not contain, which must still be one
// token. Checked on Jisho/JMdict on 2026-10-16: です is the polite copula
// (be; is). Without this entry the longest-match scan accepts で (concept
// 5318, "at") and then す (2003 vinegar, 3579 den).
const JA_SENTENCE_WORD = {
  'です': {
    reading: 'です',
    pos: 'copula, polite',
    gloss: 'be; is. Polite copula after a noun or na-adjective. After an i-adjective it marks polite speech.',
  },
};

function segmentSentence(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Segmentation strategy depends on whether the TEXT contains Japanese
  // characters, not on detectScript()'s direction-based language guess --
  // detectScript defaults plain Latin text to 'ja' when the study
  // direction isn't French or Hindi (used below in runSentenceLookup to
  // pick a dictionary), which would wrongly route an English sentence
  // through character-by-character segmentation instead of splitting it
  // on spaces like the space-delimited language it actually is.
  const hasJapanese = /[぀-ゟ゠-ヿ一-鿿]/.test(trimmed);
  if (!hasJapanese) {
    return trimmed.split(/\s+/).filter(w => w.length > 0);
  }

  const MAX_WORD_LEN = 10; // longer than any real JMdict/curated headword
  const dictLoaded = !!(window.ptwMobileLookup && window.ptwMobileLookup.isLoaded());
  // Both SEARCH_INDEX and JMdict only know dictionary-form headwords
  // (行く, not 行きました), so without this a conjugated verb's longest
  // recognized "word" was often just its first kanji -- not merely missed,
  // but then re-matched one character at a time against unrelated
  // single-kanji homographs (confirmed live: 行きました -> き matched 木
  // "tree", した matched 舌 "tongue"/下 "down"). INFLECTION_WORD_INDEX.ja_kana
  // is this project's own already-verified conjugation data (see
  // loadInflectionWordIndex), so checking it here lets a conjugated form be
  // recognized and consumed as one token at the tokenization step itself,
  // not just looked up after the fact. May be unset on the very first
  // keystroke race (runQuickLookup awaits the load before calling here, but
  // other callers might not) -- `?.` makes that a silent no-op, not a throw.
  const words = [];
  let i = 0;
  while (i < trimmed.length) {
    let matchedLen = 0;
    const maxLen = Math.min(MAX_WORD_LEN, trimmed.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const candidate = trimmed.slice(i, i + len);
      if (SEARCH_INDEX[candidate]) { matchedLen = len; break; }
      if (JA_SENTENCE_WORD[candidate]) { matchedLen = len; break; }
      if (INFLECTION_WORD_INDEX?.ja_kana?.[candidate]) { matchedLen = len; break; }
      if (dictLoaded && window.ptwMobileLookup.lookupExact(candidate).length > 0) {
        matchedLen = len;
        break;
      }
    }
    if (matchedLen > 0) {
      words.push(trimmed.slice(i, i + matchedLen));
      i += matchedLen;
    } else {
      i += 1;
    }
  }
  return words;
}

function jaFixedWordCard(word) {
  const fixed = JA_SENTENCE_WORD[word];
  if (!fixed) return '';
  return `<div class="ql-result-card">
    <div style="padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border);">
      <span style="font-size: 12px; color: var(--ink-muted);">Results for:</span>
      <span style="font-weight: 600; color: var(--teal-dark); margin-left: 4px;">${escapeHtml(word)}</span>
      <span style="font-size: 10px; color: var(--ink-muted); margin-left: 8px;">(JMdict copula)</span>
    </div>
    ${renderDictListItem({ headword: word, reading: fixed.reading, gloss: [fixed.gloss], pos: fixed.pos })}
  </div>`;
}

function runSingleWordLookup(q, resultsEl) {
  const bareJa = String(q || '').trim().replace(/^[「『]+|[」』。、！？!?\s.]+$/g, '');
  const fixedCard = jaFixedWordCard(bareJa);
  if (fixedCard) {
    resultsEl.innerHTML = fixedCard;
    return;
  }
  // Curated vocabulary first, through the same tiered matcher the Search
  // overlay uses -- exact, then prefix, then substring, then edit distance.
  // This used to run its own unranked scan that stopped at the first 10
  // concepts it reached in object-key order, so a typo found nothing and an
  // exact hit could be crowded out by longer terms that merely contained it.
  // Quick Lookup is the mobile entry point, where text arrives pasted or
  // shared from another app and is the likeliest of all to be imperfect.
  const { results: curatedResults, approximate } = searchWords(q);
  const shown = curatedResults.slice(0, 10);

  if (shown.length > 0) {
    // Show curated results. When every result only matched via the fuzzy
    // edit-distance tier (searchWords' `approximate` flag), say so -- this
    // tier can match a real but unrelated word (e.g. Hindi "platypus"
    // matching "platinum" at 2 edits, confirmed live 2026-10-05), and
    // silently presenting that as a normal, confident result is misleading.
    // The fuzzy tier itself is left untouched: it's genuinely useful for
    // actual typos, so this only adds a label, never removes a match.
    const approxNotice = approximate
      ? '<div class="ql-empty" style="padding:8px 4px;font-size:13px;color:var(--ink-muted);">' +
        'No exact match -- showing the closest approximate match(es).</div>'
      : '';
    if (shown.length === 1) {
      resultsEl.innerHTML = approxNotice + renderQuickLookupCard(shown[0]);
    } else {
      resultsEl.innerHTML = approxNotice + renderQuickLookupList(shown);
    }
    return;
  }

  // No curated results - try the general dictionaries. Japanese goes to
  // JMdict, which has to be downloaded first; Hindi and French go to their
  // own much smaller files, which load on demand. Before these existed, a
  // Hindi or French word outside the curated 5,000 simply returned nothing,
  // while Japanese and English always answered.
  const script = detectScript(q);
  if (script === 'hi' || script === 'fr') {
    ptwLoadGenDict(script).then(dict => {
      const hit = ptwGenDictLookup(script, q, dict);
      resultsEl.innerHTML = hit
        ? renderGenDictResults(script, hit, q)
        : renderNoResultsWithDictOption(q, script);
    });
    resultsEl.innerHTML = '<div class="ql-empty">Looking up…</div>';
    return;
  }

  if (window.ptwMobileLookup && window.ptwMobileLookup.isLoaded()) {
    const dictResults = window.ptwMobileLookup.lookup(q);
    if (dictResults.length > 0) {
      resultsEl.innerHTML = renderDictionaryResults(dictResults, q);
      return;
    }
  }

  // No results - offer to load dictionary
  resultsEl.innerHTML = renderNoResultsWithDictOption(q, 'ja');
}

// ── General dictionaries for Hindi and French ───────────────────────
// The loading and the morphology both live in gen-dict.js, which is shipped
// byte-identical to the extension as lib/gen-dict.js -- one source of truth
// for "which surface forms of this word might be a headword", rather than two
// that drift apart.

// Which dictionary a typed query belongs to. Devanagari is unambiguous. Latin
// text could be English or French, so it only goes to the French dictionary
// when the reading direction says the learner is reading French -- otherwise
// an English word would come back with a French answer.
//
// Found 2026-10-13 (verified live, while testing an unrelated fix): the
// previous version required the ENTIRE string to match
// /^[a-zA-ZÀ-ÿ' -]+$/, so any real sentence containing a period, comma,
// question mark, or other punctuation that whitelist didn't enumerate failed
// the match and fell through to the 'ja' default -- confirmed live:
// "Marie est contente aujourd'hui." detected as 'ja', while the identical
// sentence without the trailing period correctly detected as 'fr'. That in
// turn silently reopened the French/English homograph bug documented
// elsewhere in this file as already fixed (runSentenceLookup's isLatinWord
// field-match filter only applies its French-preferring branch when
// lang==='fr'): "Le pain est bon aujourd'hui." resolved "pain" to the
// English "physical pain" concept instead of French "pain" (bread) --
// confirmed live, for any sentence carrying ordinary end punctuation, i.e.
// nearly all of them. Rewritten to check for the ABSENCE of Japanese
// characters (the same hasJapanese pattern segmentSentence already uses
// elsewhere in this file) and the mere PRESENCE of a Latin letter, instead
// of requiring the whole string to match an enumerated punctuation
// whitelist -- so a comma, question mark, em dash, or anything else nobody
// thought to list no longer breaks it.
function detectScript(q) {
  if (/[\u0900-\u097f]/.test(q)) return 'hi';
  const activeDir = (currentDirection || prefDirection || 'JA_EN').toUpperCase();
  const hasJapaneseChars = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(q);
  if (!hasJapaneseChars && /[a-zA-ZÀ-ÿ]/.test(q)) {
    if (activeDir.startsWith('FR')) return 'fr';
    if (activeDir.startsWith('HI')) return 'hi';
  }
  return 'ja';
}

function renderGenDictResults(lang, hit, query) {
  // Not one of Shabdah's own 5,000 curated, AI-generated concepts -- this is
  // the general-dictionary fallback for everything outside that set, so the
  // source line links straight to the actual human-vetted source rather than
  // just naming it (see sources-and-licenses.html §6).
  const source = lang === 'hi'
    ? 'Not one of this 100-concept demo\'s curated concepts'
    : 'Not one of this 100-concept demo\'s curated concepts';
  const cards = hit.entries.slice(0, 6).map(e => {
    const glossText = Array.isArray(e.gloss) ? e.gloss.slice(0, 4).join('; ') : e.gloss;
    return `
      <div class="ql-dict-card">
        <div class="ql-dict-header">
          <span class="ql-dict-word">${escapeHtml(hit.matched)}</span>
          ${e.pos ? `<span class="ql-dict-pos">${escapeHtml(formatPOS(e.pos))}</span>` : ''}
        </div>
        <div class="ql-dict-gloss">${escapeHtml(glossText)}</div>
        ${e.def ? `<div class="ql-dict-def">${escapeHtml(e.def)}</div>` : ''}
        ${e.ex ? `<div class="ql-dict-def">${escapeHtml(e.ex)}</div>` : ''}
      </div>`;
  }).join('');
  return `
    <div class="ql-dict-results">
      <div class="ql-dict-header-bar"><span class="ql-dict-source">${source}</span></div>
      ${cards}
    </div>`;
}

// Render dictionary results (from full JMdict)
function renderDictionaryResults(results, query) {
  const cards = results.slice(0, 8).map(r => {
    const glossText = Array.isArray(r.gloss) ? r.gloss.slice(0, 3).join('; ') : r.gloss;
    const posLabel = formatPOS(r.pos);

    return `
      <div class="ql-dict-card">
        <div class="ql-dict-header">
          <span class="ql-dict-word">${escapeHtml(r.headword)}</span>
          ${r.reading && r.reading !== r.headword ?
            `<span class="ql-dict-reading">${escapeHtml(r.reading)}</span>` : ''}
          ${posLabel ? `<span class="ql-dict-pos">${posLabel}</span>` : ''}
        </div>
        <div class="ql-dict-gloss">${escapeHtml(glossText)}</div>
        <div class="ql-dict-actions">
          <button class="ql-audio-btn" onclick="speakJa('${escapeHtml(r.reading || r.headword)}')">🔊</button>
        </div>
      </div>
    `;
  }).join('');

  const moreCount = results.length > 8 ? results.length - 8 : 0;

  return `
    <div class="ql-dict-results">
      <div class="ql-dict-header-bar">
        <span class="ql-dict-source">Not one of Shabdah's 5,000 curated concepts &mdash; from
          <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" target="_blank" rel="noopener">JMdict/EDICT</a> (285k words)</span>
      </div>
      ${cards}
      ${moreCount > 0 ? `<div class="ql-dict-more">+${moreCount} more results</div>` : ''}
    </div>
  `;
}

function formatPOS(pos) {
  if (!pos) return '';
  const posMap = {
    'n': 'noun', 'v1': 'verb (ichidan)', 'v5': 'verb (godan)',
    'adj-i': 'i-adj', 'adj-na': 'na-adj', 'adv': 'adverb',
    'exp': 'expression', 'int': 'interjection', 'prt': 'particle',
  };
  return posMap[pos] || pos;
}

// Direct, pre-filled search links to a real external dictionary for the
// rare word that isn't in the curated 5,000 OR either bundled dictionary --
// verified live (not guessed) before being hardcoded here: each URL was
// loaded and checked to actually return real content for a test word, not
// an empty search or a static project homepage.
//   ja -> Jisho.org, the working JMdict/EDICT lookup (not the EDRDG project
//         homepage, which has no per-word search).
//   fr -> WordReference en-fr. WOLF (this project's own bundled French
//         dictionary source) has no public per-word web page to link to, so
//         this is the French-English dictionary that does return the word,
//         per the "if WOLF has no per-word page, use one that works" rule --
//         confirmed live for "apple" and others.
//   hi -> HinKhoj's ShabdKhoj (dict.hinkhoj.com), NOT Google Translate. Its
//         own about-page states it "uses Shabdanjali V 1.0" -- the same
//         source as this project's own bundled Hindi dictionary (FreeDict
//         eng-hin) -- confirmed live for "thrive" and "xylophone" returning
//         real, multi-sense Hindi content before shipping this URL.
function externalDictLink(lang, query) {
  const q = encodeURIComponent(query);
  if (lang === 'ja') return { url: `https://jisho.org/search/${q}`, label: 'Look up on Jisho.org' };
  if (lang === 'fr') return { url: `https://www.wordreference.com/fren/${q}`, label: 'Look up on WordReference' };
  if (lang === 'hi') return { url: `https://dict.hinkhoj.com/shabdkhoj.php?lang=en&word=${q}`, label: 'Look up on ShabdKhoj (Shabdanjali)' };
  return null;
}

function renderNoResultsWithDictOption(query, lang) {
  // Hindi/French queries that reach here already tried their own (much
  // smaller) general dictionary via ptwLoadGenDict and found nothing -- there
  // is no separate "full" dictionary to offer them. Previously this always
  // showed the Japanese "Load Full Dictionary (285k words)" button regardless
  // of query language, which downloaded 8MB of unrelated JMdict data and then
  // re-ran the same Hindi/French query against it, which can never match
  // (confirmed live, 2026-10-05: a Hindi query with no curated or FreeDict
  // match offered to load the Japanese dictionary).
  const extLink = externalDictLink(lang, query);
  const extLinkHtml = extLink
    ? `<a class="ql-action-btn ql-action-secondary" style="display:inline-block; margin-top:10px; text-decoration:none;" href="${extLink.url}" target="_blank" rel="noopener">${extLink.label} &#8599;</a>`
    : '';

  if (lang === 'hi' || lang === 'fr') {
    return `
      <div class="ql-empty">
        <div class="ql-empty-icon">🤷</div>
        No matches found for "${escapeHtml(query)}"<br>
        <small style="color: var(--ink-muted);">Not in Shabdah's curated vocabulary or its bundled dictionary.</small><br>
        ${extLinkHtml}
      </div>
    `;
  }

  const dictStatus = window.ptwMobileLookup ? window.ptwMobileLookup.getStatus() : 'not-loaded';

  if (dictStatus === 'loaded') {
    return `
      <div class="ql-empty">
        <div class="ql-empty-icon">🤷</div>
        No matches found for "${escapeHtml(query)}"<br>
        <small style="color: var(--ink-muted);">Not in Shabdah's curated vocabulary or its bundled dictionary (285k words).</small><br>
        ${extLinkHtml}
      </div>
    `;
  }

  if (dictStatus === 'loading') {
    return `
      <div class="ql-empty">
        <div class="ql-empty-icon">⏳</div>
        <div id="ql-dict-loading-status">Loading dictionary...</div>
      </div>
    `;
  }

  // Dictionary not loaded - offer to load it
  return `
    <div class="ql-empty">
      <div class="ql-empty-icon">📚</div>
      Not in this 100-concept demo<br><br>
      <button class="ql-action-btn ql-action-primary" onclick="loadDictionaryAndRetry('${escapeHtml(query.replace(/'/g, "\\'"))}')">
        Load Full Dictionary (285k words)
      </button>
      <div style="margin-top: 12px; font-size: 12px; color: var(--ink-muted);">
        ~8MB download, cached for offline use
      </div>
      ${extLinkHtml}
    </div>
  `;
}

async function loadDictionaryAndRetry(query) {
  const resultsEl = document.getElementById('quick-lookup-results');

  if (!window.ptwMobileLookup) {
    resultsEl.innerHTML = `
      <div class="ql-empty">
        <div class="ql-empty-icon">❌</div>
        Dictionary module not available
      </div>
    `;
    return;
  }

  resultsEl.innerHTML = `
    <div class="ql-empty">
      <div class="ql-empty-icon">⏳</div>
      <div id="ql-dict-loading-status">Initializing...</div>
    </div>
  `;

  try {
    await window.ptwMobileLookup.load((status) => {
      const statusEl = document.getElementById('ql-dict-loading-status');
      if (statusEl) statusEl.textContent = status;
    });

    // Retry the lookup
    runSingleWordLookup(query.toLowerCase(), resultsEl);
  } catch (e) {
    resultsEl.innerHTML = `
      <div class="ql-empty">
        <div class="ql-empty-icon">❌</div>
        Failed to load dictionary<br>
        <small style="color: var(--ink-muted);">${escapeHtml(e.message)}</small>
      </div>
    `;
  }
}

// Looks up every token from segmentSentence(), IN ORDER, and renders them
// as one continuous sequence -- replacing the old runMultiWordLookup,
// which (a) only ever ran for already-space-split text, so an unspaced
// Japanese sentence never reached it at all, and (b) even for
// space-delimited text, sent every non-curated word to
// window.ptwMobileLookup (the JAPANESE dictionary) regardless of the
// sentence's actual language -- so a Hindi or French word outside the
// curated 5,000 was checked against JMdict, could never match, and was
// reported as "no results" even when FreeDict/WOLF had a real entry for
// it. This instead sends each token to the dictionary that matches
// `lang`, and keeps every entry (all senses -- V1, V2, V3, ...) a
// fallback headword returns instead of trimming to the first few.
// The curated 5,000 index keys words by their dictionary/base form ("work"),
// not inflected forms ("works", "worked", "working"). A sentence typed in
// natural English is full of inflected forms, so an exact-match-only lookup
// silently drops words that have a perfectly good curated entry one suffix
// away -- e.g. "he works at the hospital" never finding "work" (CID 34).
// Returns candidate base forms in order of likeliness, not a guess at the
// one true lemma -- the caller still needs an actual SEARCH_INDEX hit to
// accept any of them, so an accidental real word ("bus" from stripping
// "buss") is harmless: it only matches if it's independently a real entry.
// Suffix rules alone miss every irregular verb ("ate" is not "eat" plus a
// suffix), and those are exactly the highest-frequency verbs in ordinary
// English sentences. Covers the common irregulars likeliest to appear in a
// sentence someone actually types, mapped past-tense -> base form; past
// participles that differ from the simple past (seen, gone, done, ...) are
// included too since a token to look up could be either.
const IRREGULAR_VERB_BASE = {
  was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
  had: 'have', has: 'have',
  did: 'do', does: 'do', done: 'do',
  went: 'go', gone: 'go', goes: 'go',
  ate: 'eat', eaten: 'eat',
  saw: 'see', seen: 'see',
  came: 'come',
  took: 'take', taken: 'take',
  gave: 'give', given: 'give',
  made: 'make',
  knew: 'know', known: 'know',
  thought: 'think',
  told: 'tell',
  became: 'become',
  left: 'leave',
  felt: 'feel',
  brought: 'bring',
  began: 'begin', begun: 'begin',
  kept: 'keep',
  held: 'hold',
  wrote: 'write', written: 'write',
  stood: 'stand',
  heard: 'hear',
  meant: 'mean',
  met: 'meet',
  paid: 'pay',
  sat: 'sit',
  spoke: 'speak', spoken: 'speak',
  lay: 'lie', lain: 'lie',
  led: 'lead',
  grew: 'grow', grown: 'grow',
  lost: 'lose',
  sent: 'send',
  built: 'build',
  drew: 'draw', drawn: 'draw',
  broke: 'break', broken: 'break',
  spent: 'spend',
  woke: 'wake', woken: 'wake',
  slept: 'sleep',
  taught: 'teach',
  fell: 'fall', fallen: 'fall',
  caught: 'catch',
  rode: 'ride', ridden: 'ride',
  shot: 'shoot',
  flew: 'fly', flown: 'fly',
  hid: 'hide', hidden: 'hide',
  drove: 'drive', driven: 'drive',
  chose: 'choose', chosen: 'choose',
  bought: 'buy',
  found: 'find',
  got: 'get', gotten: 'get',
  said: 'say',
  ran: 'run',
  sang: 'sing', sung: 'sing',
  swam: 'swim', swum: 'swim',
  rang: 'ring', rung: 'ring',
  drank: 'drink', drunk: 'drink',
  threw: 'throw', thrown: 'throw',
  understood: 'understand',
  wore: 'wear', worn: 'wear',
  sold: 'sell',
  stole: 'steal', stolen: 'steal',
  shook: 'shake', shaken: 'shake',
  forgot: 'forget', forgotten: 'forget',
};

// Hindi/French/Japanese equivalent of the English stemmer above, but built
// from the project's own already-verified inflection-table data instead of
// hand-written rules (see tools/build_inflection_word_index.py) -- a
// conjugated/inflected word ("jaata"/"jaataa", "va", "itta") maps straight
// to the base concept(s) it belongs to. Loaded lazily, once, same pattern
// as ptwLoadGenDict in gen-dict.js.
let INFLECTION_WORD_INDEX = null;
let inflectionWordIndexLoading = null;
async function loadInflectionWordIndex() {
  if (INFLECTION_WORD_INDEX) return INFLECTION_WORD_INDEX;
  if (inflectionWordIndexLoading) return inflectionWordIndexLoading;
  inflectionWordIndexLoading = (async () => {
    try {
      const res = await fetch('data/inflection_word_index.json');
      INFLECTION_WORD_INDEX = await res.json();
    } catch (err) {
      console.error('Inflection word index load failed:', err);
      INFLECTION_WORD_INDEX = { hi: {}, fr: {}, ja_romaji: {}, ja_kana: {} };
    }
    return INFLECTION_WORD_INDEX;
  })();
  return inflectionWordIndexLoading;
}

function englishStemCandidates(word) {
  const candidates = [];
  if (IRREGULAR_VERB_BASE[word]) candidates.push(IRREGULAR_VERB_BASE[word]);
  if (word.length > 4 && word.endsWith('ies')) candidates.push(word.slice(0, -3) + 'y');
  if (word.length > 4 && word.endsWith('ing')) {
    candidates.push(word.slice(0, -3));
    candidates.push(word.slice(0, -3) + 'e');
  }
  if (word.length > 3 && word.endsWith('es')) candidates.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('ed')) {
    candidates.push(word.slice(0, -2));
    candidates.push(word.slice(0, -1));
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) candidates.push(word.slice(0, -1));
  return candidates;
}

// A tiny, explicit whitelist of extremely high-frequency grammatical word
// forms that happen to be the exact headword of an unrelated curated
// concept. French "est" ("is" -- 3rd person singular present of the verb
// "être") is the curated headword for concept 828 "east" (labels.fr ===
// "est"). There is nowhere else in the project's data to resolve "est" to
// "être" instead: it was excluded from inflection_word_index.json by the
// generic-helper filter because it appears in the french_inflection_forms of
// 583/583 French-verb concepts (the auxiliary inside compound tenses like
// "il EST allé"), which identifies no single concept at all, and the
// licensed WOLF/Princeton WordNet dictionary (data/fr-dictionary.json) is
// keyed by the lemma "être", not the conjugated surface form "est", so it
// never surfaces there either. Confirmed live (2026-10-13): a sentence
// lookup on "est" showed only "east", with nothing indicating this is also
// a common grammatical word. Hardcoded here, the same way ptwFrVariants
// already hardcodes irregular French morphology elsewhere in the project,
// since "est" doesn't follow a regular suffix pattern a rule could derive.
const SENTENCE_GRAMMAR_NOTES = {
  fr: {
    'est': '"est" is also the verb form "is" -- 3rd-person-singular present of être (to be). Not one of this 100-concept demo\'s curated concepts.',
  },
};

// Orders curated hits for one token using only checks that are true of the
// sentence in hand. Exact headword match outranks a shared inflection or
// homograph. In Japanese, を / が / に / へ / と / の / から / まで mark a
// nominal, so a verb that merely shares the surface loses to a noun, and
// な after the token prefers a na-adjective. Ties keep the previous order.
// This does not choose among two real senses of the same headword.
function orderConceptsBySentence(token, nextToken, concepts, lang) {
  const nominalNext = new Set(['を', 'が', 'に', 'へ', 'と', 'の', 'から', 'まで']);
  const verbClass = new Set(['godan', 'ichidan', 'suru', 'kuru']);
  function score(c) {
    const labels = c.labels || {};
    let s = 0;
    if (lang === 'ja') {
      const ja = labels.ja || '';
      if (ja === token) s += 100;
      if ((c.inflection_forms || []).some(f => f.ja === token || f.kana === token)) s += 40;
      const cls = (c.inflections && c.inflections.class) || '';
      if (nominalNext.has(nextToken)) {
        if (verbClass.has(cls) && ja !== token) s -= 30;
        if (!verbClass.has(cls)) s += 10;
      }
      if (nextToken === 'な' && cls === 'na_adj') s += 20;
    } else if (lang === 'fr') {
      if ((labels.fr || '').toLowerCase() === String(token).toLowerCase()) s += 100;
    } else if (lang === 'hi') {
      const q = String(token).toLowerCase();
      if (labels.hi === token || (labels.hi_romanized || '').toLowerCase() === q) s += 100;
    } else {
      const en = (labels.en || '').toLowerCase();
      const q = String(token).toLowerCase();
      if (en === q || en === `to ${q}`) s += 100;
    }
    return s;
  }
  return concepts
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(row => row.c);
}

async function runSentenceLookup(tokens, lang, originalText, resultsEl) {
  resultsEl.innerHTML = '<div class="ql-empty">Looking up…</div>';

  const items = [];        // ordered: { word, kind: 'curated'|'dictionary', data }
  const notFoundWords = [];
  let genDict = null;
  if (lang === 'hi' || lang === 'fr') {
    genDict = await ptwLoadGenDict(lang);
  }
  const inflectionIndex = await loadInflectionWordIndex();

  for (let ti = 0; ti < tokens.length; ti++) {
    const word = tokens[ti];
    const nextToken = tokens[ti + 1] || '';
    const fixed = lang === 'ja' ? JA_SENTENCE_WORD[word] : null;
    if (fixed) {
      items.push({
        word,
        kind: 'dictionary',
        data: {
          headword: word,
          lang: 'ja',
          entries: [{ reading: fixed.reading, gloss: [fixed.gloss], pos: fixed.pos }],
        },
      });
      continue;
    }
    const q = word.toLowerCase();

    // Curated 5,000 first, exact term match -- the same SEARCH_INDEX key
    // segmentSentence() just used to recognize this token as a word, so
    // this is guaranteed to hit for any token segmentSentence found via
    // the curated path.
    //
    // SEARCH_INDEX is a single flat key->conceptIds map built across every
    // language's fields, so a plain-Latin word can collide with an
    // unrelated language's homograph -- e.g. "an" is both the English
    // article (CID 5356) and the French word for "year" (CID 865,
    // labels.fr === "an"). That ambiguity is fine for the general search
    // box (showing every script's match for a typed string is the point),
    // but wrong mid-sentence: a sentence typed in one language shouldn't
    // surface another language's unrelated homograph.
    //
    // This has to be LANGUAGE-aware, not just script-aware: an earlier
    // version of this fix gated on "is the token plain Latin script" and
    // always preferred the English gloss, which is right for an English
    // sentence defaulting to lang='ja' (no Japanese equivalent in Latin
    // script) but wrong for lang='fr' -- French has plenty of unaccented,
    // plain-Latin words of its own (un, le, pain, chat, ...), and
    // preferring English for those actively broke them: French "pain"
    // (bread, CID 306, labels.fr="pain") was getting overridden by the
    // unrelated English "pain" (CID 2217, labels.en="pain") instead of
    // being left alone, and same for "chat" (cat, CID 120) vs. English
    // "chat" (CID 2286). Confirmed in the data before fixing, not guessed.
    // The English-stemming fallback has the same problem for a different
    // reason: French/Hindi morphology doesn't follow English suffix rules,
    // so stripping a French plural "s" on the assumption it's an English
    // one risks landing on an unrelated real word. Both are now scoped to
    // only fire for lang==='ja' (the actual English-sentence case), with a
    // parallel, lang-appropriate preference for fr/hi instead of English.
    let conceptIds = SEARCH_INDEX[q] || [];
    let matchedKey = q;
    const isLatinWord = /^[a-zA-Z'-]+$/.test(q);
    if (conceptIds.length === 0 && isLatinWord && lang === 'ja') {
      for (const stem of englishStemCandidates(q)) {
        if (SEARCH_INDEX[stem]) { conceptIds = SEARCH_INDEX[stem]; matchedKey = stem; break; }
      }
    }
    if (isLatinWord) {
      const fieldMatches = conceptIds.filter(id => {
        const c = CARDS.find(c => c.concept_id === String(id));
        if (!c) return false;
        if (lang === 'fr') return (c.labels.fr || '').toLowerCase() === matchedKey;
        if (lang === 'hi') return (c.hindi_romanized || c.labels.hi_romanized || '').toLowerCase() === matchedKey;
        const en = (c.labels.en || '').toLowerCase();
        return en === matchedKey || en === `to ${matchedKey}`;
      });
      if (fieldMatches.length > 0) conceptIds = fieldMatches;
    }
    let curatedResults = orderConceptsBySentence(
      word,
      nextToken,
      conceptIds
        .map(id => CARDS.find(c => c.concept_id === String(id)))
        .filter(Boolean),
      lang
    ).slice(0, 2);

    // Still nothing? The curated 5,000 index only keys the dictionary/lemma
    // form (SEARCH_INDEX has "jaana", not "jaataa"); a conjugated/inflected
    // word one step away from its lemma has its own entry in this project's
    // already-verified inflection tables (hindi_inflection_forms,
    // french_inflection_forms, inflection_forms for Japanese), built into
    // inflection_word_index.json by tools/build_inflection_word_index.py --
    // deterministic, not a model guess, since the underlying conjugations
    // were already human-verified content. This is the hi/fr/ja counterpart
    // to the English stemmer above.
    if (curatedResults.length === 0) {
      let inflIds = null;
      if (lang === 'hi') inflIds = inflectionIndex.hi?.[q];
      else if (lang === 'fr') inflIds = inflectionIndex.fr?.[q];
      else if (lang === 'ja') inflIds = inflectionIndex.ja_romaji?.[q] || inflectionIndex.ja_kana?.[q];
      if (inflIds && inflIds.length > 0) {
        curatedResults = inflIds.slice(0, 2)
          .map(id => CARDS.find(c => c.concept_id === String(id)))
          .filter(Boolean);
      }
    }

    if (curatedResults.length > 0) {
      const grammarNote = SENTENCE_GRAMMAR_NOTES[lang]?.[q];
      items.push({ word, kind: 'curated', data: curatedResults, grammarNote });
      continue;
    }

    // Not curated -- fall back to the dictionary for THIS sentence's
    // language, never a different one.
    if (lang === 'hi' || lang === 'fr') {
      const hit = genDict ? ptwGenDictLookup(lang, word, genDict) : null;
      if (hit) {
        items.push({ word, kind: 'dictionary', data: { headword: hit.matched, entries: hit.entries, lang } });
        continue;
      }
    } else if (window.ptwMobileLookup && window.ptwMobileLookup.isLoaded()) {
      const dictResults = window.ptwMobileLookup.lookupExact(word);
      if (dictResults.length > 0) {
        items.push({ word, kind: 'dictionary', data: { headword: word, entries: dictResults, lang: 'ja' } });
        continue;
      }
    }

    notFoundWords.push(word);
  }

  resultsEl.innerHTML = renderSentenceResults(items, notFoundWords, lang, originalText);
}

// Renders the ordered curated/dictionary results from runSentenceLookup().
// Every item keeps its position in the sentence; a dictionary item shows
// every sense its headword has (V1, V2, V3, ...), not just the first few.
function renderSentenceResults(items, notFoundWords, lang, originalText) {
  if (items.length === 0 && notFoundWords.length === 0) {
    return renderNoResultsWithDictOption(originalText, lang === 'hi' || lang === 'fr' ? lang : 'ja');
  }

  let html = '';
  for (const { word, kind, data, grammarNote } of items) {
    if (kind === 'curated') {
      html += `<div class="ql-result-card">
        <div style="padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border);">
          <span style="font-size: 12px; color: var(--ink-muted);">Results for:</span>
          <span style="font-weight: 600; color: var(--teal-dark); margin-left: 4px;">${escapeHtml(word)}</span>
        </div>
        ${data.map(c => renderQuickLookupListItem(c)).join('')}
        ${grammarNote ? `<div style="padding: 8px 14px; font-size: 12px; color: var(--ink-muted); border-top: 1px solid var(--border);">${escapeHtml(grammarNote)}</div>` : ''}
      </div>`;
    } else {
      const sourceLabel = data.lang === 'ja'
        ? 'dictionary -- JMdict/EDICT'
        : (data.lang === 'hi' ? 'dictionary -- FreeDict (Shabdanjali)' : 'dictionary -- WOLF/WordNet');
      html += `<div class="ql-result-card">
        <div style="padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--border);">
          <span style="font-size: 12px; color: var(--ink-muted);">Results for:</span>
          <span style="font-weight: 600; color: var(--teal-dark); margin-left: 4px;">${escapeHtml(word)}</span>
          <span style="font-size: 10px; color: var(--ink-muted); margin-left: 8px;">(${sourceLabel})</span>
        </div>
        ${data.entries.map(e => renderDictListItem({
          headword: data.headword,
          reading: e.reading || data.headword,
          gloss: e.gloss || (e.def ? [e.def] : []),
          pos: e.pos || '',
        })).join('')}
      </div>`;
    }
  }

  if (notFoundWords.length > 0) {
    const showLoadBtn = lang === 'ja' && !(window.ptwMobileLookup && window.ptwMobileLookup.isLoaded());
    const extLinks = notFoundWords.map(w => {
      const link = externalDictLink(lang, w);
      return link ? `<a href="${link.url}" target="_blank" rel="noopener" style="margin: 0 4px;">${escapeHtml(w)} &#8599;</a>` : escapeHtml(w);
    }).join(', ');
    html += `<div style="padding: 12px; font-size: 13px; color: var(--ink-muted); text-align: center;">
      No results for: ${extLinks}
      ${showLoadBtn ? `<br><br>
        <button class="ql-action-btn ql-action-primary" onclick="loadDictionaryAndRetrySentence('${escapeHtml(originalText.replace(/'/g, "\\'"))}')">
          Load Full Dictionary (285k words) for better coverage
        </button>` : ''}
    </div>`;
  }

  return html;
}

async function loadDictionaryAndRetrySentence(text) {
  const resultsEl = document.getElementById('quick-lookup-results');
  if (!window.ptwMobileLookup) return;

  resultsEl.innerHTML = `
    <div class="ql-empty">
      <div class="ql-empty-icon">⏳</div>
      <div id="ql-dict-loading-status">Initializing...</div>
    </div>
  `;

  try {
    await window.ptwMobileLookup.load((status) => {
      const statusEl = document.getElementById('ql-dict-loading-status');
      if (statusEl) statusEl.textContent = status;
    });
    runQuickLookup(text);
  } catch (e) {
    resultsEl.innerHTML = `
      <div class="ql-empty">
        <div class="ql-empty-icon">❌</div>
        Failed to load dictionary<br>
        <small style="color: var(--ink-muted);">${escapeHtml(e.message)}</small>
      </div>
    `;
  }
}

// Render a single dictionary entry in a list
function renderDictListItem(entry) {
  const glossText = Array.isArray(entry.gloss) ? entry.gloss.slice(0, 2).join('; ') : entry.gloss;
  return `
    <div class="ql-multi-word" onclick="speakJa('${escapeHtml(entry.reading || entry.headword)}')">
      <div class="ql-dict-mini-icon">📖</div>
      <div class="ql-multi-info">
        <div class="ql-multi-ja">${escapeHtml(entry.headword)}</div>
        <div class="ql-multi-en">${escapeHtml(glossText)}</div>
      </div>
      <span class="ql-multi-cat">🔊</span>
    </div>
  `;
}

function renderQuickLookupCard(concept) {
  const activeDir = (currentDirection || prefDirection || 'JA_EN').toUpperCase();
  const dir = (concept.directions && concept.directions[activeDir]) ? activeDir : firstAvailableDirection(concept);
  const d = concept.directions && concept.directions[dir];
  const cat = CATEGORIES.find(c => c.id === concept.category_id);
  const catColor = cat?.color || 'var(--teal)';

  let targetLabel = '';
  let targetLang = 'ja';
  let reading = '';
  if (dir.startsWith('HI')) {
    targetLabel = (concept.labels && concept.labels.hi) || '';
    targetLang = 'hi';
    reading = concept.hindi_romanized || '';
  } else if (dir.startsWith('FR')) {
    targetLabel = (concept.labels && concept.labels.fr) || concept.french || '';
    targetLang = 'fr';
    reading = concept.ipa || '';
  } else {
    targetLabel = (concept.labels && concept.labels.ja) || '';
    targetLang = 'ja';
    reading = concept.kana || concept.romaji || '';
  }
  const enLabel = concept.english || (concept.labels && concept.labels.en) || '';

  return `
    <div class="ql-result-card">
      <div class="ql-result-header" onclick="qlOpenConcept('${concept.concept_id}')">
        <img class="ql-result-thumb" src="${d?.image_url || ''}" alt="${enLabel}" loading="lazy">
        <div class="ql-result-info">
          <div class="ql-result-word">${escapeHtml(targetLabel || enLabel)}</div>
          ${reading ? `<div class="ql-result-reading">${escapeHtml(reading)}</div>` : ''}
          <div class="ql-result-meaning">${escapeHtml(targetLabel ? enLabel : '')}</div>
          <span class="ql-result-category" style="background: ${catColor}22; color: ${catColor};">
            ${cat?.label || ''}
          </span>
        </div>
      </div>
      ${d ? `
      <div class="ql-audio-row">
        <button class="ql-audio-btn" onclick="playAudio('${d.header_audio_url || ''}', '${(targetLabel || '').replace(/'/g, "\\'")}', '${targetLang}')">🔊 Word</button>
        <button class="ql-audio-btn" onclick="playAudio('${d.footer_audio_url || ''}', '${enLabel.replace(/'/g, "\\'")}', 'en')">🔊 Meaning</button>
      </div>
      ` : ''}
      <div class="ql-result-actions">
        <button class="ql-action-btn ql-action-primary" onclick="qlAddToReview('${concept.concept_id}', '${dir}')">
          + Add to Review
        </button>
        <button class="ql-action-btn ql-action-secondary" onclick="qlOpenConcept('${concept.concept_id}')">
          View Card
        </button>
      </div>
    </div>
  `;
}

function renderQuickLookupList(results) {
  return `
    <div class="ql-multi-results">
      ${results.map(c => renderQuickLookupListItem(c)).join('')}
    </div>
  `;
}

function renderQuickLookupListItem(concept) {
  const activeDir = (currentDirection || prefDirection || 'JA_EN').toUpperCase();
  const dir = (concept.directions && concept.directions[activeDir]) ? activeDir : firstAvailableDirection(concept);
  const d = concept.directions && concept.directions[dir];
  const cat = CATEGORIES.find(c => c.id === concept.category_id);

  let targetLabel = '';
  if (dir.startsWith('HI')) {
    targetLabel = (concept.labels && concept.labels.hi) || '';
  } else if (dir.startsWith('FR')) {
    targetLabel = (concept.labels && concept.labels.fr) || concept.french || '';
  } else {
    targetLabel = (concept.labels && concept.labels.ja) || '';
  }
  const enLabel = concept.english || (concept.labels && concept.labels.en) || '';

  return `
    <div class="ql-multi-word" onclick="qlShowSingleResult('${concept.concept_id}')">
      <img class="ql-multi-thumb" src="${d?.image_url || ''}" alt="${enLabel}" loading="lazy">
      <div class="ql-multi-info">
        <div class="ql-multi-ja">${escapeHtml(targetLabel || enLabel)}</div>
        <div class="ql-multi-en">${escapeHtml(targetLabel ? enLabel : '')}</div>
      </div>
      <span class="ql-multi-cat">${cat?.label || ''}</span>
    </div>
  `;
}

function qlShowSingleResult(conceptId) {
  const concept = CARDS.find(c => c.concept_id === conceptId);
  if (!concept) return;
  document.getElementById('quick-lookup-results').innerHTML = renderQuickLookupCard(concept);
}

function qlOpenConcept(conceptId) {
  closeQuickLookup();
  const concept = CARDS.find(c => c.concept_id === conceptId);
  if (!concept) return;
  openCategory(concept.category_id);
  setTimeout(() => openConcept(conceptId), 150);
}

function qlAddToReview(conceptId, direction) {
  if (typeof toggleReview === 'function') {
    toggleReview(conceptId, direction);
    flashToast('Added to Review');
  } else {
    flashToast('Sign in to save cards');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Keyboard shortcut for Quick Lookup ──────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl/Cmd + Shift + L opens Quick Lookup
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    openQuickLookup();
    return;
  }
  // Escape closes Quick Lookup
  if (e.key === 'Escape' && document.getElementById('quick-lookup-overlay').classList.contains('open')) {
    closeQuickLookup();
  }
});


/* ================================================================
   v4.4 — alphabetical browsing, related words, inflected forms
   ================================================================ */

// Sort key follows the direction being studied: an English speaker
// browsing Japanese scans by the English word, a Japanese speaker
// browsing English scans by the Japanese reading.
function sortConcepts(list) {
  // 2026-09-16 scope trim: EN_JA (the only direction that sorted by the
  // Japanese reading instead of the English label) no longer exists, so
  // this always sorts by sort_en now.
  return list.slice().sort((a, b) => {
    const ka = a.sort_en || '';
    const kb = b.sort_en || '';
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

// Every related word is shown. Ones with their own flashcard are tappable
// and jump straight to it; ones without are plain text with audio, because
// the point is the network of connected words, and the missing cards are
// being drawn. A cardless chip must never call jumpToConcept() - there is
// nothing to jump to, and passing null would land on a blank card.
//
// Two schemas coexist here on purpose. The v4.4 schema (flat: english/
// kanji/kana/katakana_en, one relation, JA/EN only) is still what most of
// the ~82 populated concepts use, and rewriting every one of those by hand
// is its own separate, ongoing effort (see TODO.md) -- breaking them while
// shipping the new schema would be a regression, not a bug fix. The v5
// schema (nested per-language en/ja/hi/fr objects, each with its own
// `meanings` array, plus a `type` of "word" or "phrase") is additive: it
// carries all 4 languages, up to 3 meanings per language, and a real
// generated-audio path for entries with no flashcard of their own, so the
// audio button never silently depends on speech-synthesis language support.
function renderRelatedWords(concept) {
  const rel = concept.related || [];
  if (!rel.length) return '';
  const RELATION_LABEL = {
    synonym: 'similar meaning', antonym: 'opposite', associated: 'related',
    // legacy v4.4 relation values, kept for the un-migrated entries:
    kind_of: 'a kind of', type_of: 'includes', part_of: 'related part',
    similar: 'same group',
  };
  const [langA, langB] = (currentDirection || prefDirection || 'JA_EN').split('_')
    .map(l => l.toLowerCase());

  const ownHeadword = (concept.labels && concept.labels[langA]) || '';
  const chips = rel.map(r => {
    const title = RELATION_LABEL[r.relation] || 'related';
    // v5 schema: has nested per-language objects.
    if (r.en && typeof r.en === 'object') {
      return renderRelatedWordV5(r, title, langA, langB, ownHeadword);
    }
    // v4.4 schema: flat JA/EN fields only.
    const ja = r.kanji || r.kana || '';
    const en = r.english || '';
    if (r.concept_id) {
      return `
    <span class="rel-chip" onclick="event.stopPropagation(); jumpToConcept('${r.concept_id}')"
          title="${title}">
      <span class="rel-chip-ja">${ja}</span>
      <span class="rel-chip-en">${en}</span>
    </span>`;
    }
    // No card yet: readable and speakable, but not a link.
    return `
    <span class="rel-chip rel-chip-nocard" title="${title} - flashcard coming soon">
      <span class="rel-chip-ja">${ja}</span>
      <span class="rel-chip-en">${en}</span>
      <button class="rel-chip-audio" aria-label="Play ${ja}"
              onclick="event.stopPropagation(); speakJa('${(r.kana || ja).replace(/'/g, "\\'")}')">&#128266;</button>
    </span>`;
  }).filter(Boolean);
  // A v5 related word whose text in the language being studied is
  // identical to this card's own headword (renderRelatedWordV5 returns ''
  // for that case) shows no new information -- two different English
  // concepts (e.g. "ability"/"capability") can share one Japanese word, so
  // filtered here rather than skipped at the data level, since the SAME
  // entry is often genuinely distinct in a different direction.
  if (!chips.length) return '';
  // Per explicit instruction (2026-10-14): show at most PWA_VISIBLE_RELATED
  // (3) related-word boxes, full stop -- no "more related words" fold for
  // the rest, so a concept with more than 3 in its data just shows the
  // first 3.
  const visible = chips.slice(0, PWA_VISIBLE_RELATED).join('');
  return `
    <div class="card-extra">
      <div class="card-extra-head">Related words</div>
      <div class="rel-chips">${visible}</div>
    </div>`;
}

// v5 schema renderer: shows the two languages the card is currently being
// studied in (matching the card's own header/footer languages), up to 3
// meanings under each, and a real audio file -- the linked concept's own
// recording when one exists, otherwise the standalone clip generated
// specifically for this related-word entry (assets/related_audio/), which
// is why every v5 entry ships with `audio_key` even when it also has a
// concept_id: the linked concept may be outside the live 1,000 and have no
// recording of its own yet, and the button must still play something.
function renderRelatedWordV5(r, title, langA, langB, ownHeadword) {
  const escAttr = s => String(s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  const primary = r[langA] || r.en;
  const secondary = r[langB] || r.en;

  // Two different English concepts can share one word in the language being
  // studied (e.g. "ability" and "capability" both translate to 能力 in
  // Japanese) -- showing a related word identical to the card's own
  // headword demonstrates nothing new, so skip the chip for this direction
  // rather than render a confusing duplicate (confirmed in the data: this
  // is systemic, not a one-off -- CID 1177's own related-word list is the
  // exact case that surfaced it).
  if (ownHeadword && primary.text && primary.text.trim() === ownHeadword.trim()) {
    return '';
  }

  // Per explicit instruction (2026-10-14): a related-word box shows exactly
  // ONE word in the language being studied (bold, .rel-chip-ja) and ONE
  // English meaning (not bold, .rel-chip-en) -- nothing else. The "meanings"
  // array on each related-word language object (often a restated synonym
  // plus a multi-word parenthetical gloss, e.g. "जीव विज्ञान, जीवशास्त्र
  // (biology, life science)" squeezed into tiny text under "जीव विज्ञान /
  // biology") is never rendered here any more; it used to be shown after a
  // narrower filter that only caught an EXACT restatement, which left this
  // kind of multi-term clutter untouched. Confirmed live (CID 4751 "cell"'s
  // जीव विज्ञान/biology related word) before removing it.
  const audioLang = langA;
  const audioUrl = relatedWordAudioUrl(r, audioLang);
  // A concept_id alone isn't enough: it may point at one of the 4,000
  // master-list concepts that aren't part of the live 1,000 yet, which
  // would render as a solid "working" chip that fails silently on click.
  // Only a concept_id that actually resolves in the loaded CARDS gets the
  // tappable style; everything else falls back to the dashed no-card look,
  // same as a related word with no concept_id at all.
  const clickable = !!r.concept_id && typeof CARDS !== 'undefined' &&
    CARDS.some(c => String(c.concept_id) === String(r.concept_id));
  const openAttr = clickable
    ? `onclick="event.stopPropagation(); jumpToConcept('${r.concept_id}')"` : '';
  return `
    <span class="rel-chip rel-chip-v5${clickable ? '' : ' rel-chip-nocard'}" ${openAttr}
          title="${title}${clickable ? '' : ' - flashcard coming soon'}">
      <span class="rel-chip-main">
        <span class="rel-chip-ja">${primary.text || ''}</span>
        <span class="rel-chip-en">${secondary.text || ''}</span>
      </span>
      ${audioUrl ? `<button class="rel-chip-audio" aria-label="Play ${escAttr(primary.text)}"
              onclick="event.stopPropagation(); playRelatedAudio('${escAttr(audioUrl)}')">&#128266;</button>` : ''}
    </span>`;
}

// Resolves the audio source for one v5 related-word entry in one language:
// prefer the linked concept's own recorded audio (it's already reviewed,
// human-recorded-voice quality); fall back to the standalone clip this
// feature generated for exactly this word, keyed by its English text so
// the same word reused across many concepts' related lists shares one file
// instead of duplicating audio per concept.
function relatedWordAudioUrl(r, lang) {
  if (r.concept_id && typeof CARDS !== 'undefined') {
    const linked = CARDS.find(c => String(c.concept_id) === String(r.concept_id));
    if (linked && linked.directions) {
      // Direction keys are "XX_YY" (e.g. "JA_EN"): the header audio always
      // matches the FIRST language code in the key, so a key starting with
      // this language's code reliably gives that language's own recording,
      // independent of the (free-text, non-machine-readable) display label.
      const prefix = lang.toUpperCase() + '_';
      const dirKey = Object.keys(linked.directions).find(k => k.startsWith(prefix));
      const url = dirKey && linked.directions[dirKey].header_audio_url;
      if (url) return url;
    }
  }
  const key = String((r.en && r.en.text) || '').toLowerCase()
    .replace(/^to /, '').trim().replace(/[^a-z0-9]+/g, '_');
  if (!key) return '';
  return `assets/related_audio/${key}_${lang}.mp3`;
}

function playRelatedAudio(url) {
  if (!url || ptwIsMuted()) return;
  const a = new Audio(url);
  a.play().catch(() => {});
}

// Inflected forms, shown only for verbs and adjectives. Nouns do not
// inflect, so the section is absent rather than empty.

// Per explicit instruction (2026-10-14): at most 3 related-word boxes per
// card, no "more related words" fold beyond that -- a concept with more than
// 3 in its data (50/5,000 concepts have 4-6) simply shows its first 3.
const PWA_VISIBLE_RELATED = 3;
// ── Phrase realisations ─────────────────────────────────────────────
// Which languages express this concept as a PHRASE rather than a single word.
// "to cycle" is one word in English and three in French (faire du vélo), two
// in Hindi (साइकिल चलाना) and a verb phrase in Japanese (自転車に乗る). A
// learner studying EN->JA never sees the French; a learner studying EN->FR
// sees faire du vélo but is never told it is a phrase where English uses one
// word. That contrast is the lesson, and it is shown here in every direction
// at once.
//
// Every string comes from PTW's own concept labels, which were translated and
// reviewed by native speakers -- no dictionary or machine-translated material.
// See data/phrases.json's _credit.
let PWA_PHRASES = null;
let PWA_PHRASES_PROMISE = null;

function loadPhrases() {
  if (PWA_PHRASES) return Promise.resolve(PWA_PHRASES);
  if (!PWA_PHRASES_PROMISE) {
    PWA_PHRASES_PROMISE = fetch('data/phrases.json')
      .then(r => r.json())
      .then(j => { PWA_PHRASES = j.phrases || j; return PWA_PHRASES; })
      .catch(() => ({}));
  }
  return PWA_PHRASES_PROMISE;
}

let PWA_JA_COLLOCATIONS = null;
let PWA_JA_COLLOCATIONS_PROMISE = null;

function loadJaCollocations() {
  if (PWA_JA_COLLOCATIONS) return Promise.resolve(PWA_JA_COLLOCATIONS);
  if (!PWA_JA_COLLOCATIONS_PROMISE) {
    PWA_JA_COLLOCATIONS_PROMISE = fetch('data/ja-collocations.json')
      .then(r => r.json())
      .then(j => { PWA_JA_COLLOCATIONS = j.collocations || j; return PWA_JA_COLLOCATIONS; })
      .catch(() => ({}));
  }
  return PWA_JA_COLLOCATIONS_PROMISE;
}

// Distinct from renderPhrases: that shows how a concept is said in a
// language NOT on the current card. This shows a genuine Japanese
// collocation anchored to the concept's own Japanese headword (e.g. 頭を
// 使う "to use one's head" for the concept "to use"), so it only makes
// sense on the JA_EN card -- the only card where the Japanese word is what
// the learner is actually looking at. Sourced from JMdict's own curated
// "exp" entries, filtered for teachability and manually reviewed
// concept-by-concept -- see tools/build_ja_collocations.py.
function renderJaCollocations(concept) {
  if (!PWA_JA_COLLOCATIONS) return '';
  if ((currentDirection || '').toUpperCase() !== 'JA_EN') return '';
  const c = PWA_JA_COLLOCATIONS[String(concept.concept_id)];
  if (!c || !c.ja) return '';
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Common collocation</summary>
      <div class="pwa-phrase-list">
        <div class="pwa-phrase-row">
          ${c.audio ? exAudioBtn(c.audio, c.ja, 'ja') : ''}
          <span class="pwa-phrase-text">${escapeEx(c.ja)}${c.reading ? ` (${escapeEx(c.reading)})` : ''} -- ${escapeEx(c.gloss || '')}</span>
        </div>
      </div>
    </details>`;
}

let PWA_EN_COLLOCATIONS = null;
let PWA_EN_COLLOCATIONS_PROMISE = null;

function loadEnCollocations() {
  if (PWA_EN_COLLOCATIONS) return Promise.resolve(PWA_EN_COLLOCATIONS);
  if (!PWA_EN_COLLOCATIONS_PROMISE) {
    PWA_EN_COLLOCATIONS_PROMISE = fetch('data/en-collocations.json')
      .then(r => r.json())
      .then(j => { PWA_EN_COLLOCATIONS = j.collocations || j; return PWA_EN_COLLOCATIONS; })
      .catch(() => ({}));
  }
  return PWA_EN_COLLOCATIONS_PROMISE;
}

// English is the shared target language across all 3 surviving pairs
// (JA_EN/HI_EN/FR_EN), so unlike renderJaCollocations this is NOT gated to
// one direction -- it renders on every card, since English is always what's
// on the footer regardless of which pair is showing. Sourced from the raw
// Tatoeba English sentence corpus via adjacency-frequency extraction
// (there's no curated English "expression dictionary" the way JMdict is
// for Japanese), heavily filtered and then reviewed concept-by-concept by
// hand across all ~3,200 surviving candidates -- see
// tools/build_en_collocations.py, including its note on why this method is
// inherently sense-blind and needed extra care around concepts that share
// an English label with a different-sense concept.
function renderEnCollocations(concept) {
  if (!PWA_EN_COLLOCATIONS) return '';
  const c = PWA_EN_COLLOCATIONS[String(concept.concept_id)];
  if (!c || !c.phrase) return '';
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Common English collocation</summary>
      <div class="pwa-phrase-list">
        <div class="pwa-phrase-row">
          ${c.audio ? exAudioBtn(c.audio, c.phrase, 'en') : ''}
          <span class="pwa-phrase-text">${escapeEx(c.phrase)}</span>
        </div>
      </div>
    </details>`;
}

let PWA_FR_COLLOCATIONS = null;
let PWA_FR_COLLOCATIONS_PROMISE = null;

function loadFrCollocations() {
  if (PWA_FR_COLLOCATIONS) return Promise.resolve(PWA_FR_COLLOCATIONS);
  if (!PWA_FR_COLLOCATIONS_PROMISE) {
    PWA_FR_COLLOCATIONS_PROMISE = fetch('data/fr-collocations.json')
      .then(r => r.json())
      .then(j => { PWA_FR_COLLOCATIONS = j.collocations || j; return PWA_FR_COLLOCATIONS; })
      .catch(() => ({}));
  }
  return PWA_FR_COLLOCATIONS_PROMISE;
}

// French is the source language only on FR_EN (unlike English, the shared
// target across all 3 pairs), so gated to FR_EN only, mirroring
// renderJaCollocations' JA_EN gate. Sourced from the raw Tatoeba French
// sentence corpus (726,753 sentences, downloaded from Tatoeba's official
// per-language export), same adjacency-frequency method as English,
// adapted for French tokenization (elision-aware, accented characters
// including œ/æ) and reviewed concept-by-concept by hand -- see
// tools/build_fr_collocations.py.
function renderFrCollocations(concept) {
  if (!PWA_FR_COLLOCATIONS) return '';
  if ((currentDirection || '').toUpperCase() !== 'FR_EN') return '';
  const c = PWA_FR_COLLOCATIONS[String(concept.concept_id)];
  if (!c || !c.phrase) return '';
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Common collocation</summary>
      <div class="pwa-phrase-list">
        <div class="pwa-phrase-row">
          ${c.audio ? exAudioBtn(c.audio, c.phrase, 'fr') : ''}
          <span class="pwa-phrase-text">${escapeEx(c.phrase)}</span>
        </div>
      </div>
    </details>`;
}

let PWA_HI_COLLOCATIONS = null;
let PWA_HI_COLLOCATIONS_PROMISE = null;

function loadHiCollocations() {
  if (PWA_HI_COLLOCATIONS) return Promise.resolve(PWA_HI_COLLOCATIONS);
  if (!PWA_HI_COLLOCATIONS_PROMISE) {
    PWA_HI_COLLOCATIONS_PROMISE = fetch('data/hi-collocations.json')
      .then(r => r.json())
      .then(j => { PWA_HI_COLLOCATIONS = j.collocations || j; return PWA_HI_COLLOCATIONS; })
      .catch(() => ({}));
  }
  return PWA_HI_COLLOCATIONS_PROMISE;
}

// Hindi is the source language only on HI_EN, so gated to HI_EN only,
// mirroring renderFrCollocations' FR_EN gate. Sourced from a ~3GB sample of
// ai4bharat/IndicCorpV2's Hindi text (CC0-licensed, freely downloadable --
// unlike the original IndicCorp and the Leipzig Hindi news corpus, both
// CC BY-NC/non-commercial only), same adjacency-frequency method as English/
// French, adapted for Devanagari tokenization (the danda/double-danda
// sentence-final punctuation sits inside the same Unicode block as the
// letters, unlike Latin scripts, and had to be explicitly excluded). This
// corpus is a noisier web/news crawl than Tatoeba, and Devanagari has no
// capitalization to auto-filter proper nouns the way English/French can, so
// review here excluded 229 candidates (vs. French's 44) -- politician/
// celebrity/brand-name collisions, wrong-sense homographs, and a recurring
// class of raw corpus tokenization artifacts -- see
// tools/build_hi_collocations.py.
function renderHiCollocations(concept) {
  if (!PWA_HI_COLLOCATIONS) return '';
  if ((currentDirection || '').toUpperCase() !== 'HI_EN') return '';
  const c = PWA_HI_COLLOCATIONS[String(concept.concept_id)];
  if (!c || !c.phrase) return '';
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Common collocation</summary>
      <div class="pwa-phrase-list">
        <div class="pwa-phrase-row">
          ${c.audio ? exAudioBtn(c.audio, c.phrase, 'hi') : ''}
          <span class="pwa-phrase-text">${escapeEx(c.phrase)}</span>
        </div>
      </div>
    </details>`;
}

const PHRASE_LANG_NAME = { en: 'English', ja: 'Japanese', hi: 'Hindi', fr: 'French' };

const PHRASE_LANG_CODES = ['en', 'ja', 'hi', 'fr'];

function renderPhrases(concept) {
  if (!PWA_PHRASES) return '';
  const p = PWA_PHRASES[String(concept.concept_id)];
  if (!p) return '';
  // Only worth showing what the learner isn't already reading on the card.
  // Filtered to the known language codes, not every key on the object --
  // `audio` (per-language recorded-clip URLs, keyed the same as the text
  // fields) lives alongside them and must never be mistaken for a fifth
  // language to render.
  const [top, bottom] = (currentDirection || 'JA_EN').toLowerCase().split('_');
  const langs = PHRASE_LANG_CODES.filter(l => p[l] && l !== top && l !== bottom);
  if (!langs.length) return '';
  const rows = langs.map(l => {
    const audioUrl = p.audio && p.audio[l];
    return `
      <div class="pwa-phrase-row">
        <span class="pwa-phrase-flag">${EX_LANG_FLAG[l] || ''}</span>
        <span class="pwa-phrase-lang">${PHRASE_LANG_NAME[l] || l}</span>
        ${audioUrl ? exAudioBtn(audioUrl, p[l], l) : ''}
        <span class="pwa-phrase-text">${escapeEx(p[l])}</span>
      </div>`;
  }).join('');
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Said as a phrase in ${langs.length} other language${langs.length > 1 ? 's' : ''}</summary>
      <div class="pwa-phrase-list">${rows}
        <p class="pwa-phrase-note">Where a language needs several words for what another says in one.</p>
      </div>
    </details>`;
}

// ── Feature 2: English gloss shown under each inflected form ─────
// Rule-based English conjugation of concept.english (already-correct
// source data), not translation -- same class of operation as this
// project's own JA/FR/HI conjugation tables, just for English. Ported
// 1:1 from tools/en_gloss_conjugate.py, where its output was exhaustively
// verified against every one of the ~510 verb and ~40 adjective concepts
// by hand before porting (see TODO.md). Keep the two in sync: any future
// fix belongs in the Python source first, re-verified there, then mirrored
// here and into ptw-extension/lib/ptw-inflections.js.
const EN_GLOSS_IRREGULAR = {
  be: ["was", "been", "is"], beat: ["beat", "beaten", null], become: ["became", "become", null],
  begin: ["began", "begun", null], bend: ["bent", "bent", null], bite: ["bit", "bitten", null],
  blow: ["blew", "blown", null], break: ["broke", "broken", null], bring: ["brought", "brought", null],
  build: ["built", "built", null], buy: ["bought", "bought", null], catch: ["caught", "caught", null],
  choose: ["chose", "chosen", null], come: ["came", "come", null], creep: ["crept", "crept", null],
  cut: ["cut", "cut", null], dig: ["dug", "dug", null], do: ["did", "done", "does"],
  draw: ["drew", "drawn", null], drink: ["drank", "drunk", null], drive: ["drove", "driven", null],
  eat: ["ate", "eaten", null], fall: ["fell", "fallen", null], feel: ["felt", "felt", null],
  find: ["found", "found", null], fling: ["flung", "flung", null], fly: ["flew", "flown", null],
  forgive: ["forgave", "forgiven", null], freeze: ["froze", "frozen", null], go: ["went", "gone", "goes"],
  grow: ["grew", "grown", null], have: ["had", "had", "has"], hide: ["hid", "hidden", null],
  hold: ["held", "held", null], hurt: ["hurt", "hurt", null], keep: ["kept", "kept", null],
  kneel: ["knelt", "knelt", null], know: ["knew", "known", null], lay: ["laid", "laid", null],
  lead: ["led", "led", null], leave: ["left", "left", null], lend: ["lent", "lent", null],
  lose: ["lost", "lost", null], make: ["made", "made", null], mean: ["meant", "meant", null],
  meet: ["met", "met", null], overcome: ["overcame", "overcome", null], pay: ["paid", "paid", null],
  read: ["read", "read", null], ride: ["rode", "ridden", null], ring: ["rang", "rung", null],
  rise: ["rose", "risen", null], run: ["ran", "run", null], say: ["said", "said", null],
  see: ["saw", "seen", null], seek: ["sought", "sought", null], sell: ["sold", "sold", null],
  send: ["sent", "sent", null], sew: ["sewed", "sewn", null], shake: ["shook", "shaken", null],
  shine: ["shone", "shone", null], shoot: ["shot", "shot", null], shrink: ["shrank", "shrunk", null],
  sing: ["sang", "sung", null], sit: ["sat", "sat", null], sleep: ["slept", "slept", null],
  slide: ["slid", "slid", null], smell: ["smelled", "smelled", null], speak: ["spoke", "spoken", null],
  spin: ["spun", "spun", null], split: ["split", "split", null], spread: ["spread", "spread", null],
  stand: ["stood", "stood", null], steal: ["stole", "stolen", null], stick: ["stuck", "stuck", null],
  sting: ["stung", "stung", null], stride: ["strode", "stridden", null], string: ["strung", "strung", null],
  strive: ["strove", "striven", null], swear: ["swore", "sworn", null], sweep: ["swept", "swept", null],
  swim: ["swam", "swum", null], swing: ["swung", "swung", null], take: ["took", "taken", null],
  teach: ["taught", "taught", null], tear: ["tore", "torn", null], tell: ["told", "told", null],
  think: ["thought", "thought", null], throw: ["threw", "thrown", null], understand: ["understood", "understood", null],
  wake: ["woke", "woken", null], wear: ["wore", "worn", null], weave: ["wove", "woven", null],
  win: ["won", "won", null], write: ["wrote", "written", null],
};
const EN_GLOSS_VOWELS = new Set(["a", "e", "i", "o", "u"]);
const EN_GLOSS_DOUBLE_CONSONANT = new Set([
  "bat", "beg", "bob", "brag", "bug", "chat", "chop", "clap", "clip", "crop",
  "cut", "dig", "drag", "drip", "drop", "drum", "equip", "fit", "flip",
  "gab", "gag", "grab", "grip", "grin", "hop", "hug", "jab", "jam", "jog",
  "jot", "knot", "map", "mob", "mop", "nab", "nap", "nod", "pad", "pat",
  "peg", "pin", "pit", "plan", "plot", "plug", "pop", "prefer", "prod",
  "quit", "quiz", "rap", "rib", "rig", "rip", "rob", "rot", "rub", "run",
  "sag", "scan", "scrub", "shop", "shred", "shrug", "sip", "sit", "skid",
  "skim", "skip", "slam", "slap", "slim", "slip", "slit", "slot", "snag",
  "snap", "snip", "sob", "spin", "split", "spot", "spur", "squat", "star",
  "step", "stir", "stop", "strap", "strip", "strut", "stub", "stun", "sub",
  "swap", "swat", "swim", "tag", "tan", "tap", "throb", "tip", "top",
  "trap", "trek", "trim", "trip", "tug", "unwrap", "unzip", "wag", "wed",
  "wet", "whip", "whiz", "win", "wrap", "zap", "zip",
]);
function enGlossEndsEeOeYe(w) { return w.endsWith("ee") || w.endsWith("oe") || w.endsWith("ye"); }
function enGlossPresent3sg(w) {
  const irr = EN_GLOSS_IRREGULAR[w];
  if (irr && irr[2]) return irr[2];
  if (w.endsWith("s") || w.endsWith("x") || w.endsWith("z") || w.endsWith("ch") || w.endsWith("sh") || w.endsWith("o")) return w + "es";
  if (w.length >= 2 && w.endsWith("y") && !EN_GLOSS_VOWELS.has(w[w.length - 2])) return w.slice(0, -1) + "ies";
  return w + "s";
}
function enGlossPast(w) {
  const irr = EN_GLOSS_IRREGULAR[w];
  if (irr) return irr[0];
  if (EN_GLOSS_DOUBLE_CONSONANT.has(w)) return w + w[w.length - 1] + "ed";
  if (w.endsWith("e")) return w + "d";
  if (w.length >= 2 && w.endsWith("y") && !EN_GLOSS_VOWELS.has(w[w.length - 2])) return w.slice(0, -1) + "ied";
  return w + "ed";
}
function enGlossGerund(w) {
  if (w === "be") return "being";
  if (EN_GLOSS_DOUBLE_CONSONANT.has(w)) return w + w[w.length - 1] + "ing";
  if (w.endsWith("ie")) return w.slice(0, -2) + "ying";
  if (w.endsWith("e") && !enGlossEndsEeOeYe(w)) return w.slice(0, -1) + "ing";
  return w + "ing";
}
const EN_GLOSS_VERB_BUILDERS = {
  plain_present: (c, rest) => `${c.sg3}${rest}`,
  past_plain: (c, rest) => `${c.past}${rest}`,
  negative_plain: (c, rest) => c.base === "be" ? `isn't${rest}` : `doesn't ${c.base}${rest}`,
  past_negative: (c, rest) => c.base === "be" ? `wasn't${rest}` : `didn't ${c.base}${rest}`,
  te_form: (c, rest) => `${c.gerund}${rest}`,
  te_iru: (c, rest) => `is ${c.gerund}${rest}`,
  polite_present: (c, rest) => c.base === "be" ? `you are${rest}` : `you ${c.base}${rest}`,
  past_polite: (c, rest) => c.base === "be" ? `you were${rest}` : `you ${c.past}${rest}`,
  negative_polite: (c, rest) => c.base === "be" ? `you aren't${rest}` : `you don't ${c.base}${rest}`,
  potential: (c, rest) => `can ${c.base}${rest}`,
  volitional: (c, rest) => `let's ${c.base}${rest}`,
  conditional: (c, rest) => `would ${c.base}${rest}`,
};
const EN_GLOSS_ADJ_BUILDERS = {
  plain_present: (adj) => `is ${adj}`,
  past_plain: (adj) => `was ${adj}`,
  negative_plain: (adj) => `isn't ${adj}`,
  past_negative: (adj) => `wasn't ${adj}`,
  te_form: (adj) => adj,
  te_iru: (adj) => `is ${adj}`,
  polite_present: (adj) => `you are ${adj}`,
  past_polite: (adj) => `you were ${adj}`,
  negative_polite: (adj) => `you aren't ${adj}`,
  potential: (adj) => `can be ${adj}`,
  volitional: (adj) => `let's be ${adj}`,
  conditional: (adj) => `would be ${adj}`,
};
// Returns "verb", "adjective", or null (na_adj concepts are skipped --
// their English is a mix of real adjectives (white, okay) and abstract
// nouns (freedom, honor) with no safe non-invented adjective form, see
// TODO.md's Feature 2 entry for the full reasoning).
function enGlossKind(concept) {
  const cls = concept.inflections && concept.inflections.class;
  if (cls === "na_adj") return null;
  if (cls === "i_adj") return "adjective";
  if (cls === "godan" || cls === "ichidan" || cls === "suru" || cls === "kuru") return "verb";
  const eng = concept.english || "";
  return eng.startsWith("to ") ? "verb" : "adjective";
}
function enGlossForForm(concept, formId) {
  const kind = enGlossKind(concept);
  const eng = concept.english || "";
  if (kind === "verb") {
    const bare = eng.startsWith("to ") ? eng.slice(3) : eng;
    const sp = bare.indexOf(" ");
    const head = sp === -1 ? bare : bare.slice(0, sp);
    const rest = sp === -1 ? "" : bare.slice(sp);
    const c = { base: head, sg3: enGlossPresent3sg(head), past: enGlossPast(head), gerund: enGlossGerund(head) };
    const builder = EN_GLOSS_VERB_BUILDERS[formId];
    return builder ? builder(c, rest) : "";
  }
  if (kind === "adjective") {
    const builder = EN_GLOSS_ADJ_BUILDERS[formId];
    return builder ? builder(eng) : "";
  }
  return "";
}

function renderInflections(concept) {
  // Preferred source: inflection_forms, which carries kana and romaji per
  // form as well as the kanji. Cards that predate it fall through to the
  // original inflections.forms rendering below.
  const rich = concept.inflection_forms;
  if (rich && rich.length) {
    // French/Hindi conjugation tables (when present, currently the
    // live-1000 verb set) share the same form_id set as the Japanese
    // inflection_forms -- index by form_id so each row can show all
    // available languages together for cross-lingual comparison.
    const frByForm = {};
    (concept.french_inflection_forms || []).forEach(f => { frByForm[f.form_id] = f; });
    const hiByForm = {};
    (concept.hindi_inflection_forms || []).forEach(f => { hiByForm[f.form_id] = f; });
    const hasFr = Object.keys(frByForm).length > 0;
    const hasHi = Object.keys(hiByForm).length > 0;
    // English gloss (Feature 2): skipped for na_adj concepts (enGlossKind
    // returns null there -- see its own comment for why), present for
    // every verb and i_adj concept.
    const hasEn = enGlossKind(concept) !== null;

    // Row labels are grammar metalanguage ("past", "gérondif", "निषेध"), so
    // they follow the reader's display language like every other label on
    // the card. card_enrichment.json carries them per form_id in all four
    // languages; f.label is the English baked into the data file and is the
    // fallback when a form has no entry there.
    const richLabels = (CARD_ENRICHMENT_LABELS || {});
    const rows = rich.map(f => {
      const fr = frByForm[f.form_id];
      const hi = hiByForm[f.form_id];
      const rl = richLabels[f.form_id];
      const rowLabel = (rl && (rl[prefLang] || rl.en)) || f.label || f.form_id;
      // Bare conjugated-word-form audio -- assets/inflection_audio/, named
      // by convention ({concept_id}_{lang}_{form_id}.mp3) rather than read
      // from a JSON pointer: this table previously had no audio of its own
      // at all (only "View usage" -> example-sentence audio), even though
      // the clips themselves already existed on disk for a subset of forms.
      const jaFormAudio = exAudioBtn(`assets/inflection_audio/${concept.concept_id}_ja_${f.form_id}.mp3`, f.ja, 'ja');
      const hiFormAudio = hasHi && hi ? exAudioBtn(`assets/inflection_audio/${concept.concept_id}_hi_${f.form_id}.mp3`, hi.hi, 'hi') : '';
      const frFormAudio = hasFr && fr ? exAudioBtn(`assets/inflection_audio/${concept.concept_id}_fr_${f.form_id}.mp3`, fr.fr, 'fr') : '';
      // Buttons are nested INSIDE each existing grid-cell span, not added as
      // sibling elements -- infl-row-rich is a CSS grid whose column count
      // is precisely tuned to today's fixed span count per row
      // (grid-template-columns varies with hasFr/hasHi/hasEn); an extra
      // top-level element per row would desync every later cell by one
      // column.
      return `
              <div class="infl-row infl-row-rich">
                <span class="infl-label">${rowLabel}</span>
                <span class="infl-form">${jaFormAudio}${f.ja}</span>
                <span class="infl-kana">${f.kana || ''}</span>
                <span class="infl-romaji">${f.romaji || ''}</span>
                ${hasFr ? `<span class="infl-fr">${frFormAudio}${fr ? fr.fr : ''}</span>` : ''}
                ${hasHi ? `<span class="infl-hi">${hiFormAudio}${hi ? hi.hi : ''}</span><span class="infl-hi-romanized">${hi ? hi.hi_romanized : ''}</span>` : ''}
                ${hasEn ? `<span class="infl-en-gloss">${escapeEx(enGlossForForm(concept, f.form_id))}</span>` : ''}
                ${usageButtonHtml('ja', concept.concept_id, f.form_id)}
                ${usageButtonHtml('hi', concept.concept_id, f.form_id)}
                ${usageButtonHtml('fr', concept.concept_id, f.form_id)}
              </div>`;
    }).join('');
    const headerExtra = (hasFr ? '<span class="infl-col-head">FR</span>' : '') +
                         (hasHi ? '<span class="infl-col-head">HI</span>' : '') +
                         (hasEn ? '<span class="infl-col-head">EN</span>' : '');
    return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Inflected forms (${rich.length})</summary>
      ${headerExtra ? `<div class="infl-grid-header">${headerExtra}</div>` : ''}
      <div class="infl-grid infl-grid-rich${hasFr ? ' infl-grid-fr' : ''}${hasHi ? ' infl-grid-hi' : ''}${hasEn ? ' infl-grid-en' : ''}">${rows}</div>
    </details>`;
  }

  const inf = concept.inflections;
  if (!inf || !inf.forms) return '';
  const labels = (CARD_ENRICHMENT_LABELS || {});
  const order = ['plain_present', 'polite_present', 'past_plain', 'past_polite',
                 'negative_plain', 'negative_polite', 'past_negative',
                 'te_form', 'te_iru', 'potential', 'volitional', 'conditional'];
  const rows = order.filter(k => inf.forms[k]).map(k => {
    const l = labels[k] || { en: k };
    return `<div class="infl-row">
              <span class="infl-label">${(l[prefLang] || l.en)}</span>
              <span class="infl-form">${inf.forms[k]}</span>
            </div>`;
  }).join('');
  if (!rows) return '';
  return `
    <details class="card-extra card-extra-fold">
      <summary class="card-extra-head">Inflected forms <span class="infl-class">${inf.class || ''}</span></summary>
      <div class="infl-grid">${rows}</div>
    </details>`;
}

// ── "View usage" -- per-inflection-form example sentences ────────
// Phase 1 (2026-09-19) built this for Japanese; Phase 2 added Hindi; Phase 3
// adds French -- each language has its own independently-sourced,
// independently-covered data file (output/ja_inflection_examples.json /
// output/hi_inflection_examples.json / output/fr_inflection_examples.json,
// mirrored here as data/inflection-examples-ja.json /
// data/inflection-examples-hi.json / data/inflection-examples-fr.json), so a
// row can show a JA usage button, a HI usage button, a FR usage button, any
// combination, or none, depending on which languages actually have example
// data for that exact (concept, form) pair -- never a button that opens to
// "no examples found".
//
// Hindi's data has no separate "reading" field the way Japanese's does
// (Devanagari is already the read script; hi_romanized IS the reading), and
// is keyed by hi_id instead of ja_id. French is Latin-script already, so it
// needs neither a reading nor a romanization row -- just fr text + en gloss,
// keyed by fr_id. renderUsageBody branches on `lang` for all of this, rather
// than trying to force every shape through one field set.
const PWA_INFLECTION_EXAMPLES_URLS = { ja: 'data/inflection-examples-ja.json', hi: 'data/inflection-examples-hi.json', fr: 'data/inflection-examples-fr.json' };
const PWA_INFLECTION_EXAMPLES_STORE = {};
const PWA_INFLECTION_EXAMPLES_PROMISES = {};

function loadInflectionExamples(lang) {
  if (PWA_INFLECTION_EXAMPLES_STORE[lang]) return Promise.resolve(PWA_INFLECTION_EXAMPLES_STORE[lang]);
  if (!PWA_INFLECTION_EXAMPLES_PROMISES[lang]) {
    PWA_INFLECTION_EXAMPLES_PROMISES[lang] = fetch(PWA_INFLECTION_EXAMPLES_URLS[lang])
      .then(r => r.json())
      .then(j => { PWA_INFLECTION_EXAMPLES_STORE[lang] = j; return j; })
      .catch(() => ({}));
  }
  return PWA_INFLECTION_EXAMPLES_PROMISES[lang];
}

function usageExamplesFor(lang, conceptId, formId) {
  const store = PWA_INFLECTION_EXAMPLES_STORE[lang];
  return (store && store[String(conceptId)] && store[String(conceptId)][formId]) || null;
}

// Kicked off at boot (see boot()), so this is normally already resolved by
// the time a card is opened -- but a card opened before it lands (a slow
// connection, or the very first paint) simply renders its inflected-forms
// section without any "View usage" buttons rather than a broken one; they
// are not retrofitted onto an already-rendered row.
const USAGE_LANG_NAME = { ja: 'Japanese', hi: 'Hindi', fr: 'French' };

function usageButtonHtml(lang, conceptId, formId) {
  const examples = usageExamplesFor(lang, conceptId, formId);
  if (!examples || !examples.length) return '';
  const name = USAGE_LANG_NAME[lang] || '';
  return `<button type="button" class="infl-usage-btn"
            onclick="event.stopPropagation(); openUsage('${lang}', '${escapeEx(conceptId)}', '${escapeEx(formId)}')">
            ${name} · View usage
          </button>`;
}

function openUsage(lang, conceptId, formId) {
  const overlay = document.getElementById('usage-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  renderUsageBody(lang, conceptId, formId);
}

function closeUsage() {
  const overlay = document.getElementById('usage-overlay');
  if (overlay) overlay.classList.remove('open');
}

function usageAudioBtn(lang, id, text, audioId) {
  const fileId = audioId || id;
  const url = `assets/audio_inflection_examples_${lang}/${fileId}_${lang}.mp3`;
  return exAudioBtn(url, text, lang);
}

function renderUsageBody(lang, conceptId, formId) {
  const body = document.getElementById('usage-body');
  if (!body) return;
  const concept = CARDS.find(c => String(c.concept_id) === String(conceptId));
  const formList = lang === 'hi' ? (concept && concept.hindi_inflection_forms)
                  : lang === 'fr' ? (concept && concept.french_inflection_forms)
                                  : (concept && concept.inflection_forms);
  const form = formList && formList.find(f => f.form_id === formId);
  const richLabels = (CARD_ENRICHMENT_LABELS || {});
  const rl = richLabels[formId];
  const formLabel = (rl && (rl[prefLang] || rl.en)) || (form && form.label) || formId;
  const examples = usageExamplesFor(lang, conceptId, formId) || [];

  const rows = lang === 'hi' ? examples.map(ex => `
    <div class="usage-ex">
      <div class="usage-ex-ja">
        ${usageAudioBtn('hi', ex.hi_id, ex.hi, ex.hi_audio_id)}
        <span class="usage-ex-ja-text">${escapeEx(ex.hi)}</span>
      </div>
      <div class="usage-ex-romaji">${escapeEx(ex.hi_romanized)}</div>
      <div class="usage-ex-en">${escapeEx(ex.en)}</div>
    </div>`).join('') : lang === 'fr' ? examples.map(ex => `
    <div class="usage-ex">
      <div class="usage-ex-ja">
        ${usageAudioBtn('fr', ex.fr_id, ex.fr, ex.fr_audio_id)}
        <span class="usage-ex-ja-text">${escapeEx(ex.fr)}</span>
      </div>
      <div class="usage-ex-en">${escapeEx(ex.en)}</div>
    </div>`).join('') : examples.map(ex => `
    <div class="usage-ex">
      <div class="usage-ex-ja">
        ${usageAudioBtn('ja', ex.ja_id, ex.ja, ex.ja_audio_id)}
        <span class="usage-ex-ja-text${ex.ja_furigana ? ' usage-ex-has-furigana' : ''}">${ex.ja_furigana || escapeEx(ex.ja)}</span>
      </div>
      <div class="usage-ex-reading">${escapeEx(ex.reading)}</div>
      <div class="usage-ex-romaji">${escapeEx(ex.romaji)}</div>
      <div class="usage-ex-en">${escapeEx(ex.en)}</div>
    </div>`).join('');

  const headForm = form ? (lang === 'hi' ? form.hi : lang === 'fr' ? form.fr : form.ja) : '';
  const headRomaji = form ? (lang === 'hi' ? form.hi_romanized : lang === 'fr' ? '' : form.romaji) : '';
  body.innerHTML = `
    <div class="usage-head">
      <div class="usage-head-form">${escapeEx(headForm)}</div>
      <div class="usage-head-label">${escapeEx(formLabel)}${headRomaji ? ` &middot; ${escapeEx(headRomaji)}` : ''}</div>
    </div>
    <div class="usage-ex-list">${rows || '<p class="usage-empty">No example sentences yet for this form.</p>'}</div>
    <div class="usage-credit">${usageCredit(lang, examples)}</div>`;
}

// The credit line was hardcoded to Tatoeba regardless of actual source --
// found 2026-09-20 testing the new Hindi Global Voices top-up (built for
// concepts Tatoeba's own Hindi corpus had zero coverage for): a Global
// Voices-sourced example was being shown as "from Tatoeba", which is not
// just wrong, it fails Global Voices' own CC BY license, which requires
// attributing the actual source. An example's hi_id/fr_id/ja_id carries a
// "gv_" prefix specifically for Global Voices-sourced Hindi examples
// (build_hi_inflection_examples_gv_topup.py); anything else is Tatoeba,
// the only source every other language/example set here has ever used.
function usageCredit(lang, examples) {
  return 'Sentences generated by AI, individually audited for accuracy';
}

// Two concepts can share an English word with different Japanese behind it
// - 978/979 mouse, 980/981 light. The extension resolves that from the
// sentence around the word; the PWA has no sentence, so it offers the other
// card instead. This is the PWA's version of the sense switcher.
function renderAlsoMeans(concept) {
  const en = String(concept.english || '').replace(/_/g, ' ').trim().toLowerCase();
  if (!en || typeof CARDS === 'undefined') return '';
  const others = CARDS.filter(c =>
    String(c.concept_id) !== String(concept.concept_id) &&
    String(c.english || '').replace(/_/g, ' ').trim().toLowerCase() === en);
  if (!others.length) return '';
  const links = others.map(c => `
      <span class="ptw-sense-alt" onclick="event.stopPropagation(); jumpToConcept('${c.concept_id}')">
        <span class="ptw-sense-ja">${(c.labels && c.labels.ja) || c.english}</span>
        <span class="ptw-sense-cat">${c.category_label || ''}</span>
      </span>`).join('');
  return `
    <div class="ptw-sense-also">
      <span class="ptw-sense-head">Also means:</span>${links}
    </div>`;
}

function jumpToConcept(conceptId) {
  const concept = CARDS.find(c => String(c.concept_id) === String(conceptId));
  if (!concept) { flashToast('That card is coming soon'); return; }
  closeFocus();
  setTimeout(() => openConcept(concept.concept_id), 120);
}

let CARD_ENRICHMENT_LABELS = {};

// Speaks a Japanese word that has no recorded audio file of its own, which
// is the case for every related word still awaiting its flashcard. Falls
// back silently where the browser has no Japanese voice installed.
//
// iOS Safari has two well-documented WebKit quirks that don't show up on
// desktop Chrome/Safari or Android: (1) calling cancel() when nothing is
// actually queued can leave the synthesis engine silently stuck for the
// very next speak() call -- it returns normally, nothing throws, nothing
// is heard; (2) the engine can end up "paused" after a prior utterance
// and never resumes on its own before the next speak(). Neither has a
// visible symptom besides "just doesn't play on this one device" -- which
// is exactly the report this is fixing. Both guards are unconditionally
// safe on every other platform (no-ops when there's nothing to guard
// against), so this isn't an iOS-only code path, just a hardened one.
function speakJa(text) {
  if (ptwIsMuted()) return;
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    // Explicit voice selection where one is available -- letting the
    // engine resolve purely from `lang` is the norm and usually fine, but
    // being explicit avoids relying on that resolution behaving the same
    // across engines when a matching voice does exist.
    const voices = synth.getVoices ? synth.getVoices() : [];
    const jaVoice = voices.find(v => v.lang === 'ja-JP') || voices.find(v => v.lang && v.lang.startsWith('ja'));
    if (jaVoice) u.voice = jaVoice;
    synth.speak(u);
  } catch (err) { /* no voice available - stay silent rather than throw */ }
}

function speakEn(text) {
  if (ptwIsMuted()) return;
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    const voices = synth.getVoices ? synth.getVoices() : [];
    const enVoice = voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang && v.lang.startsWith('en'));
    if (enVoice) u.voice = enVoice;
    synth.speak(u);
  } catch (err) { /* no voice available - stay silent rather than throw */ }
}

function speakHi(text) {
  if (ptwIsMuted()) return;
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'hi-IN';
    const voices = synth.getVoices ? synth.getVoices() : [];
    const hiVoice = voices.find(v => v.lang === 'hi-IN') || voices.find(v => v.lang && v.lang.startsWith('hi'));
    if (hiVoice) u.voice = hiVoice;
    synth.speak(u);
  } catch (err) { /* no voice available - stay silent rather than throw */ }
}

function speakFr(text) {
  if (ptwIsMuted()) return;
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 0.9;
    const voices = synth.getVoices ? synth.getVoices() : [];
    const frVoice = voices.find(v => v.lang === 'fr-FR') || voices.find(v => v.lang && v.lang.startsWith('fr'));
    if (frVoice) u.voice = frVoice;
    synth.speak(u);
  } catch (err) { /* no voice available - stay silent rather than throw */ }
}


// ── Example sentences ───────────────────────────────────────────
// Same shape as the extension's card back: two sentences up front, the
// rest folded and grouped by the inflected form actually used, each group
// linking to Tatoeba's search for that exact form.
//
// Two corpora, same reasoning as the extension's content.js/popup.js:
// examples-ja.json is keyed on Japanese headwords, examples-en.json on
// English ones. This used to always fetch and key off examples-ja.json
// regardless of which direction was showing -- harmless for JA_EN, but
// for EN_JA it meant looking up the Japanese lemma in a corpus keyed by
// (often differently-conjugated) Japanese forms, e.g. "to study" ->
// "勉強する" has no entry, while the extension's English corpus has a
// real entry under "study" and always found it. 1 in 5 EN_JA concepts
// silently showed no examples as a result.
// Only JA_EN/EN_JA reach these now; Hindi and French directions read the
// concept_id-keyed unified corpus below instead. examples-hi.json's rows have
// been folded into it, so it is no longer fetched here.
const PWA_EXAMPLES_URLS = { ja: 'data/examples-ja.json', en: 'data/examples-en.json' };
const PWA_EXAMPLES_CACHE = {};
const PWA_EXAMPLES_PROMISES = {};

// Unified multilingual examples (keyed by concept_id)
let PWA_UNIFIED_EXAMPLES = null;
let PWA_UNIFIED_EXAMPLES_PROMISE = null;

function loadUnifiedExamples() {
  if (PWA_UNIFIED_EXAMPLES) return Promise.resolve(PWA_UNIFIED_EXAMPLES);
  if (!PWA_UNIFIED_EXAMPLES_PROMISE) {
    PWA_UNIFIED_EXAMPLES_PROMISE = fetch('data/examples.json')
      .then(r => r.json())
      .then(j => { PWA_UNIFIED_EXAMPLES = j; return j; })
      .catch(() => ({}));
  }
  return PWA_UNIFIED_EXAMPLES_PROMISE;
}

function loadExamples(lang) {
  const key = PWA_EXAMPLES_URLS[lang] ? lang : 'ja';
  if (PWA_EXAMPLES_CACHE[key]) return Promise.resolve(PWA_EXAMPLES_CACHE[key]);
  if (!PWA_EXAMPLES_PROMISES[key]) {
    PWA_EXAMPLES_PROMISES[key] = fetch(PWA_EXAMPLES_URLS[key])
      .then(r => r.json())
      .then(j => { PWA_EXAMPLES_CACHE[key] = j.words || j; return PWA_EXAMPLES_CACHE[key]; })
      .catch(() => ({}));
  }
  return PWA_EXAMPLES_PROMISES[key];
}

// Also escapes quotes (not just &/</>) so this is safe to interpolate
// into an HTML attribute value too, not just a text node -- needed now
// that example-sentence fallback text (real prose, can contain "quoted
// dialogue" or an apostrophe) gets written into data-text attributes
// below, unlike the short single-word glosses escapeEx previously only
// ever had to handle.
function escapeEx(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Tatoeba's own search, in the pair the learner is actually studying. This
// used to be hardcoded to jpn<->eng whichever direction was on screen, so a
// Hindi or French learner was sent to a Japanese-English search for a word
// that isn't in either language.
const TATOEBA_LANG = { ja: 'jpn', en: 'eng', hi: 'hin', fr: 'fra' };

function tatoebaUrl(form, readingEn, dir) {
  const [top, bottom] = String(dir || currentDirection || 'JA_EN').toLowerCase().split('_');
  const from = TATOEBA_LANG[top] || 'jpn';
  const to = TATOEBA_LANG[bottom] || 'eng';
  return `https://tatoeba.org/en/sentences/search?from=${from}&to=${to}&query=`
    + encodeURIComponent(form);
}

// readingEn puts the language actually being studied on top (bigger,
// primary colour) and its translation underneath (muted) -- same
// top/bottom convention as the extension's ptwExamplesHtml. The
// pwa-ex-ja/pwa-ex-en class names are positional (top slot / bottom
// slot), not literal, matching how the extension's identically-named
// classes already work.
// r.ja_furigana is precomputed <ruby>kanji<rt>reading</rt></ruby> HTML
// (see /private/tmp/.../gen_example_furigana.js, run offline against the
// real kuromoji tokenizer -- baking it into the data files avoids
// shipping the tokenizer + dictionary to every visitor just to reread
// the same fixed sentences on every page load). Falls back to plain
// escaped text for any row generated before that pass existed.
function jaHtml(r) {
  return r.ja_furigana || escapeEx(r.ja);
}
function exampleRow(r, readingEn) {
  const top = readingEn ? escapeEx(r.en) : jaHtml(r);
  const bottom = readingEn ? jaHtml(r) : escapeEx(r.en);
  // Furigana lands in whichever slot (top/bottom) holds the Japanese
  // sentence, which flips with direction -- pwa-ex-has-furigana marks
  // that slot specifically so only it gets the extra line-height ruby
  // annotations need, not whichever slot happens to hold plain English.
  const topFuri = !readingEn && r.ja_furigana;
  const bottomFuri = readingEn && r.ja_furigana;
  // r.ja_audio_url/r.en_audio_url are precomputed by the same offline
  // batch pass as ja_furigana above (see gen_example_audio.py), reusing
  // the exact voices already used for the flashcards' own audio
  // (ja-JP-KeitaNeural / en-US-GuyNeural). playAudio() already falls
  // back to the device's own TTS when a URL is missing -- so a sentence
  // this pass hasn't reached yet still plays something instead of doing
  // nothing, same graceful-degradation pattern the card's own audio
  // buttons already use for dictionary-only (non-recorded) words.
  const topAudio = readingEn ? exAudioBtn(r.en_audio_url, r.en, 'en') : exAudioBtn(r.ja_audio_url, r.ja, 'ja');
  const bottomAudio = readingEn ? exAudioBtn(r.ja_audio_url, r.ja, 'ja') : exAudioBtn(r.en_audio_url, r.en, 'en');
  // Hindi support: show all 3 languages when Hindi is available, with audio
  const hindiAudio = r.hi ? exAudioBtn(r.hi_audio_url, r.hi, 'hi') : '';
  const hindiRow = r.hi ? `<div class="pwa-ex-hi"><span class="pwa-ex-lang-flag">🇮🇳</span>${hindiAudio}<span class="pwa-ex-text">${escapeEx(r.hi)}</span></div>` : '';
  // French support: show French when available
  const frenchAudio = r.fr ? exAudioBtn(r.fr_audio_url, r.fr, 'fr') : '';
  const frenchRow = r.fr ? `<div class="pwa-ex-fr"><span class="pwa-ex-lang-flag">🇫🇷</span>${frenchAudio}<span class="pwa-ex-text">${escapeEx(r.fr)}</span></div>` : '';
  return `
      <div class="pwa-ex pwa-ex-multilingual">
        <div class="pwa-ex-ja${topFuri ? ' pwa-ex-has-furigana' : ''}"><span class="pwa-ex-lang-flag">${readingEn ? '🇺🇸' : '🇯🇵'}</span>${topAudio}<span class="pwa-ex-text">${top}</span></div>
        <div class="pwa-ex-en${bottomFuri ? ' pwa-ex-has-furigana' : ''}"><span class="pwa-ex-lang-flag">${readingEn ? '🇯🇵' : '🇺🇸'}</span>${bottomAudio}<span class="pwa-ex-text">${bottom}</span></div>
        ${hindiRow}
        ${frenchRow}
      </div>`;
}

function exAudioBtn(url, text, lang) {
  if (!text) return '';
  return `<button class="pwa-ex-audio-btn" type="button" aria-label="Play audio"
      data-audio="${escapeEx(url || '')}" data-text="${escapeEx(text)}" data-lang="${lang}"
      onclick="playExampleAudio(this)">&#128266;</button>`;
}
function playExampleAudio(btn) {
  playAudio(btn.dataset.audio, btn.dataset.text, btn.dataset.lang);
}

const EX_LANG_FLAG = { ja: '🇯🇵', en: '🇺🇸', hi: '🇮🇳', fr: '🇫🇷' };

function exLangText(r, lang) {
  return lang === 'ja' ? jaHtml(r) : escapeEx(r[lang] || '');
}

// exampleRow() above is hardcoded to a JA/EN top/bottom pair plus
// unconditional Hindi/French bonus rows -- fine for JA/EN/HI directions,
// but wrong for a French-involving pair (JA_FR, EN_FR, HI_FR and their
// reverses), where the two selected languages are never both JA and EN.
// This renders exactly the two languages of the current direction instead.
function directionExampleRow(topLang, bottomLang) {
  return r => {
    const topFuri = topLang === 'ja' && !!r.ja_furigana;
    const bottomFuri = bottomLang === 'ja' && !!r.ja_furigana;
    const topAudio = exAudioBtn(r[`${topLang}_audio_url`], r[topLang], topLang);
    const bottomAudio = exAudioBtn(r[`${bottomLang}_audio_url`], r[bottomLang], bottomLang);
    // Any OTHER language this row happens to carry, shown under the pair being
    // studied. Introduced 2026-09-10 as a two-language renderer, because
    // French directions were rendering all four languages and that read as a
    // bug against a single direction. It is not a bug against the product:
    // comparing the same sentence across languages is one of the reasons PTW
    // keys everything to a shared concept. So the direction's own two
    // languages lead, at full size, and the rest follow quietly as a
    // comparison -- rather than the choice being all-four or exactly-two.
    const others = ['ja', 'en', 'hi', 'fr'].filter(
      l => l !== topLang && l !== bottomLang && r[l]);
    const extra = others.map(l => `
        <div class="pwa-ex-also"><span class="pwa-ex-lang-flag">${EX_LANG_FLAG[l]}</span>${
          exAudioBtn(r[`${l}_audio_url`], r[l], l)
        }<span class="pwa-ex-text">${exLangText(r, l)}</span></div>`).join('');
    return `
      <div class="pwa-ex pwa-ex-multilingual">
        <div class="pwa-ex-ja${topFuri ? ' pwa-ex-has-furigana' : ''}"><span class="pwa-ex-lang-flag">${EX_LANG_FLAG[topLang]}</span>${topAudio}<span class="pwa-ex-text">${exLangText(r, topLang)}</span></div>
        <div class="pwa-ex-en${bottomFuri ? ' pwa-ex-has-furigana' : ''}"><span class="pwa-ex-lang-flag">${EX_LANG_FLAG[bottomLang]}</span>${bottomAudio}<span class="pwa-ex-text">${exLangText(r, bottomLang)}</span></div>
        ${extra}
      </div>`;
  };
}


// Every row in a given word's example set comes from exactly ONE source
// (confirmed against the data: Wiktionary is only ever used to fill a word
// Tatoeba has zero coverage for, never mixed in alongside Tatoeba rows for
// the same word) -- same invariant and same check the extension's
// content.js/popup.js already rely on (ptwExampleSourceIsWiktionary),
// checking just rows[0] tells you the source for the whole block.
// No shipped row carries source:"wiktionary" any more -- the gap-fill was
// removed on 2026-09-14 because Wiktionary is crowd-edited rather than
// native-speaker vetted. This branch is kept working rather than deleted: if
// the source is ever re-admitted deliberately, the credit line and the
// "more on Wiktionary" link are already correct for it.
function pwaExamplesAreWiktionary(rows) {
  return !!(rows && rows[0] && rows[0].source === 'wiktionary');
}

// Per explicit instruction (2026-10-14): one flat "Examples" list, no
// separate "More examples" fold and no sub-grouping by inflected form --
// the card's own example data already never exceeds 5 rows (verified
// against examples.json: max is 5 per concept per direction, corpus-wide),
// so there was never a real need to hide any of them behind a click.
function examplesHtml(rows, lemma, readingEn, rowFn) {
  if (!rows || !rows.length) return '';
  const row = rowFn || (r => exampleRow(r, readingEn));
  const all = rows.map(row).join('');
  const credit = 'Sentences generated by AI, individually audited for accuracy';
  return `<div class="card-extra pwa-ex-block">
      <div class="card-extra-head">Examples</div>
      ${all}
      <div class="pwa-ex-credit">${credit}</div>
    </div>`;
}

function fillExamples(concept) {
  const slot = document.getElementById('pwa-ex-slot');
  if (!slot) return;
  const dir = (currentDirection || prefDirection || 'JA_EN').toUpperCase();
  const [topLang, bottomLang] = dir.toLowerCase().split('_');
  let lemma = (concept.labels && concept.labels[topLang]) || (topLang === 'fr' ? (concept.french || '') : '');
  const readingEn = false;

  loadUnifiedExamples().then(unified => {
    const conceptData = unified && unified[concept.concept_id];
    const allRows = (conceptData && conceptData.sentences) || [];
    const rows = allRows.filter(r => r[topLang] && r[bottomLang]);
    slot.innerHTML = examplesHtml(rows, lemma, readingEn, directionExampleRow(topLang, bottomLang));
  });
}
