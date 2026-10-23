/* account.js
   My account / My Categories / Favorites / History -- four independent
   entry points from the avatar dropdown, each opening the same modal
   shell (#account-overlay / .info-box) directly to its own content, no
   shared tab bar between them (see index.html's comment on that overlay
   for why -- a shared tab bar meant opening any one of these surfaced
   the other three right there too).
   Uses global `supabaseClient`, `getCurrentUser()` (auth.js), and `CARDS`
   (script.js). All four require login. */

// All twelve directions, matching cards.json and the study-direction selector.
// This listed only the two original pairs, so the My Account page showed two
// rows to someone who owns all twelve -- and the "unlock a pair" prompt below
// compared against a total of 2. The Hindi pairs had been shipping unlisted
// here since their launch; French would have joined them.
const PAIR_LABELS = {
  JA_EN: 'Japanese → English',
  HI_EN: 'Hindi → English',
  FR_EN: 'French → English',
};

function openMyAccount() {
  document.getElementById('account-overlay').classList.add('open');
  renderProfileTab();
}
function closeMyAccount() {
  document.getElementById('account-overlay').classList.remove('open');
}

// Each of these is a direct one-click dropdown destination, same pattern
// as openMyNotes()/openReview() -- no tab bar, no visibility into the
// other three sections from here.
function openMyCategories() {
  document.getElementById('account-overlay').classList.add('open');
  renderCategoriesTab();
}
function openFavorites() {
  document.getElementById('account-overlay').classList.add('open');
  renderFavoritesTab();
}
function openHistory() {
  document.getElementById('account-overlay').classList.add('open');
  renderHistoryTab();
}

function accountLoginPrompt() {
  return `<p class="notes-empty">
    <button class="nav-info-link" style="padding:4px 0;" onclick="closeMyAccount(); openAuth();">Log in</button>
    to see this.
  </p>`;
}

// ── Profile tab ──────────────────────────────────────────────────
async function renderProfileTab() {
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';
  const user = await getCurrentUser();
  if (!user) { body.innerHTML = accountLoginPrompt(); return; }

  const [{ data: profile }, { data: entitlements }] = await Promise.all([
    supabaseClient.from('profiles').select('full_name, country').eq('id', user.id).maybeSingle(),
    supabaseClient.from('entitlements').select('pair').eq('user_id', user.id),
  ]);

  const purchasedPairs = new Set((entitlements || []).map(e => e.pair));
  const purchasedHtml = Object.keys(PAIR_LABELS).map(pair => {
    const badge = purchasedPairs.has(pair)
      ? '<span class="yes-badge">Unlocked</span>'
      : `<span class="yes-badge">${typeof unlockedCountForPair === 'function' ? unlockedCountForPair(pair) : 0}/200</span>`;
    return `<div class="pair-row"><span>${PAIR_LABELS[pair]}</span>${badge}</div>`;
  }).join('') + (purchasedPairs.size < Object.keys(PAIR_LABELS).length
    ? '<p class="notes-empty" style="padding:8px 0;">See <a href="pricing.html">Pricing</a> to unlock a pair fully.</p>'
    : '');

  body.innerHTML = `
    <label class="settings-label">Email</label>
    <input type="text" value="${user.email}" disabled style="width:100%;">
    <label class="settings-label">Name</label>
    <input type="text" id="profile-name-input" value="${(profile && profile.full_name) || ''}" style="width:100%;">
    <label class="settings-label">Country</label>
    <input type="text" id="profile-country-input" value="${(profile && profile.country) || ''}" style="width:100%;">
    <button class="btn-primary" style="margin-top:10px;" onclick="saveProfile()">Save</button>
    <p id="profile-save-status" style="font-size:12px; margin-top:4px;"></p>

    <h3 style="margin-top:20px; font-size:14px;">Your language pairs</h3>
    ${purchasedHtml}

    <h3 style="margin-top:20px; font-size:14px;">Institutional code</h3>
    <p class="notes-empty" style="padding:0 0 8px;">Studying through a school or organization with a PTW licence? Enter your code below.</p>
    <input type="text" id="redeem-code-input" placeholder="XXXX-XXXX-XXXX-XXXX" style="width:100%; text-transform:uppercase;">
    <button class="btn-primary" style="margin-top:8px;" onclick="redeemInstitutionalCode()">Redeem</button>
    <p id="redeem-code-status" style="font-size:12px; margin-top:4px;"></p>
  `;
}

