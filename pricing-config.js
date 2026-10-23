/* ================================================================
   PICTURE THE WORDS — pricing-config.js  v1.3
   ----------------------------------------------------------------
   ONE PLACE TO EDIT PRICES.

   Everything the pricing page displays comes from PTW_PRICING below.
   To change a price, edit the number here — never the HTML.

   IMPORTANT — read before launch:
   The country detected here is for DISPLAY ONLY. It is a guess, and
   a visitor can trivially fake it. The price a customer is actually
   charged must be decided at checkout by their payment method's
   issuing country, which your payment provider (Paddle) verifies.
   Never let this file decide what someone pays.

   CHANGES IN v1.3
   - Razorpay for buyers in India, Paddle everywhere else. Paddle cannot
     charge INR and offer UPI at the same time: enabling UPI there forces
     the whole country onto USD pricing. Razorpay does both natively, and
     settles INR directly instead of a USD wire minus an FX spread.
   - Note the trade-off deliberately accepted here: Paddle is Merchant of
     Record and handles tax everywhere. Razorpay is a gateway only, so for
     Indian sales YOU are the seller of record, with the GST and invoicing
     that implies. That is a question for an accountant, not for this file.

   CHANGES IN v1.2
   - Checkout returns to thank-you.html, which confirms the purchase and
     waits for the webhook, instead of dumping the buyer on the homepage
     with no acknowledgement that anything happened.
   - ptwGetEntitlements() so a pair already owned shows "You own this"
     rather than a live buy button that would charge a second time.
   - How to request a refund is stated on the page.

   CHANGES IN v1.1
   - Live Paddle token and JA_EN price ID wired in.
   - PADDLE_ENVIRONMENT switched to 'production'. A live token with
     the environment left on 'sandbox' fails every checkout.
   - EN_JA added to PTW_PAIRS, with its own price ID slot.
   - paddleIsConfigured() is now PER PAIR, so a pair without a price
     ID explains itself instead of breaking the whole page.
   ================================================================ */

/* ── Price bands ──────────────────────────────────────────────────
   `single`  = one language pair, one-time payment
   `bundle`  = both current pairs, one-time payment
   `was`     = the price this rises to after the founding period
               (set to null to hide the strikethrough)
   Amounts are whole numbers in the local currency, rounded to
   psychologically clean values. Do not compute these from live FX —
   a price of "₹1,483.27" reads as a machine, not a product.        */

const PTW_PRICING = {
  IN: { currency: 'INR', symbol: '₹',   single: 449,  bundle: 799,  was: 899,  label: 'India' },
  BD: { currency: 'USD', symbol: '$',   single: 6,    bundle: 11,   was: 12,   label: 'Bangladesh' },
  PK: { currency: 'USD', symbol: '$',   single: 6,    bundle: 11,   was: 12,   label: 'Pakistan' },
  LK: { currency: 'USD', symbol: '$',   single: 6,    bundle: 11,   was: 12,   label: 'Sri Lanka' },
  NP: { currency: 'USD', symbol: '$',   single: 6,    bundle: 11,   was: 12,   label: 'Nepal' },

  ID: { currency: 'USD', symbol: '$',   single: 7,    bundle: 13,   was: 14,   label: 'Indonesia' },
  PH: { currency: 'USD', symbol: '$',   single: 7,    bundle: 13,   was: 14,   label: 'Philippines' },
  VN: { currency: 'USD', symbol: '$',   single: 7,    bundle: 13,   was: 14,   label: 'Vietnam' },
  TH: { currency: 'USD', symbol: '$',   single: 7,    bundle: 13,   was: 14,   label: 'Thailand' },
  MY: { currency: 'USD', symbol: '$',   single: 8,    bundle: 15,   was: 16,   label: 'Malaysia' },

  BR: { currency: 'USD', symbol: '$',   single: 8,    bundle: 15,   was: 16,   label: 'Brazil' },
  MX: { currency: 'USD', symbol: '$',   single: 8,    bundle: 15,   was: 16,   label: 'Mexico' },
  AR: { currency: 'USD', symbol: '$',   single: 8,    bundle: 15,   was: 16,   label: 'Argentina' },
  CO: { currency: 'USD', symbol: '$',   single: 8,    bundle: 15,   was: 16,   label: 'Colombia' },

  PL: { currency: 'EUR', symbol: '€',   single: 9,    bundle: 16,   was: 18,   label: 'Poland' },
  RO: { currency: 'EUR', symbol: '€',   single: 9,    bundle: 16,   was: 18,   label: 'Romania' },
  UA: { currency: 'USD', symbol: '$',   single: 9,    bundle: 16,   was: 18,   label: 'Ukraine' },

  JP: { currency: 'JPY', symbol: '¥',   single: 1800, bundle: 3200, was: 3600, label: 'Japan' },
  KR: { currency: 'USD', symbol: '$',   single: 12,   bundle: 22,   was: 24,   label: 'South Korea' },

  GB: { currency: 'GBP', symbol: '£',   single: 10,   bundle: 18,   was: 20,   label: 'United Kingdom' },
  DE: { currency: 'EUR', symbol: '€',   single: 12,   bundle: 21,   was: 24,   label: 'Germany' },
  FR: { currency: 'EUR', symbol: '€',   single: 12,   bundle: 21,   was: 24,   label: 'France' },
  ES: { currency: 'EUR', symbol: '€',   single: 12,   bundle: 21,   was: 24,   label: 'Spain' },
  IT: { currency: 'EUR', symbol: '€',   single: 12,   bundle: 21,   was: 24,   label: 'Italy' },
  NL: { currency: 'EUR', symbol: '€',   single: 12,   bundle: 21,   was: 24,   label: 'Netherlands' },

  US: { currency: 'USD', symbol: '$',   single: 12,   bundle: 22,   was: 24,   label: 'United States' },
  CA: { currency: 'CAD', symbol: 'CA$', single: 17,   bundle: 30,   was: 33,   label: 'Canada' },
  AU: { currency: 'AUD', symbol: 'A$',  single: 19,   bundle: 34,   was: 37,   label: 'Australia' },
  NZ: { currency: 'NZD', symbol: 'NZ$', single: 20,   bundle: 36,   was: 40,   label: 'New Zealand' },
};

