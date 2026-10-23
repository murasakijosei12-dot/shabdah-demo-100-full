/* custom-cards.js
   "My Created Cards" -- user-uploaded image + user-typed meaning/
   translations, a personal flashcard alongside the curated deck.

   Design: a custom card's Supabase row id starts at 9,000,001 (see
   migrations/2026-09-20_add_custom_cards.sql), safely above the real
   curated concept_id range. That id is merged straight into the global
   `CARDS` array (script.js) with the same shape a real concept has, so
   every already-existing mechanism that keys off `concept_id` --
   Favorites, "add to My Categories" (account.js), Notes (notes.js),
   openConcept()'s lookup, renderConceptTile()'s grid rendering -- works
   for a custom card with no changes of its own. The two places that
   previously assumed every concept_id draws from the shared 200-item
   free-tier pool (saveNote() in notes.js, handleAddToExistingCategory/
   handleAddToNewCategory in account.js) each get a one-line bypass: a
   card a user made themselves isn't curated content, so it was never
   meant to count against that allowance.

   Uses global `supabaseClient`, `getCurrentUser()` (auth.js), `CARDS`
   (script.js), `playAudio()`/`escapeHtml()` (script.js),
   `renderNotePanel()` (notes.js), `openAddToCategoryPicker()` (account.js). */

const PTW_CUSTOM_CARD_ID_START = 9000001;

function isCustomCardId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n >= PTW_CUSTOM_CARD_ID_START;
}

// ── Merge into CARDS ─────────────────────────────────────────────
function customCardToConceptShape(row) {
  const en = row.en || '';
  return {
    concept_id: String(row.id),
    category_id: 'my_created',
    category_label: 'My Created Cards',
    english: en,
    labels: { en, ja: row.ja || '', hi: row.hi || '', fr: row.fr || '' },
    sort_ja: row.ja || en,
    // A single synthetic "direction" -- custom cards have one photo and
    // aren't studied in a JA_EN/HI_EN/FR_EN pair the way the curated deck
    // is, so there's nothing to pick between. firstAvailableDirection()
    // (script.js) already falls back to Object.keys(directions)[0] when
    // prefDirection isn't found, so this key can be anything.
    directions: { ALL: { label: 'My Created Cards', image_url: row.image || '' } },
    is_custom: true,
    custom_row: row,
  };
}

async function loadCustomCardsIntoCards() {
  const user = await getCurrentUser();
  // Drop any custom cards from a previous load/user before re-adding --
  // otherwise switching accounts, or calling this again after a create/
  // edit/delete, would leave stale or duplicate entries in CARDS.
  CARDS = CARDS.filter(c => !c.is_custom);
  if (!user) return;

  const { data, error } = await supabaseClient
    .from('custom_cards')
    .select('id, image, en, ja, hi, fr')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error || !data) return;

  for (const row of data) CARDS.push(customCardToConceptShape(row));
}

// ── "My Created Cards" list (avatar menu entry, same pattern as
//    openFavorites()/openMyCategories()/openHistory() in account.js) ──
async function openMyCards() {
  document.getElementById('account-overlay').classList.add('open');
  renderMyCardsTab();
}

async function renderMyCardsTab() {
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';
  const user = await getCurrentUser();
  if (!user) { body.innerHTML = accountLoginPrompt(); return; }

  await loadCustomCardsIntoCards();
  const concepts = CARDS.filter(c => c.is_custom);

  const gridHtml = concepts.length
    ? `<div class="deck">${concepts.map(c => renderConceptTile(c, `deleteCustomCard('${c.concept_id}')`)).join('')}</div>`
    : '<p class="notes-empty">No cards yet -- create your first one below.</p>';

  body.innerHTML = `
    <h3 style="font-size:14px; margin-bottom:10px;">My Created Cards (${concepts.length})</h3>
    <button class="btn-primary" style="margin-bottom:14px;" onclick="openCreateCardForm()">+ Create a card</button>
    ${gridHtml}
  `;
  applyStarDisplay();
}

// ── Create / edit form ───────────────────────────────────────────
// One form for both: editCustomCard() pre-fills it and submitCustomCard()
// updates instead of inserting when ptwEditingCardId is set.
let ptwEditingCardId = null;
let ptwCreateCardImageDataUrl = null;

function openCreateCardForm() {
  ptwEditingCardId = null;
  ptwCreateCardImageDataUrl = null;
  document.getElementById('create-card-title').textContent = 'Create a card';
  document.getElementById('create-card-delete-btn').style.display = 'none';
  ['en', 'ja', 'hi', 'fr'].forEach(l => { document.getElementById(`create-card-${l}`).value = ''; });
  document.getElementById('create-card-image-input').value = '';
  document.getElementById('create-card-image-preview').innerHTML = '';
  document.getElementById('create-card-status').textContent = '';
  document.getElementById('create-card-overlay').classList.add('open');
}

async function editCustomCard(conceptId) {
  const concept = CARDS.find(c => c.concept_id === String(conceptId));
  if (!concept || !concept.is_custom) return;
  const row = concept.custom_row;
  ptwEditingCardId = row.id;
  ptwCreateCardImageDataUrl = row.image || null;
  document.getElementById('create-card-title').textContent = 'Edit card';
  document.getElementById('create-card-delete-btn').style.display = '';
  document.getElementById('create-card-en').value = row.en || '';
  document.getElementById('create-card-ja').value = row.ja || '';
  document.getElementById('create-card-hi').value = row.hi || '';
  document.getElementById('create-card-fr').value = row.fr || '';
  document.getElementById('create-card-image-input').value = '';
  document.getElementById('create-card-image-preview').innerHTML =
    row.image ? `<img src="${row.image}" alt="">` : '';
  document.getElementById('create-card-status').textContent = '';
  closeFocus();
  document.getElementById('create-card-overlay').classList.add('open');
}

