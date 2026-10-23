/* entitlement.js
   Shared 200-item free allowance across Add-to-Review, Add-to-Notes, and
   Add-to-Category. Single source of truth: public.unlocked_items (server-
   enforced via a Postgres trigger, see
   migrations/2026-08-28_add_unlocked_items_shared_pool.sql). Previously
   only Review had a gate at all (see srs.js's addToReview, which counted
   only Review's own userReviewSet) -- Notes and Category had none, and
   each feature would have counted against its own separate 200 rather
   than one shared pool per pair.
   Uses the global `supabaseClient` created in index.html's <head>, same
   as auth.js/srs.js. Plain script (no import/export) - loaded via
   <script src="entitlement.js">, right after srs.js. */

let ptwUnlockedByPair = { JA_EN: new Set(), HI_EN: new Set(), FR_EN: new Set() };
// Cached alongside the unlock counts so the visible counter can hide
// itself for a licensed pair without an async check on every render --
// once purchased, "how many words has this account touched" is no longer
// meaningful information to show (there's no cap left to count against),
// so the badge should read as "unlocked", never a number.
let ptwLicensedPairsCache = new Set();

async function loadUnlockedItems(userId) {
  if (!userId) {
    // The badge is meant to be visible while browsing generally, not just
    // once logged in (see the comment on renderAllowanceBadge) -- but this
    // early return used to skip calling it entirely for a logged-out
    // visitor, since there's no user_id yet to query unlocked_items with.
    // The badge itself has nothing to show until an account exists to
    // count against, so 0/200 here is the honest, correct starting state,
    // not a placeholder -- it just also needs to actually render.
    ptwUnlockedByPair = { JA_EN: new Set(), HI_EN: new Set(), FR_EN: new Set() };
    ptwLicensedPairsCache = new Set();
    if (typeof renderAllowanceBadge === 'function') renderAllowanceBadge();
    return;
  }
  const [{ data, error }, { data: entRows }] = await Promise.all([
    supabaseClient.from('unlocked_items').select('pair, item_id').eq('user_id', userId),
    supabaseClient.from('entitlements').select('pair').eq('user_id', userId),
  ]);
  if (!error) {
    const byPair = { JA_EN: new Set(), HI_EN: new Set(), FR_EN: new Set() };
    (data || []).forEach(r => {
      (byPair[r.pair] || (byPair[r.pair] = new Set())).add(r.item_id);
    });
    ptwUnlockedByPair = byPair;
  }
  ptwLicensedPairsCache = new Set((entRows || []).map(r => r.pair));
  if (typeof renderAllowanceBadge === 'function') renderAllowanceBadge();
}

function unlockedCountForPair(pair) {
  return (ptwUnlockedByPair[pair] || new Set()).size;
}

function isPairLicensedCached(pair) {
  return ptwLicensedPairsCache.has(pair);
}

// Moved here from srs.js so notes.js/account.js can call it too, body
// unchanged from srs.js's original.
async function checkEntitlementPwa(pair) {
  const user = await getCurrentUser();
  if (!user) return { licensed: false, reason: 'not_logged_in' };
  const { data, error } = await supabaseClient
    .from('entitlements').select('pair').eq('user_id', user.id).eq('pair', pair);
  if (error) return { licensed: false, reason: 'check_failed' };
  return (data && data.length > 0) ? { licensed: true } : { licensed: false, reason: 'not_purchased' };
}

// The single gate every "add" action (Review, Notes, Category) funnels
// through. No-op for an item already unlocked; otherwise upserts into
// unlocked_items, letting the database's own shared-pool trigger be the
// actual enforcement (see the migration file) -- this function just
// translates its PTW_FREE_TIER_LIMIT error into a friendly result and
// keeps the in-memory count in sync so the visible counter updates
// immediately without a re-fetch.
async function ensureUnlocked(userId, conceptId, pair, source) {
  const id = String(conceptId);
  const set = ptwUnlockedByPair[pair] || (ptwUnlockedByPair[pair] = new Set());
  if (set.has(id)) return { ok: true };

  const { error } = await supabaseClient
    .from('unlocked_items')
    .upsert({ user_id: userId, pair, item_id: id, source }, { onConflict: 'user_id,pair,item_id' });

  if (error) {
    if (String(error.message || '').includes('PTW_FREE_TIER_LIMIT')) {
      // Race: an entitlement purchased in another tab/device just now
      // would still leave a stale trigger read here -- re-check directly
      // rather than surface a false lock.
      const entitlement = await checkEntitlementPwa(pair);
      if (entitlement.licensed) { set.add(id); ptwLicensedPairsCache.add(pair); return { ok: true }; }
      return { ok: false, reason: 'not_purchased' };
    }
    return { ok: false, reason: 'check_failed' };
  }

  set.add(id);
  if (typeof renderAllowanceBadge === 'function') renderAllowanceBadge();
  return { ok: true };
}