/* Anything not listed above falls back to this. */
const PTW_PRICING_DEFAULT =
  { currency: 'USD', symbol: '$', single: 12, bundle: 22, was: 24, label: 'Rest of world' };

/* ── The pairs on sale ────────────────────────────────────────────
   ONE purchase unlocks ALL THREE pairs (see pricing.html's "What you are
   buying" section) -- there is a single Founding Edition product, not
   three separately-sold pairs. This array still describes the three
   directions themselves (their audience, what their cards look like) for
   the descriptive copy on the pricing page, and PTW_CHECKOUT_PAIR below
   picks which one's catalog price/order actually gets opened at checkout
   -- purely a mechanical choice, not something the buyer sees or decides.
   The webhook (paddle-webhook.mjs / razorpay-webhook.mjs) grants
   entitlement rows for every pair in PTW_PAIRS regardless of which price
   was used.

   English is the fixed target language across all three -- JA_EN, HI_EN
   and FR_EN are each for a different source-language learner studying
   into English. There is no bidirectional study and no English-source
   pair (see TODO.md's 2026-09-16 scope trim).                       */

const PTW_PAIRS = [
  { id: 'JA_EN', name: 'Japanese → English', scripts: '日本語 / English',
    audience: 'For English speakers learning Japanese',
    blurb: 'Read Japanese on any page and save what you meet. Kanji, kana and romaji throughout.' },

  { id: 'HI_EN', name: 'Hindi → English', scripts: 'हिंदी / English',
    audience: 'For English speakers learning Hindi',
    blurb: 'Read Hindi on any page and save what you meet. Devanagari and romanized Hindi throughout.' },

  { id: 'FR_EN', name: 'French → English', scripts: 'Français / English',
    audience: 'For English speakers learning French',
    blurb: 'Read French on any page and save what you meet.' },
];

/* Fixed, not user-selectable: which catalog price/order checkout opens.
   Since one purchase always grants both pairs (see the webhooks), it does
   not matter which one this points at -- JA_EN was already the first pair
   this product shipped with, so it stays the default. */
const PTW_CHECKOUT_PAIR = 'JA_EN';

/* ── Country detection (display only) ─────────────────────────────
   Order of preference:
     1. A country the visitor picked themselves (remembered locally)
     2. The country on their PTW account, if they're logged in
     3. A geo lookup
     4. Their browser locale
     5. Rest-of-world pricing
   Any failure falls through quietly to the next option.            */

const PTW_COUNTRY_KEY = 'ptw_pricing_country';

