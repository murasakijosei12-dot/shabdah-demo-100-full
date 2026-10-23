/* reviews.js
   Public testimonials: star rating + written review, shown on the
   homepage to everyone (including logged-out visitors). Any logged-in
   user can leave one review; submitting again replaces their existing
   one rather than adding a second. Uses global `supabaseClient` and
   `getCurrentUser()` from auth.js. */

// Reviewer names and text are written by users and rendered via
// innerHTML, so they must be escaped. Without this, anyone could set a
// profile name containing markup and have it run in every visitor's
// browser.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Below this many published reviews the section stays off the homepage
// entirely. An empty "no reviews yet" state advertises that nobody has
// used the product, which costs more trust than it earns.
const REVIEWS_PUBLIC_THRESHOLD = 3;

// ── Reads (public — no login required) ─────────────────────────────
async function fetchReviews() {
  const { data, error } = await supabaseClient
    .from('reviews')
    .select('display_name, rating, review_text, created_at')
    .order('created_at', { ascending: false });
  if (error) { console.error('Failed to load reviews:', error.message); return []; }
  return data;
}

function computeAggregate(reviews) {
  if (!reviews.length) return { average: 0, count: 0 };
  const sum = reviews.reduce((total, r) => total + r.rating, 0);
  return { average: sum / reviews.length, count: reviews.length };
}

// ── Write (requires login) ──────────────────────────────────────────
async function submitReview(rating, text) {
  const user = await getCurrentUser();
  if (!user) { alert('Please log in to leave a review.'); openAuth(); return false; }

  // Use their profile name if they've set one, otherwise fall back to
  // the local part of their email so reviews never show a raw UUID.
  let displayName = user.email.split('@')[0];
  try {
    const { data: profile } = await supabaseClient
      .from('profiles').select('full_name').eq('id', user.id).maybeSingle();
    if (profile && profile.full_name) displayName = profile.full_name;
  } catch (e) { /* fall back silently to email-derived name */ }

  const { error } = await supabaseClient
    .from('reviews')
    .upsert({
      user_id: user.id,
      display_name: displayName,
      rating,
      review_text: (text || '').trim(),
      created_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) { console.error('Failed to submit review:', error.message); return false; }
  return true;
}

// ── Homepage rendering ───────────────────────────────────────────────
function starString(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

async function renderReviewsSection() {
  const section = document.getElementById('reviews-section');
  if (!section) return;

  const reviews = await fetchReviews();
  const { average, count } = computeAggregate(reviews);

  // Not enough yet — keep it off the page rather than showing an empty
  // state. Logged-in users can still leave one from the account menu.
  if (count < REVIEWS_PUBLIC_THRESHOLD) {
    section.innerHTML = '';
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const listHtml = reviews.map(r => `
    <div class="review-item">
      <div class="review-item-head">
        <span class="review-item-stars">${starString(r.rating)}</span>
        <span class="review-item-name">${escapeHtml(r.display_name)}</span>
      </div>
      ${r.review_text ? `<p class="review-item-text">${escapeHtml(r.review_text)}</p>` : ''}
    </div>`).join('');

  section.innerHTML = `
    <h2 class="home-cats-title">What <em>learners</em> are saying</h2>
    <div class="reviews-summary">
      <span class="reviews-stars">${starString(average)}</span>
      <span class="reviews-average">${average.toFixed(1)} out of 5</span>
      <span class="reviews-count">— based on ${count} reviews</span>
    </div>
    <div class="reviews-list">${listHtml}</div>
    <button class="btn-secondary" onclick="openReviewForm()">Leave a review</button>
    <div id="review-form-box" class="review-form-box hidden"></div>
  `;
}

// Entry point used by the account menu, so people can still leave a
// review while the public section is below threshold.
async function leaveReview() {
  const user = await getCurrentUser();
  if (!user) { openAuth(); return; }

  const section = document.getElementById('reviews-section');
  if (!section) return;
  section.style.display = '';

  if (!document.getElementById('review-form-box')) {
    section.innerHTML = `
      <h2 class="home-cats-title">Leave a <em>review</em></h2>
      <p class="home-cats-sub">Reviews appear on the homepage once a few have come in.</p>
      <div id="review-form-box" class="review-form-box"></div>
    `;
  }
  openReviewForm();
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openReviewForm() {
  const box = document.getElementById('review-form-box');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = `
    <label class="settings-label">Your rating</label>
    <select id="review-rating-select">
      <option value="5">★★★★★ — Excellent</option>
      <option value="4">★★★★☆ — Good</option>
      <option value="3">★★★☆☆ — Okay</option>
      <option value="2">★★☆☆☆ — Not great</option>
      <option value="1">★☆☆☆☆ — Poor</option>
    </select>
    <textarea id="review-text-input" rows="3" placeholder="What's your experience been like? (optional)"
      style="width:100%; margin-top:8px; padding:8px 10px; border:1.5px solid var(--border); border-radius:var(--radius-sm); font-family:inherit; font-size:13px;"></textarea>
    <button class="btn-primary" style="margin-top:8px;" onclick="handleSubmitReview()">Submit review</button>
    <p id="review-form-status" style="font-size:12px; margin-top:6px;"></p>
  `;
}

async function handleSubmitReview() {
  const rating = parseInt(document.getElementById('review-rating-select').value, 10);
  const text = document.getElementById('review-text-input').value;
  const status = document.getElementById('review-form-status');
  status.textContent = 'Submitting…';
  const ok = await submitReview(rating, text);
  status.textContent = ok ? 'Thanks for your review!' : 'Could not submit — please try again.';
  if (ok) {
    const box = document.getElementById('review-form-box');
    if (box) box.classList.add('hidden');
    renderReviewsSection();
  }
}
