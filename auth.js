/* auth.js
   Uses the global `supabaseClient` created in index.html's <head>.
   Plain script (no import/export) - loaded via <script src="auth.js">. */

// ── Core auth functions ────────────────────────────────────────
async function signUp(email, password) {
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: 'https://shabdah.app' }
  });
  if (error) return { success: false, message: error.message };
  return { success: true, user: data.user };
}

async function logIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) return { success: false, message: error.message };
  return { success: true, user: data.user };
}

async function logOut() {
  await supabaseClient.auth.signOut();
  updateAuthNav(null);
}

async function getCurrentUser() {
  // getUser() re-validates the JWT against Supabase's server on every call,
  // so it fails outright when offline -- every auth-gated feature (Review,
  // favourites, categories) treated an already-logged-in user as logged
  // out the moment they lost connectivity, even mid-session with a
  // perfectly valid local token. getSession() reads the token from local
  // storage first (only touching the network to silently refresh a
  // near-expired one), so it still resolves offline. Prefer it, and only
  // fall through to the network-verified getUser() if there's no local
  // session at all.
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) return session.user;
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    return user; // null if not logged in
  } catch (e) {
    return null;
  }
}

// ── Nav bar state ───────────────────────────────────────────────
// Logged out: a quiet text link beside one filled button.
// Logged in: everything account-related collapses into one avatar
// menu, so the nav stays at four content links either way.

const AVATAR_ICONS = {
  notes:   '<path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v6h6M8 14h7M8 17h5"/>',
  account: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  review:  '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  star:    '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8Z"/>',
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h9"/>',
  categories: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  mycards: '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-4-4.5 4L9 12l-6 6"/>',
};

function avatarIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round">${AVATAR_ICONS[name]}</svg>`;
}