async function ptwDetectCountry() {
  const chosen = localStorage.getItem(PTW_COUNTRY_KEY);
  if (chosen) return chosen;

  // Logged-in account country, if auth + Supabase are present on the page.
  try {
    if (typeof supabaseClient !== 'undefined') {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (user) {
        const { data } = await supabaseClient
          .from('profiles').select('country').eq('id', user.id).single();
        if (data && data.country) return data.country.toUpperCase();
      }
    }
  } catch (e) { /* not logged in, or no profiles table yet — fine */ }

  // Geo lookup. Times out fast so the price never blocks on the network.
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('https://ipapi.co/country/', { signal: ctrl.signal });
    if (res.ok) {
      const code = (await res.text()).trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code)) return code;
    }
  } catch (e) { /* offline, blocked, or slow — fine */ }

  // Browser locale, e.g. "en-IN" → "IN".
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region) return region.toUpperCase();
  } catch (e) { /* older browser — fine */ }

  return null;
}

function ptwPriceFor(countryCode) {
  return (countryCode && PTW_PRICING[countryCode]) || PTW_PRICING_DEFAULT;
}

/* Formats using the visitor's own numbering conventions, so an Indian
   visitor sees ₹1,20,000-style grouping and a German visitor sees
   1.234 — the same courtesy the product extends to their language.
   Deliberately does NOT let Intl.NumberFormat pick the currency symbol
   (style: 'currency') -- that ties the symbol to the VIEWER's own browser
   language rather than the country/currency band actually being priced,
   so the same AUD price rendered as "A$19" for one visitor, "$19" (no
   disambiguation) for an en-AU visitor, and "19 $AU" / "USD 12" for
   others, depending only on their own locale, not on what's being shown.
   band.symbol is this project's own curated, locale-independent
   disambiguation (A$/CA$/NZ$ for the ambiguous dollar currencies) --
   style: 'decimal' here only ever grouped digits, never re-picks it. */
function ptwFormatPrice(amount, band) {
  try {
    return band.symbol + new Intl.NumberFormat(navigator.language, {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch (e) {
    return band.symbol + amount.toLocaleString();
  }
}

function ptwSetCountry(code) {
  localStorage.setItem(PTW_COUNTRY_KEY, code);
  ptwRenderPricing(code);
}


/* ── Paddle checkout ──────────────────────────────────────────────
   Paddle is the Merchant of Record: it collects the money, verifies
   the buyer's country from their payment method, and handles VAT/GST
   in every jurisdiction. Your bank details live in the Paddle
   dashboard and nowhere near this file or this website.

   The values below are LIVE. The client-side token is designed to be
   public — it ships inside this file, which anyone can read — and it
   can only open a checkout, never read data or move money.

   NEVER put these in this file, or any file the browser downloads:
     - the Paddle API key (secret, starts pdl_sdbx_ / pdl_live_)
     - the Paddle webhook secret
     - the Supabase service role key
   Those belong only in Vercel's environment variables.               */

const PADDLE_ENVIRONMENT = 'production';   // must match the token below
const PADDLE_TOKEN = 'live_ed3cc4f12772006c3f773f61cf5';

const PADDLE_PRICES = {
  JA_EN: 'pri_01kyw4v2htqex4jkcw1jk50c8g',
  HI_EN: 'pri_01m2zqpjqn0qxtcrhpgmytv31y',
  FR_EN: 'pri_01m2znh0m1z4e5j73hadrnp1ng',

  // 2026-09-16 scope trim: EN_JA is no longer purchasable (removed from
  // PTW_PAIRS above) -- its price id is dropped rather than left pointing
  // at a direction that no longer ships.
};

/* True only if THIS pair can actually be bought. Per-pair rather than
   global, so shipping a second direction later doesn't require the
   first one to wait. */
function paddleIsConfigured(pairId) {
  if (PADDLE_TOKEN.startsWith('REPLACE')) return false;
  const price = PADDLE_PRICES[pairId];
  return Boolean(price) && !price.startsWith('REPLACE');
}

function initPaddle() {
  if (typeof Paddle === 'undefined') return false;
  if (PADDLE_TOKEN.startsWith('REPLACE')) return false;
  try {
    // Paddle.Environment.set is only called for sandbox; calling it with
    // 'production' is unnecessary and some SDK versions reject it.
    if (PADDLE_ENVIRONMENT !== 'production') Paddle.Environment.set(PADDLE_ENVIRONMENT);
    Paddle.Initialize({
      token: PADDLE_TOKEN,
      // Paddle.Checkout.open() below has no .catch() and no return value to
      // check -- a failure on Paddle's own side (an invalid price, the
      // account not yet approved for live transactions, a network error)
      // previously left the user staring at a blank overlay with no error
      // shown anywhere, confirmed live 2026-10-05 (console-only: "API
      // Error: Transaction checkout creation is blocked for this vendor").
      // This is Paddle Billing's own documented mechanism for surfacing
      // exactly that: every checkout event, success or failure, comes
      // through here.
      eventCallback: function (event) {
        if (event && event.name === 'checkout.error') {
          console.error('[ptw] Paddle checkout error:', event.data);
          alert('That payment could not be started'
            + (event.data && event.data.error && event.data.error.detail
               ? ': ' + event.data.error.detail
               : '.')
            + '\n\nNothing has been charged. Please try again in a moment, or use a different payment method.');
        }
      },
    });
    return true;
  } catch (e) {
    console.error('Paddle init failed:', e);
    return false;
  }
}

/* Opens checkout for the selected pair. The Supabase user id travels
   with the order as customData, so the webhook knows which account to
   grant the entitlement to.

   The user MUST be logged in. Without a user id the payment succeeds
   and the licence has nowhere to land — the webhook logs it as
   unattributable and someone has to grant it by hand. Better to ask
   them to log in first. */
/* Find the logged-in user.

   pricing.html does not load the Supabase library -- it only loads paddle.js
   and this file -- so `supabaseClient` is undefined here and the old code
   concluded "not logged in" for everyone, however logged in they were.

   Route 1 still uses supabaseClient if a page happens to have it (the app
   pages do). Route 2 reads the session Supabase itself persists in
   localStorage under sb-<project-ref>-auth-token, which needs no library and
   no key. Newer supabase-js versions base64-encode that value, so both shapes
   are handled. */
async function ptwGetUser() {
  // Route 1: a real client, if this page has one.
  try {
    if (typeof supabaseClient !== 'undefined') {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (user && user.id) return { id: user.id, email: user.email };
    }
  } catch (e) { /* fall through */ }

  // Route 2: the stored session.
  const session = ptwStoredSession();
  if (session && session.user && session.user.id) {
    return { id: session.user.id, email: session.user.email };
  }

  return null;
}

/* The raw session Supabase persists in localStorage, or null. */
function ptwStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue;

      let raw = localStorage.getItem(key);
      if (!raw) continue;
      if (raw.startsWith('base64-')) raw = atob(raw.slice(7));

      const parsed = JSON.parse(raw);
      const session = (parsed && parsed.currentSession) ? parsed.currentSession : parsed;
      if (session && session.user && session.user.id) return session;
    }
  } catch (e) { /* unreadable or absent -- treated as logged out */ }
  return null;
}