function closeCreateCardForm() {
  document.getElementById('create-card-overlay').classList.remove('open');
}

// Resizes to a max of 640px on the longest side and re-encodes as JPEG at
// 0.75 quality before it ever reaches Supabase -- a phone photo straight
// out of a gallery can be several MB, and this feature stores the image
// as a base64 text column rather than provisioning a new Supabase Storage
// bucket (this project has never used Storage before), so keeping the
// encoded size small (typically tens of KB after this) is what makes
// that simpler design viable.
function resizeImageFile(file, maxDim = 640, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(new Error('Could not read that image file.'));
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Could not read that image file.'));
    reader.readAsDataURL(file);
  });
}

async function handleCreateCardImagePick(file) {
  if (!file) return;
  const statusEl = document.getElementById('create-card-status');
  statusEl.textContent = 'Processing image…';
  try {
    ptwCreateCardImageDataUrl = await resizeImageFile(file);
    document.getElementById('create-card-image-preview').innerHTML =
      `<img src="${ptwCreateCardImageDataUrl}" alt="">`;
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = e.message;
  }
}

async function submitCustomCard() {
  const statusEl = document.getElementById('create-card-status');
  const user = await getCurrentUser();
  if (!user) { statusEl.textContent = 'Please log in first.'; return; }

  const en = document.getElementById('create-card-en').value.trim();
  const ja = document.getElementById('create-card-ja').value.trim();
  const hi = document.getElementById('create-card-hi').value.trim();
  const fr = document.getElementById('create-card-fr').value.trim();
  if (!ptwCreateCardImageDataUrl) { statusEl.textContent = 'Add a photo first.'; return; }
  if (!en && !ja && !hi && !fr) { statusEl.textContent = 'Add at least one language.'; return; }

  statusEl.textContent = 'Saving…';
  const row = { user_id: user.id, image: ptwCreateCardImageDataUrl, en, ja, hi, fr };
  const { error } = ptwEditingCardId
    ? await supabaseClient.from('custom_cards').update(row).eq('id', ptwEditingCardId)
    : await supabaseClient.from('custom_cards').insert(row);

  if (error) { statusEl.textContent = 'Could not save. Try a smaller photo.'; return; }
  closeCreateCardForm();
  await loadCustomCardsIntoCards();
  if (document.getElementById('account-overlay').classList.contains('open')) renderMyCardsTab();
}

async function deleteCustomCard(conceptId) {
  const id = Number(conceptId);
  await supabaseClient.from('custom_cards').delete().eq('id', id);
  // Best-effort cleanup so a deleted card doesn't leave an orphan row
  // sitting in a user's Favorites/Notes/My Categories -- harmless if it
  // did (CARDS.find(...).filter(Boolean) already drops anything that no
  // longer resolves), but tidier not to leave it.
  const user = await getCurrentUser();
  if (user) {
    await supabaseClient.from('favourites').delete().eq('user_id', user.id).eq('concept_id', id);
    await supabaseClient.from('notes').delete().eq('user_id', user.id).eq('concept_id', id);
    const { data: cats } = await supabaseClient
      .from('custom_categories').select('id').eq('user_id', user.id);
    if (cats && cats.length) {
      await supabaseClient.from('custom_category_cards').delete()
        .eq('concept_id', id).in('category_id', cats.map(c => c.id));
    }
  }
  closeFocus();
  await loadCustomCardsIntoCards();
  if (document.getElementById('account-overlay').classList.contains('open')) renderMyCardsTab();
}

// ── Detail view (injected into #focus-card-inner by openConcept(),
//    which already opens/sizes/closes the shared overlay itself) ──
function renderCustomCardDetail(concept) {
  const row = concept.custom_row;
  const langRow = (lang, label, text) => text ? `
    <div class="custom-card-lang-row">
      <span class="custom-card-lang-label">${label}</span>
      <span class="custom-card-lang-text">${escapeHtml(text)}</span>
      <button class="audio-btn" onclick="playAudio(null, '${escapeHtml(text).replace(/'/g, "\\'")}', '${lang}')">🔊</button>
    </div>` : '';

  document.getElementById('focus-card-inner').innerHTML = `
    <div class="focus-card-img-wrap">
      <img class="focus-card-img" src="${row.image || ''}" alt="${escapeHtml(row.en || '')}">
      <button class="focus-zoom-btn" onclick="toggleFocusZoom()" aria-label="Enlarge card" title="Enlarge card">⤢</button>
    </div>
    <div class="custom-card-langs">
      ${langRow('en', 'English', row.en)}
      ${langRow('ja', 'Japanese', row.ja)}
      ${langRow('hi', 'Hindi', row.hi)}
      ${langRow('fr', 'French', row.fr)}
    </div>
    <div class="card-actions">
      <span onclick="editCustomCard('${concept.concept_id}')" class="card-action">Edit</span>
      <span onclick="openAddToCategoryPicker('${concept.concept_id}', 'ALL')" class="card-action">+ Add to Category</span>
      <span onclick="if(confirm('Delete this card?'))deleteCustomCard('${concept.concept_id}')"
        class="card-action card-action-quiet">Delete</span>
    </div>
    <button class="note-panel-toggle" id="note-panel-toggle" onclick="toggleNotePanel()">
      <span>📝 Example sentences / notes</span>
      <span class="chevron">▾</span>
    </button>
    <div class="note-panel-body" id="note-panel-body">
      <div id="note-panel"></div>
    </div>
  `;
  if (typeof renderNotePanel === 'function') renderNotePanel(concept.concept_id, 'ALL');
}
