/* nav-data.js
   Lets the account dropdown (My Notes / My Categories / Favorites /
   History / Review) work correctly on the static marketing pages
   (about.html, pricing.html, how-to-use.html, etc.), not just index.html.

   notes.js/account.js/reviews.js were written assuming script.js's globals
   (CARDS, CATEGORIES, prefDirection, prefLang, labelFor, firstAvailableDirection)
   already exist -- but script.js itself can't be loaded here as-is: its own
   boot() auto-runs on DOMContentLoaded and renders the full homepage grid/
   sidebar into elements (#home-cat-grid, #sidebar-nav, #page-home, #page-app)
   that don't exist on these pages. This file provides the same globals and
   small helper functions those three modules actually need, without any of
   script.js's homepage-specific rendering.

   openConcept() is redefined here to redirect to index.html's existing
   #/word/<id> deep-link handler (see script.js's openFromHash()) rather
   than trying to render an in-page card detail view -- these pages don't
   have #focus-overlay or renderConceptDetail()'s dependencies, and
   redirecting to the one page that does is simpler and already tested. */

let CARDS = [];
let CATEGORIES = [];
let prefDirection = localStorage.getItem('ptw_pref_direction') || 'JA_EN';
let prefLang = localStorage.getItem('ptw_pref_lang') || 'en';

// Favourites (the star system) -- account.js's renderFavoritesTab() and
// renderConceptTile() both reference these directly, exactly as they do
// when script.js provides them on index.html. Missing entirely here meant
// tapping Favorites on any of these pages threw "starred is not defined"
// the instant renderFavoritesTab() ran -- past the "Loading…" placeholder,
// so nothing further ever rendered and no error was visible to a learner,
// just a modal stuck on "Loading…" that read as "nothing happens."
// Ported verbatim from script.js so behaviour (including the offline-safe
// merge with the account's remote favourites) matches exactly.
let starred = new Set();

function saveStars() {
  try { localStorage.setItem('ptw_stars', JSON.stringify([...starred])); } catch (e) {}
}

function loadStars() {
  try {
    const saved = JSON.parse(localStorage.getItem('ptw_stars') || '[]');
    starred = new Set(saved);
  } catch (e) { starred = new Set(); }
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
  const remoteIds = data.map(r => String(r.concept_id));
  let changed = false;
  for (const id of remoteIds) {
    if (!starred.has(id)) { starred.add(id); changed = true; }
  }
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

function toggleStar(evt, id) {
  evt.stopPropagation();
  const nowStarred = !starred.has(id);
  if (nowStarred) starred.add(id); else starred.delete(id);
  saveStars();
  applyStarDisplay();
  syncStarChange(id, nowStarred).catch(() => {});
}

// account.js's renderCategoriesTab() escapes a category's name before
// embedding it in an onclick attribute -- defined in reviews.js on
// index.html, but reviews.js itself is never loaded on these pages, so
// this threw the moment a real user (with at least one saved category)
// opened My Categories. An empty category list never hit this line, which
// is why it was easy to miss in testing.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// renderFavoritesTab() in account.js calls this to build each tile in the
// favourites grid -- also only ever defined in script.js before.
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

function labelFor(concept) {
  return (concept.labels && concept.labels[prefLang]) || concept.english;
}

function firstAvailableDirection(concept) {
  if (concept.directions[prefDirection]) return prefDirection;
  return Object.keys(concept.directions)[0];
}

function openConcept(conceptId) {
  window.location.href = 'index.html#/word/' + encodeURIComponent(conceptId);
}

// "Leave a review" (in the avatar dropdown) renders its form into
// #reviews-section, which only exists on the homepage -- reviews.js itself
// is never loaded here at all, so the account menu's onclick threw
// "leaveReview is not defined" the instant it was tapped on any of these
// pages. Same fix as openConcept above: redirect to the one page that
// actually has this feature, rather than rebuilding it here.
function leaveReview() {
  window.location.href = 'index.html';
}

function speakJa(text) {
  if (!text || !('speechSynthesis' in window)) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
    if (synth.paused) synth.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    const voices = synth.getVoices ? synth.getVoices() : [];
    const jaVoice = voices.find(v => v.lang === 'ja-JP') || voices.find(v => v.lang && v.lang.startsWith('ja'));
    if (jaVoice) u.voice = jaVoice;
    synth.speak(u);
  } catch (err) { /* no voice available - stay silent rather than throw */ }
}

function playAudio(url, fallbackText) {
  if (!url) {
    if (fallbackText) speakJa(fallbackText);
    return;
  }
  const audio = new Audio(url);
  audio.play().catch(err => {
    console.log('Audio play error:', err);
    if (fallbackText) speakJa(fallbackText);
  });
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const notes = document.getElementById('notes-overlay');
  const account = document.getElementById('account-overlay');
  const auth = document.getElementById('auth-overlay');
  const review = document.getElementById('review-overlay');
  if (notes && notes.classList.contains('open')) closeMyNotes();
  if (account && account.classList.contains('open')) closeMyAccount();
  if (auth && auth.classList.contains('open')) closeAuth();
  if (review && review.classList.contains('open')) closeReview();
});

(async function loadNavData() {
  try {
    const [cardsRes, catRes] = await Promise.all([
      fetch('data/cards.json'),
      fetch('data/categories.json'),
    ]);
    if (cardsRes.ok) CARDS = await cardsRes.json();
    if (catRes.ok) CATEGORIES = await catRes.json();
  } catch (e) {
    // My Notes/Categories/History still open; list items just show plainer
    // text (no thumbnail/label lookup) until this succeeds on a retry.
    console.error('PTW nav-data failed to load:', e);
  }
})();

// script.js calls this on boot; these pages need the same call so
// Favorites shows what's actually starred instead of always starting empty.
loadStars();