/* Which pairs does this account already own?

   Two routes, same reasoning as ptwGetUser(): use the app's Supabase client
   when the page has one, otherwise talk to Supabase's REST endpoint directly
   using the access token from the stored session. Returns [] on any failure,
   so a network problem never blocks someone from buying. */
const PTW_SUPABASE_URL = 'https://pqdrtqnmfzgnrderwrzl.supabase.co';

/* Optional. If entitlement checking on the pricing page does not work, copy
   the anon/publishable key out of auth.js and paste it here. It is a public
   key -- it already ships inside your site's JavaScript. Leaving it blank is
   fine: the code falls back to using the session token. */
const PTW_SUPABASE_ANON_KEY = '';

async function ptwGetEntitlements() {
  // Route 1: the app's own client.
  try {
    if (typeof supabaseClient !== 'undefined') {
      const user = await ptwGetUser();
      if (!user) return [];
      const { data } = await supabaseClient
        .from('entitlements').select('pair').eq('user_id', user.id);
      if (data) return data.map(r => r.pair);
    }
  } catch (e) { /* fall through */ }

  // Route 2: REST, using the stored session's access token.
  try {
    const session = ptwStoredSession();
    if (!session || !session.access_token || !session.user) return [];

    const key = PTW_SUPABASE_ANON_KEY || session.access_token;
    const res = await fetch(
      `${PTW_SUPABASE_URL}/rest/v1/entitlements?user_id=eq.${session.user.id}&select=pair`,
      { headers: { apikey: key, Authorization: `Bearer ${session.access_token}` } }
    );
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map(r => r.pair) : [];
  } catch (e) {
    return [];
  }
}