function initialsFor(email) {
  const handle = (email || '?').split('@')[0];
  const parts = handle.split(/[._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : handle.slice(0, 2)) || '?';
}

function updateAuthNav(user) {
  // .auth-nav-area (not a single #id) because this now renders into BOTH
  // the homepage nav and the category-view topbar simultaneously -- a
  // user browsing a category needs their account menu without leaving to
  // the homepage first, especially on a phone where that used to mean
  // losing their place. Two live copies means two live avatar-btn/
  // avatar-menu pairs, which is why toggleAvatarMenu/closeAvatarMenu
  // below no longer address them by a single getElementById.
  const areas = document.querySelectorAll('.auth-nav-area');
  if (typeof loadReviewSet === 'function') loadReviewSet(user ? user.id : null);
  if (typeof loadUnlockedItems === 'function') loadUnlockedItems(user ? user.id : null);
  if (typeof loadCustomCardsIntoCards === 'function') loadCustomCardsIntoCards();
  if (!areas.length) return;

  const html = !user ? `
      <button class="nav-login auth-account-btn" onclick="openAuth()">Log in</button>
      <button class="nav-cta" onclick="openAuth()">Sign up free</button>
    ` : `
    <div class="avatar-wrap">
      <button class="avatar-btn" aria-haspopup="menu" aria-expanded="false"
              onclick="toggleAvatarMenu(event)" aria-label="Your account">
        <span class="avatar-circle">${initialsFor(user.email)}</span>
        <span class="avatar-chevron" aria-hidden="true"></span>
      </button>
      <div class="avatar-menu" role="menu">
        <div class="avatar-menu-head">
          <div class="avatar-menu-email">${user.email}</div>
          <div class="avatar-menu-sub">Signed in</div>
        </div>
        <button role="menuitem" onclick="closeAvatarMenu(); openReview();">
          ${avatarIcon('review')} Review due cards
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openMyNotes();">
          ${avatarIcon('notes')} My notes
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openFavorites();">
          ${avatarIcon('star')} Favorites
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openMyCategories();">
          ${avatarIcon('categories')} My Categories
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openMyCards();">
          ${avatarIcon('mycards')} My Created Cards
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openHistory();">
          ${avatarIcon('history')} History
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); openMyAccount();">
          ${avatarIcon('account')} My account
        </button>
        <button role="menuitem" onclick="closeAvatarMenu(); leaveReview();">
          ${avatarIcon('star')} Leave a review
        </button>
        <div class="avatar-menu-sep"></div>
        <button role="menuitem" class="is-signout"
                onclick="logOut().then(()=>location.reload())">
          ${avatarIcon('signout')} Log out
        </button>
      </div>
    </div>
  `;
  areas.forEach(area => { area.innerHTML = html; });
}

// ── Avatar menu open/close ──────────────────────────────────────
// Up to two live avatar-wrap instances can exist at once (homepage nav +
// category-view topbar), so these work off the clicked button's own
// wrapper rather than a page-wide id -- opening one must not reach into
// the other, hidden instance elsewhere in the DOM.
function toggleAvatarMenu(evt) {
  if (!evt) return;
  evt.stopPropagation();
  const wrap = evt.currentTarget.closest('.avatar-wrap');
  const menu = wrap && wrap.querySelector('.avatar-menu');
  const btn = evt.currentTarget;
  if (!menu || !btn) return;
  const willOpen = !menu.classList.contains('open');
  closeAvatarMenu();
  menu.classList.toggle('open', willOpen);
  btn.setAttribute('aria-expanded', String(willOpen));
}

function closeAvatarMenu() {
  document.querySelectorAll('.avatar-menu.open').forEach(menu => menu.classList.remove('open'));
  document.querySelectorAll('.avatar-btn[aria-expanded="true"]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}

// Clicking anywhere else, or pressing Escape, dismisses the menu —
// the behaviour people expect without being told.
document.addEventListener('click', e => {
  if (!e.target.closest('.avatar-wrap')) closeAvatarMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAvatarMenu();
});

// ── Overlay open/close/tabs ────────────────────────────────────
let authTab = 'login';

function openAuth() {
  document.getElementById('auth-overlay').classList.add('open');
  setAuthTab('login');
}
function closeAuth() {
  document.getElementById('auth-overlay').classList.remove('open');
  document.getElementById('auth-message').textContent = '';
}
function setAuthTab(tab) {
  authTab = tab;
  document.getElementById('auth-tab-login').classList.toggle('active-tab', tab === 'login');
  document.getElementById('auth-tab-signup').classList.toggle('active-tab', tab === 'signup');
  document.getElementById('auth-submit-btn').textContent = tab === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('auth-message').textContent = '';
}

async function submitAuthForm() {
  const email = document.getElementById('auth-form-email').value.trim();
  const password = document.getElementById('auth-form-password').value;
  const msgEl = document.getElementById('auth-message');
  msgEl.style.color = '';
  msgEl.textContent = 'Please wait…';

  if (!email || !password) {
    msgEl.textContent = 'Please enter both email and password.';
    return;
  }

  const result = authTab === 'login'
    ? await logIn(email, password)
    : await signUp(email, password);

  if (!result.success) {
    msgEl.style.color = '#c0392b';
    msgEl.textContent = result.message;
    return;
  }

  if (authTab === 'signup') {
    msgEl.style.color = '#1a7a4c';
    msgEl.textContent = 'Check your email to confirm your account, then log in.';
  } else {
    updateAuthNav(result.user);
    closeAuth();
    // Merge this device's local favourites with the account's synced
    // set the moment login succeeds, not just at next page load.
    if (typeof syncStarsFromAccount === 'function') syncStarsFromAccount().catch(() => {});
  }
}

// ── Confirmation-link redirect handling ────────────────────────
// Supabase sends users back with auth info in the URL hash
// (#access_token=... on success, or #error=... if the link expired).
// Without this, that raw hash just sits in the address bar as confusing text.
function handleAuthRedirect() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;

  const params = new URLSearchParams(hash.substring(1));
  const error = params.get('error');
  const accessToken = params.get('access_token');

  // Only an actual Supabase auth redirect (#error=... or #access_token=...)
  // reaches here -- this used to run for ANY non-empty hash, including a
  // shared #/word/<id> permalink, and unconditionally wiped it via
  // replaceState below before script.js's boot() ever got to read it. That
  // was the entire cause of "copy link only shows the homepage": the hash
  // was gone by the time openFromHash() ran. Confirmed 2026-08-29.
  if (!error && !accessToken) return;

  if (error) {
    alert(
      'Your confirmation link has expired or was already used.\n' +
      'Please sign up again to get a new link, or log in if your account is already confirmed.'
    );
  } else if (accessToken) {
    // Supabase's client auto-detects the session from the URL hash already;
    // this is just to give the user visible confirmation it worked.
    alert('Email confirmed! You are now logged in.');
  }

  // Clean the confusing hash out of the address bar either way.
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// ── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  handleAuthRedirect();
  const user = await getCurrentUser();
  updateAuthNav(user);
});