// Grants entitlements from a B2B institutional licence code via
// redeem-code.mjs. See migrations/2026-10-02_b2b_org_licenses.sql and
// TODO.md's B2B entry for how these codes are created -- by hand, after an
// institution's invoice is paid, never through this page.
async function redeemInstitutionalCode() {
  const input = document.getElementById('redeem-code-input');
  const status = document.getElementById('redeem-code-status');
  const code = input.value.trim();
  if (!code) { status.textContent = 'Enter a code first.'; return; }

  const session = ptwStoredSession ? ptwStoredSession() : null;
  if (!session || !session.access_token) {
    status.textContent = 'Please log in first.';
    return;
  }

  status.textContent = 'Checking…';
  try {
    const res = await fetch('/.netlify/functions/redeem-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || 'Could not redeem that code.';
      return;
    }
    status.textContent = `Unlocked for ${data.orgName}. Refreshing…`;
    renderProfileTab();
  } catch {
    status.textContent = 'Something went wrong -- try again.';
  }
}

async function saveProfile() {
  const user = await getCurrentUser();
  if (!user) return;
  const fullName = document.getElementById('profile-name-input').value.trim();
  const country = document.getElementById('profile-country-input').value.trim();
  const status = document.getElementById('profile-save-status');
  status.textContent = 'Saving…';
  const { error } = await supabaseClient.from('profiles').upsert({
    id: user.id, full_name: fullName, country, updated_at: new Date().toISOString(),
  });
  status.textContent = error ? 'Could not save.' : 'Saved.';
}

// ── My Categories tab ────────────────────────────────────────────
// Two states: the list of categories (default), and a single category's
// card grid (openCategoryDetail). The list view previously had no way to
// actually open a category's cards at all -- the count rendered, but
// nothing was clickable and no detail view existed to click through to.
let currentCategoryDetail = null; // { id, name } while viewing one category