async function openPaddleCheckout(pairId) {
  if (!paddleIsConfigured(pairId)) {
    const pair = PTW_PAIRS.find(p => p.id === pairId);
    alert((pair ? pair.name : pairId) + ' isn\'t on sale yet. It\'s coming shortly.');
    return;
  }

  const found = await ptwGetUser();
  const userId = found ? found.id : null;
  const email = found ? found.email : null;

  // Visible in the browser console (F12) if a checkout ever refuses to open.
  console.log('[ptw] checkout user lookup:', userId ? 'found ' + userId : 'NOT FOUND');

  if (!userId) {
    alert('Please log in or create a free account first, so your purchase can be added to it.\n\nIt takes a moment and means your licence follows you to any device.');
    if (typeof ptwOpenLogin === 'function') ptwOpenLogin();
    return;
  }

  Paddle.Checkout.open({
    items: [{ priceId: PADDLE_PRICES[pairId], quantity: 1 }],
    customer: email ? { email } : undefined,
    customData: { pair: pairId, supabase_user_id: userId },
    settings: {
      displayMode: 'overlay',
      theme: 'light',
      // Not the homepage: a page that tells them the payment worked and waits
      // for the webhook. Landing on the homepage after paying reads as
      // "nothing happened", which is how chargebacks start.
      successUrl: window.location.origin + '/thank-you.html?gw=paddle',
    },
  });
}


/* ── Razorpay ──────────────────────────────────────────────────────
   2026-10-05: Razorpay now handles EVERY buyer, India and international
   alike -- replacing Paddle entirely in the checkout flow, per the user's
   explicit decision (see TODO.md's 2026-10-04 Razorpay International
   feasibility research: the fee/compliance trade-off was already
   researched and weighed before this change). Paddle's own integration
   code (openPaddleCheckout, initPaddle) is left in place, just never
   called -- the same instant-rollback pattern this file already used for
   the India-only flag below, now one level up.

   The price is NOT sent from this file. The browser asks the server to
   create an order, and the server decides the amount AND currency from
   its own logic (Netlify's GeoIP, not anything the browser claims). If
   the amount travelled from here, anyone could edit it in devtools and
   buy the library for one rupee.                                       */

const RAZORPAY_ORDER_ENDPOINT =
  '/.netlify/functions/razorpay-order';

/* Set to false to send every buyer back through Paddle -- useful as an
   instant rollback if anything goes wrong, without a redeploy of the
   functions. */
const RAZORPAY_ENABLED = true;

function ptwUseRazorpay(countryCode) {
  return RAZORPAY_ENABLED
    && typeof Razorpay !== 'undefined'
    // PTW-PAYSELECT: honour the buyer's choice, if a chooser is ever added back.
    && (window.PTW_PAYMENT_CHOICE || 'razorpay') === 'razorpay';
}

async function openRazorpayCheckout(pairId) {
  const session = ptwStoredSession();
  if (!session || !session.access_token) {
    alert('Please log in or create a free account first, so your purchase can be added to it.');
    if (typeof ptwOpenLogin === 'function') ptwOpenLogin();
    return;
  }

  let order;
  try {
    const res = await fetch(RAZORPAY_ORDER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ pair: pairId }),
    });
    order = await res.json();
    if (!res.ok) {
      alert(order && order.error ? order.error : 'Could not start checkout. Please try again.');
      return;
    }
  } catch (e) {
    console.error('[ptw] razorpay order failed:', e);
    alert('Could not reach the payment server. Please check your connection and try again.');
    return;
  }

  const pair = PTW_PAIRS.find(p => p.id === pairId);

  const rzp = new Razorpay({
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    name: 'Shabdah',
    description: pair ? pair.name : pairId,
    image: window.location.origin + '/assets/icons/shabdah-logo.png',
    prefill: { email: order.email || '' },
    theme: { color: '#1e7a4b' },
    handler: function () {
      // The entitlement is granted by the webhook, not by this callback --
      // a browser that closes early must not cost someone their purchase.
      // The thank-you page waits for it either way.
      window.location.href = window.location.origin + '/thank-you.html?gw=razorpay';
    },
    modal: {
      ondismiss: function () {
        console.log('[ptw] razorpay checkout dismissed');
      },
    },
  });

  rzp.on('payment.failed', function (resp) {
    console.error('[ptw] razorpay payment failed:', resp.error);
    alert('That payment did not go through'
      + (resp.error && resp.error.description ? ': ' + resp.error.description : '.')
      + '\n\nNothing has been charged. You can try again, or use a different method.');
  });

  rzp.open();
}

/* The single entry point the buy button calls. Picks the right provider,
   so nothing else on the page needs to know there are two. pairId defaults
   to PTW_CHECKOUT_PAIR -- there's no picker on the page any more, since one
   purchase grants both pairs regardless of which price/order this opens. */
async function ptwBuy(pairId) {
  pairId = pairId || PTW_CHECKOUT_PAIR;
  if (ptwUseRazorpay(ptwCountry)) return openRazorpayCheckout(pairId);
  return openPaddleCheckout(pairId);
}
