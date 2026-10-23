/* stats.js — public usage figures for the homepage
   ------------------------------------------------------------------
   Reads a single pre-aggregated row from Supabase, never a live COUNT
   over the tables. Counting on every page load would get slow and
   expensive the moment the numbers are worth showing.

   Nothing appears until the figures are worth showing. "47 learners
   from 3 countries" reads worse than no claim at all, so each metric
   stays hidden behind its own threshold and only surfaces once the
   real number clears it. Figures are rounded down and shown with a
   "+", so the site never overstates. */

const STATS_THRESHOLDS = {
  learners:  1000,
  countries: 15,
  reviews:   100000,
};

// Round down to something that reads as a claim, not a readout.
function roundDownStat(n) {
  if (n >= 1000000) return Math.floor(n / 100000) * 100000;
  if (n >= 10000)   return Math.floor(n / 1000) * 1000;
  if (n >= 1000)    return Math.floor(n / 100) * 100;
  return Math.floor(n / 10) * 10;
}

async function fetchPublicStats() {
  try {
    const { data, error } = await supabaseClient
      .from('public_stats').select('*').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

async function renderUsageStats() {
  const bar = document.getElementById('usage-bar');
  if (!bar) return;

  const s = await fetchPublicStats();
  if (!s) return;                       // table not created yet — stay silent

  const cells = [];
  if ((s.learner_count || 0) >= STATS_THRESHOLDS.learners) {
    cells.push([roundDownStat(s.learner_count).toLocaleString() + '+', 'Learners']);
  }
  if ((s.country_count || 0) >= STATS_THRESHOLDS.countries) {
    cells.push([s.country_count + '', 'Countries']);
  }
  if ((s.review_count || 0) >= STATS_THRESHOLDS.reviews) {
    cells.push([roundDownStat(s.review_count).toLocaleString() + '+', 'Cards reviewed']);
  }
  if (!cells.length) return;            // nothing has earned its place yet

  bar.innerHTML = `
    <div class="usage-bar-inner">
      ${cells.map(([n, l]) => `
        <div class="usage-cell">
          <span class="usage-num">${n}</span>
          <span class="usage-label">${l}</span>
        </div>`).join('')}
    </div>`;
  bar.style.display = '';
}

/* Records the learner's country once, at signup, from a coarse two-letter
   code. No IP address is stored, which keeps this clear of GDPR and the
   India DPDP Act without needing a consent banner. */
async function recordSignupCountry(userId) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('https://ipapi.co/country/', { signal: ctrl.signal });
    if (!res.ok) return;
    const code = (await res.text()).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return;
    await supabaseClient.from('profiles')
      .upsert({ id: userId, country: code, updated_at: new Date().toISOString() });
  } catch (e) { /* never block signup on this */ }
}