async function renderCategoriesTab() {
  currentCategoryDetail = null;
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';
  const user = await getCurrentUser();
  if (!user) { body.innerHTML = accountLoginPrompt(); return; }

  const { data: categories, error } = await supabaseClient
    .from('custom_categories')
    .select('id, name, custom_category_cards(concept_id)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const listHtml = (!error && categories && categories.length)
    ? categories.map(c => `
        <div class="notes-list-item" onclick="openCategoryDetail('${c.id}', '${escapeHtml(String(c.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'"))}')">
          <div class="notes-list-item-body">
            <div class="notes-list-item-title">${c.name}</div>
            <div class="notes-list-item-text">${(c.custom_category_cards || []).length} card${(c.custom_category_cards || []).length === 1 ? '' : 's'}</div>
          </div>
          <button class="list-remove-btn" onclick="event.stopPropagation(); deleteCategory('${c.id}')">Delete</button>
        </div>`).join('')
    : '<p class="notes-empty">No categories yet — create one below, or add a card to a new category from any flashcard\'s detail view.</p>';

  body.innerHTML = `
    ${listHtml}
    <div style="display:flex; gap:8px; margin-top:14px;">
      <input type="text" id="new-category-name" placeholder="New category name (e.g. Naruto words)" style="flex:1;">
      <button class="btn-primary" onclick="handleCreateCategory()">Create</button>
    </div>
  `;
}

async function openCategoryDetail(categoryId, name) {
  currentCategoryDetail = { id: categoryId, name };
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';

  const { data: rows, error } = await supabaseClient
    .from('custom_category_cards')
    .select('concept_id')
    .eq('category_id', categoryId);

  const conceptIds = (!error && rows) ? rows.map(r => String(r.concept_id)) : [];
  const concepts = conceptIds.map(id => CARDS.find(c => c.concept_id === id)).filter(Boolean);

  const gridHtml = concepts.length
    ? `<div class="deck">${concepts.map(c => renderConceptTile(c, `removeCardFromCategory('${categoryId}','${c.concept_id}')`)).join('')}</div>`
    : '<p class="notes-empty">No cards in this category yet — add one from any flashcard\'s detail view.</p>';

  body.innerHTML = `
    <button class="nav-info-link" style="padding:4px 0; margin-bottom:10px;" onclick="renderCategoriesTab()">&larr; My Categories</button>
    <h3 style="font-size:14px; margin-bottom:10px;">${name}</h3>
    ${gridHtml}
  `;
  applyStarDisplay();
}

// Takes one card off a category without deleting the category itself or
// touching that card's global favourite/review state -- previously the
// only removal available here was deleteCategory(), which wipes the
// whole category and every card in it.
async function removeCardFromCategory(categoryId, conceptId) {
  await supabaseClient.from('custom_category_cards').delete()
    .eq('category_id', categoryId).eq('concept_id', Number(conceptId));
  if (currentCategoryDetail && currentCategoryDetail.id === categoryId) {
    await openCategoryDetail(categoryId, currentCategoryDetail.name);
  }
}

// ── Favorites tab ─────────────────────────────────────────────────
// One consolidated list of every starred card, not split by category --
// previously the only way to see favorites was per-category (the
// stars-only filter on each category's own page), so seeing everything
// starred meant visiting every category individually. `starred` (script.js)
// already carries the full cross-category set, synced with the account;
// this just renders all of it in one place, ordered the same way the
// site's own categories are ordered everywhere else.
async function renderFavoritesTab() {
  currentCategoryDetail = null;
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';

  const orderFor = id => {
    const cat = CATEGORIES.find(c => c.id === id);
    return cat ? cat.order : 999;
  };
  const concepts = [...starred]
    .map(id => CARDS.find(c => c.concept_id === id))
    .filter(Boolean)
    .sort((a, b) => orderFor(a.category_id) - orderFor(b.category_id) || a.sort_ja.localeCompare(b.sort_ja));

  const gridHtml = concepts.length
    ? `<div class="deck">${concepts.map(c => renderConceptTile(c, `removeFavorite('${c.concept_id}')`)).join('')}</div>`
    : '<p class="notes-empty">No favorites yet — tap the star on any flashcard to add it here.</p>';

  body.innerHTML = `
    <h3 style="font-size:14px; margin-bottom:10px;">Favorites (${concepts.length})</h3>
    ${gridHtml}
  `;
  applyStarDisplay();
}

// Same effect as un-starring the card (they ARE the same underlying
// state -- Favorites is just every starred card in one place), but also
// re-renders this list so the tile actually disappears immediately.
// toggleStar() alone only flips that one tile's star icon in place; the
// card would otherwise sit in the Favorites grid, looking unstarred,
// until the list was closed and reopened.
async function removeFavorite(conceptId) {
  starred.delete(conceptId);
  saveStars();
  syncStarChange(conceptId, false).catch(() => {});
  await renderFavoritesTab();
}

async function handleCreateCategory() {
  const input = document.getElementById('new-category-name');
  const name = input.value.trim();
  if (!name) return;
  await createCategory(name);
  input.value = '';
  renderCategoriesTab();
}

async function createCategory(name) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabaseClient
    .from('custom_categories')
    .insert({ user_id: user.id, name })
    .select()
    .single();
  if (error) { console.error('Failed to create category:', error.message); return null; }
  return data;
}

async function deleteCategory(categoryId) {
  await supabaseClient.from('custom_categories').delete().eq('id', categoryId);
  renderCategoriesTab();
}

// ── "+ Add to Category" picker, used from the card detail view ────
// Existing categories render as real tappable buttons -- typing a name by
// hand to match one exactly (the previous prompt()-based version) was
// slow and a single typo silently created a duplicate category instead
// of adding to the existing one.
let ptwAddToCategoryConceptId = null;
let ptwAddToCategoryPair = null;

