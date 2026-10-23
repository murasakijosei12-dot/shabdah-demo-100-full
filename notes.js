/* notes.js
   Per-concept personal notes, stored in Supabase (synced across devices,
   and eventually the extension). Uses global `supabaseClient` and
   `getCurrentUser()` from auth.js. Requires login — same gate pattern
   as srs.js's addToReview(). */

// ── Supabase reads/writes ──────────────────────────────────────
async function fetchNote(conceptId) {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data, error } = await supabaseClient
    .from('notes')
    .select('note')
    .eq('user_id', user.id)
    .eq('concept_id', Number(conceptId))
    .maybeSingle();
  if (error) { console.error('Failed to load note:', error.message); return null; }
  return data ? data.note : null;
}

// pair decides which of the shared 200-item pools a NEW note draws from --
// it is never stored on the note row itself, so an existing note stays
// visible/editable regardless of which pair is currently active, same as
// before this gate existed. Draws from the SAME shared pool as
// Add-to-Review and Add-to-Category (see entitlement.js's ensureUnlocked).
async function saveNote(conceptId, pair, text) {
  const user = await getCurrentUser();
  if (!user) { alert('Please log in to add notes.'); openAuth(); return { ok: false }; }

  const trimmed = text.trim();
  if (!trimmed) {
    // Empty note — remove the row rather than storing a blank string.
    // Deleting never costs a slot, so this is never gated.
    const { error } = await supabaseClient
      .from('notes')
      .delete()
      .eq('user_id', user.id)
      .eq('concept_id', Number(conceptId));
    if (error) console.error('Failed to delete note:', error.message);
    return { ok: true };
  }

  // A note on a card the user made themselves (custom-cards.js) isn't
  // curated content, so it was never meant to draw from the shared
  // 200-item free-tier pool the way a note on a real concept does.
  if (!(typeof isCustomCardId === 'function' && isCustomCardId(conceptId))) {
    const gate = await ensureUnlocked(user.id, conceptId, pair, 'notes');
    if (!gate.ok) return { ok: false, locked: true };
  }

  const { error } = await supabaseClient
    .from('notes')
    .upsert({
      user_id: user.id,
      concept_id: Number(conceptId),
      note: trimmed,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,concept_id' });
  if (error) { console.error('Failed to save note:', error.message); return { ok: false }; }
  return { ok: true };
}

async function fetchAllNotes() {
  const user = await getCurrentUser();
  if (!user) return [];
  const { data, error } = await supabaseClient
    .from('notes')
    .select('concept_id, note, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });
  if (error) { console.error('Failed to load notes:', error.message); return []; }
  return data;
}

// ── My Notes overlay (list of everything the user has noted) ─────
async function openMyNotes() {
  document.getElementById('notes-overlay').classList.add('open');
  const content = document.getElementById('notes-list-content');
  content.innerHTML = '<p class="notes-empty">Loading…</p>';

  const user = await getCurrentUser();
  if (!user) {
    content.innerHTML = `
      <p class="notes-empty">
        <button class="nav-info-link" style="padding:4px 0;" onclick="closeMyNotes(); openAuth();">Log in</button>
        to see your notes.
      </p>`;
    return;
  }

  const notes = await fetchAllNotes();
  if (!notes.length) {
    content.innerHTML = '<p class="notes-empty">No notes yet — open any card and jot one down under "+ Add to Review."</p>';
    return;
  }

  content.innerHTML = notes.map(n => {
    const concept = CARDS.find(c => String(c.concept_id) === String(n.concept_id));
    const label = concept ? labelFor(concept) : `Concept ${n.concept_id}`;
    const thumbDir = concept ? firstAvailableDirection(concept) : null;
    const thumb = concept && thumbDir ? concept.directions[thumbDir] : null;
    return `
      <div class="notes-list-item" onclick="${concept ? `openConcept('${concept.concept_id}')` : ''}">
        ${thumb ? `<img src="${thumb.image_url}" alt="${label}">` : ''}
        <div class="notes-list-item-body">
          <div class="notes-list-item-title">${label}</div>
          <div class="notes-list-item-text">${n.note}</div>
        </div>
        <button class="list-remove-btn" onclick="event.stopPropagation(); deleteNoteFromList('${n.concept_id}')">Delete</button>
      </div>`;
  }).join('');
}

// Previously the only way to remove a note was to open its card and
// clear the textarea by hand (saveNote() deletes the row on an empty
// save) -- there was no direct delete from this list.
async function deleteNoteFromList(conceptId) {
  const user = await getCurrentUser();
  if (!user) return;
  const { error } = await supabaseClient
    .from('notes').delete()
    .eq('user_id', user.id).eq('concept_id', Number(conceptId));
  if (error) { console.error('Failed to delete note:', error.message); return; }
  await openMyNotes();
}

function closeMyNotes() {
  document.getElementById('notes-overlay').classList.remove('open');
}
// Called from renderConceptDetail() in script.js after the card markup
// is in the DOM. Async, so it fills in a "Loading…" placeholder first.
async function renderNotePanel(conceptId, pair) {
  const panel = document.getElementById('note-panel');
  if (!panel) return;

  const user = await getCurrentUser();
  if (!user) {
    panel.innerHTML = `
      <p class="note-hint">
        <button class="nav-info-link" style="padding:4px 0;" onclick="openAuth()">Log in</button>
        to add a note to this card.
      </p>`;
    return;
  }

  const existing = await fetchNote(conceptId);
  panel.innerHTML = `
    <div style="text-align:right;"><span id="note-save-status" class="note-save-status"></span></div>
    <textarea class="note-textarea" id="note-textarea"
      placeholder="Write a memory hook, example sentence, or anything that helps this word stick…"
      oninput="onNoteInput('${conceptId}', '${pair}', this.value)">${existing || ''}</textarea>
    <p class="note-hint">Synced to your account — visible next time you log in, on any device.</p>
  `;
}

// Debounced auto-save (waits for a pause in typing rather than saving on
// every keystroke) — same UX pattern as the settings auto-save elsewhere
// on the site, just debounced instead of button-triggered.
let noteSaveTimer = null;
function onNoteInput(conceptId, pair, value) {
  const statusEl = document.getElementById('note-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(async () => {
    const result = await saveNote(conceptId, pair, value);
    if (statusEl) {
      statusEl.textContent = result.ok ? 'Saved'
        : result.locked ? '🔒 Unlock this pair to keep adding notes'
        : 'Could not save';
    }
    if (result.ok) setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
  }, 600);
}
