/* srs.js
   SM-2 spaced repetition engine, wired to the Supabase `progress` table.
   Uses global `supabaseClient` (from index.html) and `CARDS` (from script.js).

   Offline layer: IndexedDB holds a local mirror of this user's progress
   rows (so Review can render without a live fetch) plus a mutation queue
   (so add/remove/review actions taken offline are never lost and are
   replayed, in order, once the network comes back). Chosen over
   localStorage because the data here is structured and grows with every
   review, not a handful of flags -- IndexedDB is the right tool once you
   need a keyed store with cheap upserts. */

// ── SM-2 scheduling math ───────────────────────────────────────
// quality: 2 = "Again" (failed), 4 = "Good" (passed) - simplified 2-button
// version of the classic 0-5 scale, same math either way.
function sm2NextState(quality, prev) {
  let { ease_factor, interval_days, review_count } = prev;

  if (quality < 3) {
    review_count = 0;
    interval_days = 1;
  } else {
    review_count += 1;
    if (review_count === 1) interval_days = 1;
    else if (review_count === 2) interval_days = 6;
    else interval_days = Math.round(interval_days * ease_factor);
  }

  ease_factor = Math.max(1.3, ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + interval_days);

  return {
    ease_factor,
    interval_days,
    review_count,
    next_review_date: nextDate.toISOString().slice(0, 10),
    last_reviewed: new Date().toISOString(),
  };
}

const DEFAULT_STATE = { ease_factor: 2.5, interval_days: 0, review_count: 0 };

// ── IndexedDB: local progress mirror + pending-mutation queue ───────
const PTW_DB_NAME = 'ptw_offline';
const PTW_DB_VERSION = 1;
const PTW_STORE_PROGRESS = 'progress_cache';   // keyPath: `${user_id}_${concept_id}_${pair}`
const PTW_STORE_QUEUE = 'mutation_queue';      // autoIncrement id

function ptwOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PTW_DB_NAME, PTW_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PTW_STORE_PROGRESS)) {
        db.createObjectStore(PTW_STORE_PROGRESS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PTW_STORE_QUEUE)) {
        db.createObjectStore(PTW_STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function ptwProgressKey(userId, conceptId, pair) {
  return `${userId}_${conceptId}_${pair}`;
}

async function ptwIdbTx(storeName, mode, fn) {
  const db = await ptwOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then(r => { result = r; })
      .catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function ptwReqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function ptwCacheProgressRows(userId, rows) {
  await ptwIdbTx(PTW_STORE_PROGRESS, 'readwrite', async (store) => {
    for (const row of rows) {
      store.put({ key: ptwProgressKey(userId, row.concept_id, row.pair), ...row });
    }
  });
}

async function ptwCacheOneProgressRow(userId, conceptId, pair, state) {
  await ptwIdbTx(PTW_STORE_PROGRESS, 'readwrite', (store) => {
    store.put({ key: ptwProgressKey(userId, conceptId, pair), user_id: userId, concept_id: conceptId, pair, ...state });
  });
}

async function ptwRemoveCachedProgressRow(userId, conceptId, pair) {
  await ptwIdbTx(PTW_STORE_PROGRESS, 'readwrite', (store) => {
    store.delete(ptwProgressKey(userId, conceptId, pair));
  });
}

async function ptwReadCachedProgress(userId) {
  const all = await ptwIdbTx(PTW_STORE_PROGRESS, 'readonly', (store) => ptwReqToPromise(store.getAll()));
  return (all || []).filter(r => r.user_id === userId);
}

async function ptwEnqueueMutation(mutation) {
  await ptwIdbTx(PTW_STORE_QUEUE, 'readwrite', (store) => {
    store.add({ ...mutation, queued_at: new Date().toISOString() });
  });
}

async function ptwReadQueue() {
  return ptwIdbTx(PTW_STORE_QUEUE, 'readonly', (store) => ptwReqToPromise(store.getAll())) || [];
}

async function ptwDequeueMutation(id) {
  await ptwIdbTx(PTW_STORE_QUEUE, 'readwrite', (store) => store.delete(id));
}

// A card newly added or reviewed while offline needs SOMETHING to render
// with (image/lemma/gloss) even though CARDS itself is already cached by
// the service worker independently of this file -- no extra caching
// needed here, buildReviewQueue already reads from the same CARDS global.

// ── Supabase reads/writes (each now local-cache-aware) ──────────────
async function fetchAllProgress(userId) {
  try {
    // supabase-js doesn't fail fast on a hard offline network condition --
    // measured at 6-12s before this call's own promise rejects, during
    // which the Review screen just sat on "Loading..." with no
    // indication it would ever resolve. Race it against a short timeout
    // so the (correct, already-implemented) cache fallback below actually
    // fires quickly instead of technically-working-but-feeling-broken.
    const { data, error } = await Promise.race([
      supabaseClient.from('progress').select('*').eq('user_id', userId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('progress fetch timeout')), 3000)),
    ]);
    if (error) throw error;
    // Refresh the local mirror on every successful online read, so the
    // next offline session has the latest state to fall back to.
    ptwCacheProgressRows(userId, data).catch(() => {});
    return data;
  } catch (err) {
    console.warn('Progress fetch failed (offline?), using local cache:', err.message);
    return ptwReadCachedProgress(userId);
  }
}

// Writes locally FIRST (so the caller can update the UI immediately and
// correctly, whether or not the network is up), then tries the live
// write. A failed live write queues the mutation instead of just logging
// it -- the previous version's error was silent to the user and the
// change was gone forever if the tab closed before reconnecting.
async function saveProgress(userId, conceptId, pair, newState) {
  await ptwCacheOneProgressRow(userId, conceptId, pair, newState);
  try {
    // item_key is the universal identity shared with the extension: the
    // concept id as text here, the word's own stable id for the ~47,000
    // dictionary words that have no concept id at all. Rows written without
    // it are invisible to the new (user_id, pair, item_key) index, which
    // makes the extension's write fail once and retry on the legacy
    // constraint every single time. Same value, no behaviour change --
    // onConflict deliberately stays on the original constraint so this is
    // safe regardless of deploy order.
    const { error } = await supabaseClient
      .from('progress')
      .upsert({ user_id: userId, concept_id: conceptId, item_key: String(conceptId), pair, ...newState },
              { onConflict: 'user_id,concept_id,pair' });
    if (error) throw error;
    return { synced: true };
  } catch (err) {
    await ptwEnqueueMutation({ type: 'upsert', user_id: userId, concept_id: conceptId, pair, state: newState });
    console.warn('Progress save queued for later sync (offline?):', err.message);
    return { synced: false };
  }
}

async function deleteProgressRow(userId, conceptId, pair) {
  await ptwRemoveCachedProgressRow(userId, conceptId, pair);
  try {
    const { error } = await supabaseClient
      .from('progress')
      .delete()
      .eq('user_id', userId)
      .eq('concept_id', conceptId)
      .eq('pair', pair);
    if (error) throw error;
    return { synced: true };
  } catch (err) {
    await ptwEnqueueMutation({ type: 'delete', user_id: userId, concept_id: conceptId, pair });
    console.warn('Progress delete queued for later sync (offline?):', err.message);
    return { synced: false };
  }
}

// ── Flushing the queue on reconnect ──────────────────────────────────
// Replayed strictly in the order they were queued, and stops on the
// first failure rather than skipping ahead -- a later mutation for the
// same row depends on the earlier one having landed, so replaying out of
// order (or dropping a failed one) could resurrect a card the user
// removed, or overwrite a newer state with an older one.
//
// Both mutation types upsert/delete on the same (user_id, concept_id,
// pair) key the table's own unique constraint uses, so a mutation that
// was somehow already applied (e.g. a previous flush got the Supabase
// write through but the network dropped before the local dequeue
// completed) is a no-op the second time, not a duplicate row.
let ptwFlushInFlight = false;

async function flushMutationQueue() {
  if (ptwFlushInFlight) return;
  ptwFlushInFlight = true;
  try {
    const queue = await ptwReadQueue();
    for (const m of queue) {
      try {
        if (m.type === 'upsert') {
          const { error } = await supabaseClient
            .from('progress')
            .upsert({ user_id: m.user_id, concept_id: m.concept_id, pair: m.pair, ...m.state }, { onConflict: 'user_id,concept_id,pair' });
          if (error) throw error;
        } else if (m.type === 'delete') {
          const { error } = await supabaseClient
            .from('progress')
            .delete()
            .eq('user_id', m.user_id)
            .eq('concept_id', m.concept_id)
            .eq('pair', m.pair);
          if (error) throw error;
        }
        await ptwDequeueMutation(m.id);
      } catch (err) {
        console.warn('Mutation sync failed, will retry later:', err.message);
        break; // stop here, preserve order, try again on the next reconnect
      }
    }
    // Re-pull the review set / open review screen so the UI reflects
    // whatever just synced, without the user having to reload.
    const user = await getCurrentUser();
    if (user) {
      await loadReviewSet(user.id);
      if (document.getElementById('review-overlay')?.classList.contains('open')) {
        reviewQueue = await buildReviewQueue(user.id, reviewPair);
        renderReviewCard();
      }
    }
  } finally {
    ptwFlushInFlight = false;
  }
}

window.addEventListener('online', () => { flushMutationQueue().catch(() => {}); });
// Also try once at load, in case mutations were queued in a previous
// session that ended while still offline.
document.addEventListener('DOMContentLoaded', () => {
  if (navigator.onLine) flushMutationQueue().catch(() => {});
});

async function ptwHasPendingMutations() {
  const queue = await ptwReadQueue();
  return queue.length > 0;
}

// ── Building the "in my deck, due today" queue ─────────────────
// Review now ONLY includes concepts the user explicitly added (via the
// "+ Add to Review" button, or - once wired - the browser extension's
// "add to deck" button, which writes to the same `progress` table).
// Nothing is auto-included just because it exists in the dataset.
async function buildReviewQueue(userId, pair) {
  const today = new Date().toISOString().slice(0, 10);
  const allProgress = await fetchAllProgress(userId);

  return allProgress
    .filter(p => p.pair === pair && p.next_review_date <= today)
    .map(p => ({ concept: CARDS.find(c => String(c.concept_id) === String(p.concept_id)), progress: p }))
    .filter(item => item.concept) // drop any row whose concept can't be found locally
    // ...and any whose concept has no data for this direction -- a stale
    // progress row left over from a pair that's since been discontinued
    // (e.g. EN_JA, removed 2026-09-16) would otherwise reach
    // renderReviewCard/flipReviewCard and crash on concept.directions[pair]
    // being undefined, hanging the whole Review screen on "Loading...".
    .filter(item => !!item.concept.directions[pair]);
}

// ── Tracking which cards are in the user's deck (for the +Add button) ──
let userReviewSet = new Set(); // keys: "conceptId_pair"

function reviewKey(conceptId, pair) { return `${conceptId}_${pair}`; }

async function loadReviewSet(userId) {
  if (!userId) { userReviewSet = new Set(); return; }
  const rows = await fetchAllProgress(userId);
  userReviewSet = new Set(rows.map(r => reviewKey(r.concept_id, r.pair)));
}

function isInReview(conceptId, pair) {
  return userReviewSet.has(reviewKey(conceptId, pair));
}

// "'200 concepts' means the first 200 in your chosen pair. You keep them
// permanently -- they are not a trial." (pricing.html). Draws from the
// SAME shared pool as Add-to-Notes and Add-to-Category now (see
// entitlement.js's ensureUnlocked/unlocked_items) -- previously this
// counted only Review's own userReviewSet, its own separate 200.
async function addToReview(conceptId, pair) {
  const user = await getCurrentUser();
  if (!user) { alert('Please log in to add cards to your review deck.'); openAuth(); return; }

  const gate = await ensureUnlocked(user.id, conceptId, pair, 'review');
  if (!gate.ok) {
    const btn = document.getElementById('review-add-btn');
    if (btn) {
      btn.textContent = '🔒 Unlock this pair';
      btn.style.color = '#a87c1a';
      btn.style.fontWeight = '600';
      btn.onclick = () => window.open('pricing.html', '_blank');
    }
    return;
  }

  const state = { ...DEFAULT_STATE, next_review_date: new Date().toISOString().slice(0, 10) };
  const { synced } = await saveProgress(user.id, conceptId, pair, state);
  userReviewSet.add(reviewKey(conceptId, pair));
  updateReviewButton(conceptId, pair, synced);
}

async function removeFromReview(conceptId, pair) {
  const user = await getCurrentUser();
  if (!user) return;
  await deleteProgressRow(user.id, conceptId, pair);
  userReviewSet.delete(reviewKey(conceptId, pair));
  updateReviewButton(conceptId, pair);
}

function toggleReview(conceptId, pair) {
  if (isInReview(conceptId, pair)) removeFromReview(conceptId, pair);
  else addToReview(conceptId, pair);
}

// synced === false means the change is saved locally only, still queued
// for Supabase -- shown as a distinct state so the UI never claims a
// sync that has not actually happened yet.
function updateReviewButton(conceptId, pair, synced) {
  const btn = document.getElementById('review-add-btn');
  if (!btn) return;
  if (isInReview(conceptId, pair)) {
    btn.textContent = synced === false ? '✓ In Review (pending sync)' : '✓ In Review';
    btn.style.color = synced === false ? '#a87c1a' : '#1a7a4c';
    btn.style.fontWeight = '600';
  } else {
    btn.textContent = '+ Add to Review';
    btn.style.color = '';
    btn.style.fontWeight = '';
  }
}

// ── Review session UI ───────────────────────────────────────────
let reviewQueue = [];
let reviewIndex = 0;
let reviewFlipped = false;
let reviewPair = 'JA_EN'; // uses the site's existing study-direction preference

async function openReview() {
  const user = await getCurrentUser();
  if (!user) {
    alert('Please log in first to start a review session.');
    openAuth();
    return;
  }

  reviewPair = prefDirection; // reuse the existing site-wide preference
  document.getElementById('review-overlay').classList.add('open');
  document.getElementById('review-card-area').innerHTML = '<p>Loading…</p>';
  reviewQueue = await buildReviewQueue(user.id, reviewPair);
  reviewIndex = 0;
  renderReviewCard();
}

function closeReview() {
  document.getElementById('review-overlay').classList.remove('open');
}

async function renderReviewCard() {
  const area = document.getElementById('review-card-area');
  const controls = document.getElementById('review-controls');
  const progressEl = document.getElementById('review-progress');
  const offlineNote = (!navigator.onLine || await ptwHasPendingMutations())
    ? `<p class="notes-empty" style="font-size:12px; color:#a87c1a; margin:4px 0 0;">${!navigator.onLine ? 'Offline — showing your cached deck. Changes will sync once you\'re back online.' : 'Some changes are still syncing.'}</p>`
    : '';

  if (reviewQueue.length === 0) {
    progressEl.textContent = '';
    area.innerHTML = `<p>Nothing in your review deck yet. Open a word and tap "+ Add to Review" to get started.</p>${offlineNote}`;
    controls.innerHTML = '<button onclick="closeReview()">Close</button>';
    return;
  }

  if (reviewIndex >= reviewQueue.length) {
    progressEl.textContent = '';
    area.innerHTML = `<p>All done for now! 🎉</p>${offlineNote}`;
    controls.innerHTML = '<button onclick="closeReview()">Close</button>';
    return;
  }

  const { concept } = reviewQueue[reviewIndex];
  const d = concept.directions[reviewPair];
  reviewFlipped = false;

  progressEl.textContent = `Card ${reviewIndex + 1} of ${reviewQueue.length}`;
  area.innerHTML = `
    <img id="review-img" class="review-crop-front" src="${d.image_url}" onclick="flipReviewCard()">
    <div style="margin-top:10px;">
      <button onclick="playAudio('${d.header_audio_url}')">🔊 Word</button>
    </div>
    ${offlineNote}
  `;
  renderReviewControls(false);
}

function renderReviewControls(flipped) {
  const controls = document.getElementById('review-controls');
  const backDisabled = reviewIndex === 0 ? 'disabled' : '';
  const middleBtn = flipped
    ? `<button onclick="retryReviewCard()">Retry</button>`
    : `<button onclick="flipReviewCard()">Show Answer</button>`;
  controls.innerHTML = `
    <button ${backDisabled} onclick="goBackReviewCard()">◀ Back</button>
    ${middleBtn}
    <button onclick="goNextReviewCard()">Next ▶</button>
    <button onclick="removeCurrentReviewCard()" title="Take this card out of your review deck" style="color:#a02020;">Remove from Review</button>
  `;
}

// Lets the user drop a card they don't want to keep reviewing, on the
// spot -- available whether or not they've flipped to see the answer.
// Previously the only way off a card was Retry/Next (both require
// flipping first) or leaving Review entirely to find the card's own
// page and un-toggle "+ Add to Review" there.
async function removeCurrentReviewCard() {
  if (reviewIndex >= reviewQueue.length) return;
  const { concept } = reviewQueue[reviewIndex];
  await removeFromReview(concept.concept_id, reviewPair);
  reviewQueue.splice(reviewIndex, 1);
  // Index already points at the next card (the removed one's slot is
  // gone), so no increment -- just re-render at the same index.
  renderReviewCard();
}

function flipReviewCard() {
  if (reviewFlipped) return;
  reviewFlipped = true;
  document.getElementById('review-img').classList.remove('review-crop-front');
  const { concept } = reviewQueue[reviewIndex];
  const d = concept.directions[reviewPair];
  document.getElementById('review-card-area').insertAdjacentHTML('beforeend',
    `<div id="review-meaning-audio" style="margin-top:6px;">
       <button onclick="playAudio('${d.footer_audio_url}')">🔊 Meaning</button>
     </div>`);
  renderReviewControls(true);
}

// Re-hides the answer on the SAME card, and silently logs a
// "needs more practice" signal so SM-2 schedules it sooner.
async function retryReviewCard() {
  await logSilentRating(2); // "Again" equivalent, not shown to the user
  renderReviewCard();
}

// Moves forward. If the answer had been revealed, silently logs a
// "remembered it" signal first, so SM-2 pushes the next review out further.
async function goNextReviewCard() {
  if (reviewFlipped) await logSilentRating(4); // "Good" equivalent
  reviewIndex++;
  renderReviewCard();
}

// Moves back to review a previous card again - no rating logged,
// pure navigation.
function goBackReviewCard() {
  if (reviewIndex === 0) return;
  reviewIndex--;
  renderReviewCard();
}

async function logSilentRating(quality) {
  const user = await getCurrentUser();
  const { concept, progress } = reviewQueue[reviewIndex];
  const newState = sm2NextState(quality, progress);
  await saveProgress(user.id, concept.concept_id, reviewPair, newState);
  reviewQueue[reviewIndex].progress = newState;
}