async function openAddToCategoryPicker(conceptId, pair) {
  const user = await getCurrentUser();
  if (!user) { alert('Please log in to use custom categories.'); openAuth(); return; }

  ptwAddToCategoryConceptId = conceptId;
  ptwAddToCategoryPair = pair;
  document.getElementById('add-category-overlay').classList.add('open');
  const body = document.getElementById('add-category-existing');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';

  const { data: categories } = await supabaseClient
    .from('custom_categories').select('id, name').eq('user_id', user.id).order('name');

  // Same two-layer escaping as openCategoryDetail's category-name onclick:
  // JS-escape the raw name for safe embedding in a single-quoted JS string
  // literal first, THEN HTML-escape that result for the surrounding
  // double-quoted attribute -- doing it in the other order (or skipping
  // either step) reintroduces the exact quote-collision bug that made
  // clicking a category silently do nothing.
  const jsAndHtmlSafe = s => escapeHtml(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
  body.innerHTML = (categories && categories.length)
    ? categories.map(c => `<button class="category-pick-btn" onclick="handleAddToExistingCategory('${c.id}', '${jsAndHtmlSafe(c.name)}')">${escapeHtml(c.name)}</button>`).join('')
    : '<p class="notes-empty">No categories yet — create one below.</p>';
}

function closeAddToCategoryPicker() {
  document.getElementById('add-category-overlay').classList.remove('open');
  document.getElementById('add-category-new-name').value = '';
  ptwAddToCategoryConceptId = null;
  ptwAddToCategoryPair = null;
}

// Draws from the SAME shared pool as Add-to-Review and Add-to-Notes (see
// entitlement.js's ensureUnlocked) -- previously category-add had zero
// gating at all.
async function handleAddToExistingCategory(categoryId, name) {
  const conceptId = ptwAddToCategoryConceptId;
  const pair = ptwAddToCategoryPair;
  if (!conceptId) return;
  const user = await getCurrentUser();
  // A card the user made themselves (custom-cards.js) isn't curated
  // content, so adding it to one of their own categories was never meant
  // to draw from the shared 200-item free-tier pool.
  const isCustom = typeof isCustomCardId === 'function' && isCustomCardId(conceptId);
  const gate = isCustom ? { ok: true } : await ensureUnlocked(user.id, conceptId, pair, 'category');
  if (!gate.ok) { closeAddToCategoryPicker(); alert('🔒 Unlock this pair to add more cards — see Pricing.'); return; }

  const { error } = await supabaseClient
    .from('custom_category_cards')
    .upsert({ category_id: categoryId, concept_id: Number(conceptId) }, { onConflict: 'category_id,concept_id' });
  closeAddToCategoryPicker();
  if (error) { console.error('Failed to add card to category:', error.message); alert('Could not add to category.'); return; }
  alert(`Added to "${name}".`);
}

async function handleAddToNewCategory() {
  const conceptId = ptwAddToCategoryConceptId;
  const pair = ptwAddToCategoryPair;
  const input = document.getElementById('add-category-new-name');
  const name = input.value.trim();
  if (!conceptId || !name) return;

  const user = await getCurrentUser();
  const isCustom = typeof isCustomCardId === 'function' && isCustomCardId(conceptId);
  const gate = isCustom ? { ok: true } : await ensureUnlocked(user.id, conceptId, pair, 'category');
  if (!gate.ok) { closeAddToCategoryPicker(); alert('🔒 Unlock this pair to add more cards — see Pricing.'); return; }

  const target = await createCategory(name);
  if (!target) { alert('Could not create category.'); return; }

  const { error } = await supabaseClient
    .from('custom_category_cards')
    .upsert({ category_id: target.id, concept_id: Number(conceptId) }, { onConflict: 'category_id,concept_id' });
  closeAddToCategoryPicker();
  if (error) { console.error('Failed to add card to category:', error.message); alert('Could not add to category.'); return; }
  alert(`Added to "${target.name}".`);
}

// ── History tab ───────────────────────────────────────────────────
async function recordLookup(conceptId) {
  const user = await getCurrentUser();
  if (!user) return; // history is account-tied; silently skip when logged out
  await supabaseClient.from('lookup_history').upsert({
    user_id: user.id,
    concept_id: Number(conceptId),
    last_looked_up_at: new Date().toISOString(),
  }, { onConflict: 'user_id,concept_id' });
}

async function renderHistoryTab() {
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading…</p>';
  const user = await getCurrentUser();
  if (!user) { body.innerHTML = accountLoginPrompt(); return; }

  const { data: rows, error } = await supabaseClient
    .from('lookup_history')
    .select('concept_id, last_looked_up_at')
    .eq('user_id', user.id)
    .order('last_looked_up_at', { ascending: false })
    .limit(50);

  if (error || !rows || !rows.length) {
    body.innerHTML = '<p class="notes-empty">No lookups yet — words you search for will show up here.</p>';
    return;
  }

  body.innerHTML = rows.map(row => {
    const concept = CARDS.find(c => String(c.concept_id) === String(row.concept_id));
    if (!concept) return '';
    const dir = firstAvailableDirection(concept);
    const thumb = concept.directions[dir];
    const label = labelFor(concept);
    return `
      <div class="notes-list-item" onclick="openConcept('${concept.concept_id}')">
        ${thumb ? `<img src="${thumb.image_url}" alt="${label}">` : ''}
        <div class="notes-list-item-body">
          <div class="notes-list-item-title">${label}</div>
        </div>
        <button class="list-remove-btn" onclick="event.stopPropagation(); removeHistoryEntry('${concept.concept_id}')">Remove</button>
      </div>`;
  }).join('');
}

async function removeHistoryEntry(conceptId) {
  const user = await getCurrentUser();
  if (!user) return;
  await supabaseClient.from('lookup_history').delete()
    .eq('user_id', user.id).eq('concept_id', Number(conceptId));
  await renderHistoryTab();
}

/* ── Offline access ───────────────────────────────────────────────
   The fifth entry point into the same #account-overlay shell, opened by
   index.html's "Offline" topbar button. This block was built 2026-09-04
   in dist_site_hindi_test/ and never copied across during the Sept 7
   sync -- the same gap that left reader.html/bookmarklet.html/
   mobile-lookup.js/offline-download.js behind (recovered 2026-09-10),
   except this one was missed in that recovery: offline-download.js (the
   engine) and index.html's button both shipped, but the six functions
   below did not, so the live button called an undefined
   openOfflineAccess() and did nothing at all. Restored verbatim from
   dist_site_hindi_test/account.js; the engine it drives
   (window.offlineDownloadManager) is byte-identical between the two
   folders, and every DOM id and CSS class this needs already exists in
   the live shell. */
function openOfflineAccess() {
  document.getElementById('account-overlay').classList.add('open');
  renderOfflineTab();
}

async function renderOfflineTab() {
  const body = document.getElementById('account-tab-body');
  body.innerHTML = '<p class="notes-empty">Loading offline status...</p>';

  // Initialize offline manager if not ready
  const manager = window.offlineDownloadManager;
  if (!manager.manifest) {
    await manager.init();
  }

  if (!manager.manifest) {
    body.innerHTML = `
      <h3 style="margin-bottom:14px;">Offline Access</h3>
      <p class="notes-empty">Could not load offline manifest. Make sure you're connected to download categories for offline use.</p>
    `;
    return;
  }

  // Get storage quota
  const quota = await manager.checkStorageQuota();
  const persisted = await manager.isPersisted();
  const iosWarning = manager.getIOSWarning();

  // Get category statuses
  const statuses = manager.getAllCategoryStatuses();
  const downloadSize = manager.getTotalDownloadSize();
  const overall = manager.getOverallProgress();

  // Build category list HTML
  const categoryListHtml = Object.keys(statuses).map(catId => {
    const cat = statuses[catId];
    const statusBadge = cat.status === 'downloaded'
      ? '<span class="yes-badge" style="background:#1a7a4c;color:#fff;">Downloaded</span>'
      : cat.status === 'downloading'
        ? `<span class="yes-badge" style="background:#a87c1a;color:#fff;">Downloading ${cat.progress}%</span>`
        : '<span class="yes-badge" style="background:#7a9aad;color:#fff;">Not downloaded</span>';

    const actionBtn = cat.status === 'downloaded'
      ? `<button class="list-remove-btn" onclick="event.stopPropagation(); removeOfflineCategory('${catId}')">Remove</button>`
      : cat.status === 'downloading'
        ? '<span style="font-size:12px;color:#a87c1a;">In progress...</span>'
        : `<button class="btn-primary" style="padding:6px 14px;font-size:12px;" onclick="event.stopPropagation(); downloadOfflineCategory('${catId}')">Download</button>`;

    return `
      <div class="notes-list-item" style="cursor:default;">
        <div class="notes-list-item-body">
          <div class="notes-list-item-title">${cat.label}</div>
          <div class="notes-list-item-text">${cat.formattedSize}</div>
        </div>
        ${statusBadge}
        ${actionBtn}
      </div>
    `;
  }).join('');

  // Storage bar
  const storageBarWidth = quota.supported ? `${Math.min(quota.percent, 100)}%` : '0%';
  const storageColor = quota.percent > 80 ? '#c0392b' : quota.percent > 60 ? '#a87c1a' : '#1a7a4c';

  body.innerHTML = `
    <h3 style="margin-bottom:14px;">Offline Access</h3>

    ${iosWarning ? `
      <div class="offline-ios-warning" style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;">
        <strong>${iosWarning.title}</strong>
        <p style="margin:6px 0;">${iosWarning.message}</p>
      </div>
    ` : ''}

    <div class="offline-storage-section" style="margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;">Storage Usage</span>
        ${persisted ? '<span class="yes-badge" style="background:#1a7a4c;color:#fff;font-size:10px;">Persistent</span>' : '<span class="yes-badge" style="font-size:10px;">May be cleared</span>'}
      </div>
      ${quota.supported ? `
        <div style="background:#e0e0e0;border-radius:4px;height:8px;overflow:hidden;margin-bottom:4px;">
          <div style="background:${storageColor};height:100%;width:${storageBarWidth};transition:width 0.3s;"></div>
        </div>
        <div style="font-size:12px;color:#7a9aad;">
          ${quota.formattedUsage} used of ${quota.formattedQuota} (${quota.percent}%)
        </div>
      ` : '<p style="font-size:12px;color:#7a9aad;">Storage quota not available in this browser.</p>'}
    </div>

    <div class="offline-summary" style="display:flex;gap:16px;margin-bottom:20px;padding:12px;background:#f5f5f5;border-radius:8px;">
      <div style="flex:1;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--teal-dark);">${overall.downloaded}/${overall.total}</div>
        <div style="font-size:11px;color:#7a9aad;">Categories downloaded</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--teal-dark);">${downloadSize.formattedTotal}</div>
        <div style="font-size:11px;color:#7a9aad;">Total size</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:var(--teal-dark);">${downloadSize.formattedRemaining}</div>
        <div style="font-size:11px;color:#7a9aad;">Remaining</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn-primary" style="flex:1;" onclick="downloadAllOffline()" ${manager.downloadInProgress ? 'disabled' : ''}>
        Download All (${downloadSize.formattedRemaining})
      </button>
      <button class="btn-secondary" style="flex:1;" onclick="clearAllOffline()">
        Clear All
      </button>
    </div>

    <h4 style="font-size:13px;margin-bottom:10px;">Categories</h4>
    <div id="offline-category-list">
      ${categoryListHtml}
    </div>

    <p style="font-size:11px;color:#7a9aad;margin-top:16px;">
      Downloaded content works offline. Images and audio for downloaded categories will be available without an internet connection.
    </p>
  `;

  // Set up listener for live updates
  if (!window._offlineTabListener) {
    window._offlineTabListener = manager.addListener(() => {
      // Only re-render if the offline tab is currently visible
      if (document.getElementById('account-overlay').classList.contains('open')) {
        const currentTitle = body.querySelector('h3');
        if (currentTitle && currentTitle.textContent === 'Offline Access') {
          renderOfflineTab();
        }
      }
    });
  }
}

async function downloadOfflineCategory(categoryId) {
  const manager = window.offlineDownloadManager;

  try {
    await manager.downloadCategory(categoryId, (progress) => {
      // Progress updates handled by listener which re-renders the tab
    });
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  }
}

async function removeOfflineCategory(categoryId) {
  const manager = window.offlineDownloadManager;

  try {
    await manager.clearCategory(categoryId);
  } catch (err) {
    alert(`Could not remove: ${err.message}`);
  }
}

async function downloadAllOffline() {
  const manager = window.offlineDownloadManager;

  if (!confirm('This will download all categories for offline use. This may take a while and use significant storage. Continue?')) {
    return;
  }

  try {
    await manager.downloadAll();
    alert('All categories downloaded for offline use!');
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  }
}

async function clearAllOffline() {
  const manager = window.offlineDownloadManager;

  if (!confirm('This will remove all downloaded offline content. Continue?')) {
    return;
  }

  try {
    await manager.clearAll();
    renderOfflineTab();
  } catch (err) {
    alert(`Could not clear: ${err.message}`);
  }
}
