'use strict';

const { detectCaptcha } = require('../../shared/captchaDetector');

/**
 * src/handlers/qpublic.js
 *
 * Playwright handler for qPublic / Schneider Corp property search.
 * Coverage: FL, GA, SC, NC, AL, LA, and many more states.
 *
 * Both URL formats are supported:
 *   - Modern: qpublic.schneidercorp.com/Application.aspx?App={Name}&PageType=Search
 *   - Legacy: qpublic.net/{state}/{county}/search.html  (redirects to modern)
 *   - AppID:  qpublic.schneidercorp.com/Application.aspx?AppID=XXXX (lands on map)
 *
 * All search sections are displayed simultaneously on the search page —
 * there are no tabs to click. Each section has its own Search button.
 */

// ─── Selectors ────────────────────────────────────────────────────────────────

// Entry page: accept disclaimer (legacy qpublic.net pages)
const DISCLAIMER_SELECTORS = [
  'a:has-text("Yes, I accept")',
  'a:has-text("I accept")',
  'a:has-text("Accept")',
  'input[value*="accept" i]',
  'button:has-text("Accept")',
];

// Terms & Conditions modal that appears on first visit to schneidercorp.com
const TERMS_MODAL_SELECTORS = [
  'a.button-1:has-text("Agree")',
  'button:has-text("Agree")',
  '.modal a:has-text("Agree")',
  '[aria-label*="Terms"] a:has-text("Agree")',
];

// Entry page: navigate from map → search
const SEARCH_NAV_SELECTORS = [
  'a:has-text("Real Property Search")',
  'a:has-text("Property Search")',
  'li#search1 a',                          // Modern qPublic nav tab
  'a[href*="PageType=Search"]',
];

// qPublic modern search page inputs (ASP.NET IDs like ctlBodyPane_ctl0N_ctl01_txtXxx)
const PARCEL_INPUT_SELECTORS = [
  'input[id*="txtParcelID"]',              // ctl02 section
  'input[placeholder*="parcel number" i]',
  'input[placeholder*="parcel id" i]',
  'input[id*="parcel" i]',
  'input[name*="ParcelID" i]',
];

const OWNER_INPUT_SELECTORS = [
  'input[id*="ctlBodyPane_ctl00"][id*="txtName"]:not([id*="Exact"])', // ctl00 partial match
  'input[placeholder="enter name..."]',
  'input[id*="txtName"]:not([id*="Exact"])',
  'input[id*="OwnerName" i]',
  'input[placeholder*="owner" i]',
  'input[id*="txtLastName" i]',            // Legacy separate fields
  'input[name*="LastName" i]',
];

const OWNER_FIRST_SELECTORS = [
  'input[id*="txtFirstName" i]',
  'input[name*="FirstName" i]',
  'input[placeholder*="First Name" i]',
];

// Search submit buttons — qPublic uses <a> with __doPostBack, one per search type
// CSS class names are static across all qPublic Schneider deployments
const PARCEL_SEARCH_BTN  = 'a.tt-upm-parcelid-search-btn, a[id*="ctl02_ctl01_btnSearch"]';
const OWNER_SEARCH_BTN   = 'a.tt-upm-name-search-btn,    a[id*="ctl00_ctl01_btnSearch"]';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.click({ timeout });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        return sel;
      }
    } catch (_) {}
  }
  return null;
}

async function tryFill(page, selectors, value, timeout = 5000) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.clear({ timeout });
        await el.fill(value, { timeout });
        return sel;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Click the correct section Search button for owner or parcel search.
 * Dismisses any blocking modal first.
 */
async function clickSearchButton(page, searchMode) {
  const btnSel = searchMode === 'parcel' ? PARCEL_SEARCH_BTN : OWNER_SEARCH_BTN;
  try {
    const btn = page.locator(btnSel).first();
    if (await btn.count() === 0) return false;

    // Dismiss any modal that may block the click
    await dismissModal(page);

    // Try normal click first
    try {
      await btn.click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      console.log(`[qpublic] Clicked ${searchMode} search button: ${btnSel}`);
      return true;
    } catch (_) {
      // Modal still blocking — force click via JS dispatch
      console.log('[qpublic] Normal click blocked — using JS click');
      await page.evaluate((sel) => {
        const el = document.querySelector(sel.split(',')[0].trim());
        if (el) el.click();
      }, btnSel);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      return true;
    }
  } catch (e) {
    console.log(`[qpublic] Search button error: ${e.message}`);
  }
  return false;
}

/**
 * Dismiss any modal dialog blocking interaction (Terms & Conditions, cookie notice, etc.).
 */
async function dismissModal(page) {
  // Check for visible modal (.modal.in is Bootstrap's "visible" state)
  const hasModal = await page.evaluate(() => {
    const modal = document.querySelector('.modal.in, [role="dialog"][aria-modal="true"]');
    return !!modal;
  });

  if (hasModal) {
    console.log('[qpublic] Modal detected — dismissing...');
    const clicked = await tryClick(page, TERMS_MODAL_SELECTORS, 5000);
    if (clicked) {
      console.log(`[qpublic] Dismissed modal via: ${clicked}`);
      // Wait for modal to close
      await page.waitForSelector('.modal.in, [role="dialog"]', { state: 'hidden', timeout: 5000 }).catch(() => {});
    } else {
      // Try pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      console.log('[qpublic] Dismissed modal via Escape');
    }
  }
}

async function waitForResults(page) {
  // Handle Cloudflare JS challenge — it auto-resolves in ~3-8 seconds
  const isCloudflare = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes('cloudflare') &&
    (document.body.innerText.toLowerCase().includes('verifying') ||
     document.body.innerText.toLowerCase().includes('security verification'))
  );

  if (isCloudflare) {
    console.log('[qpublic] Cloudflare challenge detected — waiting for auto-resolve...');
    // Wait up to 15s for CF to redirect to the real page
    try {
      await page.waitForFunction(
        () => !document.body.innerText.toLowerCase().includes('cloudflare') ||
              document.body.innerText.toLowerCase().includes('owner name') ||
              !!document.querySelector('table'),
        { timeout: 15000 }
      );
    } catch (_) {
      console.log('[qpublic] Cloudflare did not auto-resolve within 15s');
    }
  }

  try {
    await page.waitForSelector('table tbody tr td, .results tr, #searchResults tr', { timeout: 12000 });
  } catch (_) {
    await page.waitForTimeout(2000);
  }
}

/**
 * Check if the current page is an entry/landing page (map or disclaimer).
 * Returns 'map' | 'disclaimer' | 'search'
 */
async function detectPageType(page) {
  return page.evaluate(() => {
    const url  = location.href.toLowerCase();
    const body = document.body.innerText.toLowerCase();

    // Disclaimer: contains acceptance language
    if (body.includes('i accept') || body.includes('disclaimer') && body.includes('accept')) return 'disclaimer';

    // Map: URL has PageType=Map, or page has map-specific elements without search inputs
    if (url.includes('pagetype=map') || url.includes('pagetype=1')) return 'map';

    // Check if key search inputs are present
    const hasParcelInput = !!document.querySelector('input[id*="txtParcelID"], input[placeholder*="parcel number" i]');
    const hasNameInput   = !!document.querySelector('input[placeholder="enter name..."], input[id*="txtName"]');

    if (!hasParcelInput && !hasNameInput) {
      // No search inputs visible — probably on map or error page
      // Count meaningful links (nav tabs, search buttons); Angular SPAs may have many
      const linkCount = document.querySelectorAll('a').length;
      const hasSearchLink = !!document.querySelector('a[href*="PageType=Search"], li#search1 a') ||
        Array.from(document.querySelectorAll('a')).some(a => /property search|^search$/i.test(a.textContent.trim()));
      return (linkCount > 5 || hasSearchLink) ? 'map' : 'error';
    }

    return 'search';
  });
}

/**
 * Wait for Schneider Angular SPA detail content to fully render.
 * networkidle fires before Angular populates fields; we poll for actual content.
 */
async function waitForAngularContent(page) {
  const ready = await page.waitForFunction(() => {
    // Schneider Angular component containers with rendered content
    const angularEl = document.querySelector(
      'app-parcel-summary, app-parcel-detail, app-property-detail, ' +
      '.tt-upm-parcel-detail-section, [class*="parcel-detail" i], [class*="parcel-info" i]'
    );
    if (angularEl && angularEl.innerText.trim().length > 80) return true;

    // Non-Angular fallback: substantial table content
    const rows = document.querySelectorAll('table tr');
    if (rows.length >= 4) {
      const text = Array.from(rows).slice(1).map(r => r.innerText.trim()).filter(Boolean).join(' ');
      if (text.length > 100) return true;
    }

    // DL-based content (dt/dd pairs)
    if (document.querySelectorAll('dt').length >= 3) return true;

    // Generic: any substantial content in a label+value layout
    const labelEls = document.querySelectorAll('[class*="label" i]');
    if (labelEls.length >= 3) return true;

    return false;
  }, { timeout: 12000 }).catch(() => null);

  if (!ready) {
    // Last resort: give Angular a fixed grace period
    await page.waitForTimeout(1500);
  }
}

/**
 * Extract all labeled fields from a detail page.
 * Handles: th/td tables, dt/dd lists, data-label attrs, and Angular label+value pairs.
 */
async function extractDetailFields(page) {
  return page.evaluate(() => {
    const data = {};

    // th/td row pattern
    document.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].innerText.trim().replace(/:$/, '');
        const value = cells[i + 1]?.innerText.trim() || '';
        if (label && value && label.length < 80 && !label.match(/^\d+$/)) {
          data[label] = value;
        }
      }
    });

    // dt/dd pairs
    document.querySelectorAll('dt').forEach(dt => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') {
        const label = dt.innerText.trim().replace(/:$/, '');
        if (label) data[label] = dd.innerText.trim();
      }
    });

    // data-label attributes
    document.querySelectorAll('[data-label]').forEach(el => {
      const label = el.getAttribute('data-label');
      if (label) data[label] = el.innerText.trim();
    });

    // Angular/Schneider label+value adjacent-sibling pattern (tt-upm-* components)
    // Elements with "label" in their class name whose next sibling holds the value
    document.querySelectorAll('span[class*="label" i], div[class*="label" i], p[class*="label" i]').forEach(labelEl => {
      const label = labelEl.innerText.trim().replace(/:$/, '');
      if (!label || label.length > 80 || label.match(/^\d+$/)) return;
      const next = labelEl.nextElementSibling;
      if (next) {
        const val = next.innerText.trim();
        if (val && val.length < 300 && !data[label]) data[label] = val;
      }
    });

    // Angular ng-reflect-label / aria-label on value containers
    document.querySelectorAll('[ng-reflect-label]').forEach(el => {
      const label = el.getAttribute('ng-reflect-label') || '';
      if (label && label.length < 80) {
        const val = el.innerText.trim();
        if (val && !data[label]) data[label] = val;
      }
    });

    return data;
  });
}

/**
 * Extract results table rows.
 */
async function extractResultsTable(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    // Pick the table with the most data rows
    for (const t of tables) {
      const rows = t.querySelectorAll('tr');
      if (rows.length > (best ? best.querySelectorAll('tr').length : 1)) best = t;
    }
    if (!best) return null;

    const allRows = Array.from(best.querySelectorAll('tr'));
    if (allRows.length < 2) return null;

    const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
    const rows = allRows.slice(1).map(row => ({
      cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
      href:  row.querySelector('a')?.getAttribute('href') || null,
    })).filter(r => r.cells.some(c => c.length > 0));

    return headers.length > 0 && rows.length > 0 ? { headers, rows } : null;
  });
}

/**
 * Old qpublic.net county pages are Xara-generated static HTML that embed a
 * link to the real qpublic.schneidercorp.com search app. The <a> tags have
 * no visible content so Playwright's click() fails (zero-size target).
 * Navigate directly to the embedded href instead.
 * Returns true if navigation happened.
 */
async function handleQpublicNetLanding(page) {
  const url = page.url();
  if (!url.includes('qpublic.net')) return false;

  const schneidercorpUrl = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="qpublic.schneidercorp.com"]')) {
      const href = a.getAttribute('href');
      if (href) return href;
    }
    return null;
  });

  if (!schneidercorpUrl) return false;

  console.log(`[qpublic] qpublic.net landing → direct nav to: ${schneidercorpUrl}`);
  try {
    // Use 'domcontentloaded' — CF challenge can delay 'load' / 'networkidle' >30s
    await page.goto(schneidercorpUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // Wait for the Angular search form to mount
    await page.waitForSelector(
      'input[id*="txtName"], input[placeholder="enter name..."], input[id*="txtParcelID"], input[placeholder*="parcel" i]',
      { timeout: 12000 }
    ).catch(() => {});
    await dismissModal(page);
    return true;
  } catch (e) {
    console.log(`[qpublic] schneidercorp nav failed: ${e.message?.substring(0, 80)}`);
    return false;
  }
}

// ─── ValidateUser.aspx handler ────────────────────────────────────────────────

/**
 * ValidateUser.aspx is a Schneider Corp session-guard interstitial.
 * It appears when navigating to a deep link without an active session.
 *
 * Resolution order:
 *   1. Extract destination from query params (url / returnUrl / ReturnUrl / AppID)
 *   2. Click "Continue" / "Proceed" / "Click here" buttons on the page
 *   3. Wait up to 12 s for a JS auto-redirect away from the page
 *   4. Build a search URL from the App= query param
 *   5. Navigate to the app root as a last resort
 *
 * Returns true if we successfully left ValidateUser.aspx, false otherwise.
 */
async function handleValidateUser(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes('ValidateUser.aspx')) return true; // Nothing to do

  console.log(`[qpublic] handleValidateUser: ${currentUrl}`);

  // ── 1. Try query-param destination ─────────────────────────────────────────
  const destFromParam = await page.evaluate(() => {
    const p = new URLSearchParams(location.search);
    const raw = p.get('url') || p.get('returnUrl') || p.get('ReturnUrl') || p.get('ReturnURL') || '';
    if (raw) return decodeURIComponent(raw);

    // Some deployments embed the AppID — build a search URL from it
    const appId = p.get('AppID');
    if (appId) return `https://qpublic.schneidercorp.com/Application.aspx?AppID=${appId}&PageType=Search`;

    // Build from App= param if present
    const app = p.get('App');
    if (app) return `https://qpublic.schneidercorp.com/Application.aspx?App=${app}&PageType=Search`;

    return '';
  });

  if (destFromParam && !destFromParam.includes('ValidateUser')) {
    console.log(`[qpublic] ValidateUser → navigating to param dest: ${destFromParam}`);
    try {
      await page.goto(destFromParam, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await dismissModal(page);
      if (!page.url().includes('ValidateUser.aspx')) return true;
      // Server redirected back to ValidateUser — session not yet established.
      // Fall through to click the Continue button on the ValidateUser page.
      console.log('[qpublic] ValidateUser → server re-redirected to ValidateUser; trying Continue click');
    } catch (_) {}
  }

  // ── 2. Click visible "Continue" / "Proceed" / "Click here" buttons ─────────
  const CONTINUE_SELECTORS = [
    'a:has-text("Continue")',        'button:has-text("Continue")',
    'a:has-text("Proceed")',         'button:has-text("Proceed")',
    'input[value*="Continue" i]',    'input[value*="Proceed" i]',
    'a:has-text("Click here")',      'a:has-text("click here")',
    'a:has-text("Search")',          'a[href*="PageType=Search"]',
    'a:has-text("Go to Search")',
    '#ctl00_ContentPlaceHolder1_btnContinue',
    'input[type="submit"]',
  ];

  console.log(`[qpublic] ValidateUser text: ${await page.evaluate(() => document.body.innerText.substring(0, 200))}`);

  const clicked = await tryClick(page, CONTINUE_SELECTORS, 5000);
  if (clicked) {
    console.log(`[qpublic] ValidateUser → clicked: ${clicked}`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (!page.url().includes('ValidateUser.aspx')) {
      await dismissModal(page);
      return true;
    }
  }

  // ── 2b. Submit the ASP.NET form directly (ValidateUser has hidden inputs but
  //        the Continue button may not be visible or scrolled off) ─────────────
  console.log('[qpublic] ValidateUser → no button found; submitting form directly');
  const submitted = await page.evaluate(() => {
    const form = document.getElementById('form1');
    if (!form) return false;
    // Try common PostBack event targets first
    const targets = ['ctl00$ContentPlaceHolder1$btnContinue', 'btnContinue', 'Continue'];
    for (const t of targets) {
      try { if (typeof __doPostBack === 'function') { __doPostBack(t, ''); return true; } } catch (_) {}
    }
    form.submit();
    return true;
  });
  if (submitted) {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissModal(page);
    if (!page.url().includes('ValidateUser.aspx')) {
      console.log(`[qpublic] ValidateUser → form submit resolved to: ${page.url()}`);
      return true;
    }
    console.log('[qpublic] ValidateUser → form submit still on ValidateUser');
  }

  // ── 3. Wait for JS auto-redirect ────────────────────────────────────────────
  console.log('[qpublic] ValidateUser → waiting for JS auto-redirect (25 s)...');
  try {
    await page.waitForFunction(
      () => !location.href.includes('ValidateUser.aspx'),
      { timeout: 25000 }
    );
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissModal(page);
    console.log(`[qpublic] ValidateUser → JS redirect resolved to: ${page.url()}`);
    return true;
  } catch (_) {
    console.log('[qpublic] ValidateUser → JS redirect timed out');
  }

  // ── 4. Navigate directly to the app search URL (extract from nested url= param) ──
  try {
    const appRoot = new URL(currentUrl);
    // App param may be in the nested url= value (e.g. ValidateUser.aspx?url=...App=FooGA...)
    let appParam = appRoot.searchParams.get('App') || appRoot.searchParams.get('AppID');
    if (!appParam) {
      const nestedRaw = appRoot.searchParams.get('url') || appRoot.searchParams.get('returnUrl') || '';
      if (nestedRaw) {
        try {
          const inner = new URL(nestedRaw);
          appParam = inner.searchParams.get('App') || inner.searchParams.get('AppID');
        } catch (_) {}
      }
    }
    const fallbackUrl = appParam
      ? `${appRoot.origin}/Application.aspx?App=${appParam}&PageType=Search`
      : `${appRoot.origin}/Application.aspx`;
    console.log(`[qpublic] ValidateUser → trying fallback: ${fallbackUrl}`);
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await dismissModal(page);
    return !page.url().includes('ValidateUser.aspx');
  } catch (_) {}

  console.log('[qpublic] ValidateUser → all resolution attempts failed');
  return false;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page  - Already navigated to qPublic URL
 * @param {object} params
 * @returns {Promise<object|null>}  null signals fallback to AI agent
 */
async function search(page, {
  accountNumber = '',
  firstName = '',
  lastName = '',
  fullName = '',
  onProgress = () => {},
}) {
  const searchMode = accountNumber ? 'parcel' : 'owner';
  onProgress(`qPublic handler: searching by ${searchMode === 'parcel' ? 'Parcel ID' : 'Owner Name'}...`);
  console.log(`[qpublic] mode=${searchMode} startUrl=${page.url()}`);

  // ── 0. CAPTCHA / bot-challenge check ──────────────────────────────────────
  const captcha = await detectCaptcha(page);
  if (captcha.detected) {
    onProgress(`CAPTCHA detected (${captcha.type}) — cannot proceed automatically.`);
    return { ...captcha, searchedUrl: page.url() };
  }

  // ── 1. Handle entry pages (disclaimer / map) ───────────────────────────────
  // Wait for Angular/React SPA to mount — qPublic schneidercorp pages can take
  // a moment to render nav links and search inputs after the page 'load' event.
  // Dismiss any Terms & Conditions modal that might block the search form.
  await dismissModal(page);
  await page.waitForFunction(
    () => document.querySelectorAll('a').length > 5 ||
          !!document.querySelector(
            'input[placeholder="enter name..."], input[id*="txtName"], ' +
            'input[id*="txtParcelID"], li#search1, a[href*="PageType=Search"]'
          ),
    { timeout: 15000 }
  ).catch(() => {});

  const pageType = await detectPageType(page);
  console.log(`[qpublic] detected page type: ${pageType}`);

  if (pageType === 'disclaimer') {
    onProgress('Accepting disclaimer...');
    // On old qpublic.net pages the "Yes, I accept" link has target="_new" so a
    // normal click opens a new tab Playwright can't follow. Extract the
    // schneidercorp.com href and goto() it directly instead.
    const landingHandled = await handleQpublicNetLanding(page);
    if (!landingHandled) {
      const clicked = await tryClick(page, DISCLAIMER_SELECTORS);
      if (!clicked) {
        console.log('[qpublic] Could not accept disclaimer — falling back');
        return null;
      }
      console.log(`[qpublic] Accepted disclaimer via: ${clicked}`);
    }
    const nextType = await detectPageType(page);
    console.log(`[qpublic] Page type after disclaimer: ${nextType}`);
    if (nextType !== 'search') {
      await tryClick(page, SEARCH_NAV_SELECTORS);
    }
  }

  if (pageType === 'map' || pageType === 'error') {
    const currentUrl = page.url();
    if (currentUrl.includes('ValidateUser.aspx')) {
      onProgress('Handling session validation...');
      await handleValidateUser(page);
    } else {
      onProgress('Navigating to search page...');
      // Try direct navigation for old qpublic.net Xara landing pages first
      const landingHandled = await handleQpublicNetLanding(page);
      const clicked = landingHandled ? null : await tryClick(page, SEARCH_NAV_SELECTORS);
      if (!landingHandled && !clicked) {
        // Build a search URL by replacing/adding PageType=Search.
        // Handle both PageTypeID=N (AppID-format) and PageType=Map forms.
        let searchUrl;
        if (/PageTypeID=/i.test(currentUrl)) {
          // Remove PageID and PageTypeID, add PageType=Search
          searchUrl = currentUrl
            .replace(/[?&]PageTypeID=[^&]*/i, '')
            .replace(/[?&]PageID=[^&]*/i, '')
            .replace(/(\?.*)/, '$1&PageType=Search')
            .replace(/^([^?]*)$/, '$1?PageType=Search');
        } else {
          searchUrl = currentUrl.includes('?')
            ? currentUrl.replace(/PageType=[^&]*/i, 'PageType=Search')
            : currentUrl + '?PageType=Search';
        }
        try {
          await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
          console.log(`[qpublic] Navigated to search URL: ${searchUrl}`);
        } catch (e) {
          console.log('[qpublic] Could not reach search page — falling back');
          return null;
        }
      } else {
        console.log(`[qpublic] Navigated via: ${clicked}`);
      }
    }
  }

  // Verify we're on the search page now; handle ValidateUser.aspx if present
  let currentType = await detectPageType(page);
  console.log(`[qpublic] Current page type: ${currentType} url: ${page.url()}`);

  if (page.url().includes('ValidateUser.aspx')) {
    onProgress('Session validation — resolving...');
    const resolved = await handleValidateUser(page);
    if (!resolved) {
      console.log('[qpublic] ValidateUser resolution failed — falling back');
      return null;
    }
    currentType = await detectPageType(page);
    console.log(`[qpublic] After ValidateUser resolution, type: ${currentType} url: ${page.url()}`);
  }

  if (currentType !== 'search') {
    // One last try: click the Search nav tab
    const clicked = await tryClick(page, SEARCH_NAV_SELECTORS);
    if (clicked) {
      await dismissModal(page);
      currentType = await detectPageType(page);
    }
  }

  if (currentType !== 'search') {
    console.log('[qpublic] Not on search page after all attempts — falling back');
    return null;
  }

  onProgress('Search page ready.');

  // ── 2. Fill the appropriate search input ──────────────────────────────────
  let filledSelector = null;

  if (searchMode === 'parcel') {
    filledSelector = await tryFill(page, PARCEL_INPUT_SELECTORS, accountNumber);
    if (filledSelector) {
      console.log(`[qpublic] Filled parcel input: ${filledSelector}`);
    }
  } else {
    const nameForSearch = fullName || lastName || '';
    filledSelector = await tryFill(page, OWNER_INPUT_SELECTORS, nameForSearch);
    if (filledSelector) {
      console.log(`[qpublic] Filled owner name: ${filledSelector} = ${nameForSearch}`);
      // Try filling first name too if present
      if (firstName) await tryFill(page, OWNER_FIRST_SELECTORS, firstName);
    }
  }

  if (!filledSelector) {
    console.log('[qpublic] Could not find search input — falling back');
    return null;
  }

  // ── 3. Click the correct section Search button ────────────────────────────
  onProgress('Submitting search...');
  const clicked = await clickSearchButton(page, searchMode);
  if (!clicked) {
    console.log('[qpublic] Search button not found — pressing Enter as fallback');
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  console.log(`[qpublic] After submit URL: ${page.url()}`);

  // ── 4. Wait for results (with Cloudflare challenge handling) ───────────────
  onProgress('Waiting for results...');
  await waitForResults(page);

  // Capture page text; detect and wait through Cloudflare if needed
  let pageText = await page.evaluate(() => document.body.innerText.substring(0, 800));
  const isCF = pageText.toLowerCase().includes('cloudflare') &&
               (pageText.toLowerCase().includes('verifying') ||
                pageText.toLowerCase().includes('security verification') ||
                pageText.toLowerCase().includes('ray id'));

  if (isCF) {
    console.log('[qpublic] Cloudflare challenge — waiting up to 15s for auto-resolve...');
    onProgress('Cloudflare security check — waiting...');
    try {
      await page.waitForFunction(
        () => !document.body.innerText.toLowerCase().includes('ray id') &&
              !document.body.innerText.toLowerCase().includes('security verification'),
        { timeout: 15000 }
      );
      pageText = await page.evaluate(() => document.body.innerText.substring(0, 800));
      console.log('[qpublic] Cloudflare resolved.');
    } catch (_) {
      console.log('[qpublic] Cloudflare did not auto-resolve — returning empty results');
      return {
        records: [], totalFound: 0,
        summary: 'Search blocked by Cloudflare security check on qPublic. Try again in a few minutes.',
        searchedUrl: page.url(),
      };
    }
  }

  console.log(`[qpublic] Results page preview:\n${pageText}\n---`);

  // ── 5. Extract results table ───────────────────────────────────────────────
  const tableData = await extractResultsTable(page);
  console.log('[qpublic] tableData:', JSON.stringify(tableData || null).substring(0, 400));

  if (!tableData || tableData.rows.length === 0) {
    onProgress('No results found.');
    return {
      records: [],
      totalFound: 0,
      summary: `No records found for ${searchMode === 'parcel' ? 'Parcel ID: ' + accountNumber : 'Owner: ' + (fullName || lastName)}.`,
      searchedUrl: page.url(),
    };
  }

  const { headers, rows } = tableData;

  // Cap detail page loading — for parcel searches load all (usually 1),
  // for owner name searches cap at 20 to stay responsive
  const MAX_DETAILS = searchMode === 'parcel' ? rows.length : Math.min(rows.length, 20);
  const cappedRows = rows.slice(0, MAX_DETAILS);
  onProgress(`Found ${rows.length} result(s). Loading details for first ${cappedRows.length}...`);

  // ── 6. Navigate to detail page for each result ─────────────────────────────
  const records = [];
  const searchResultsUrl = page.url();
  const baseUrl = new URL(page.url()).origin;

  for (let i = 0; i < cappedRows.length; i++) {
    const { cells, href } = cappedRows[i];
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ''; });

    const parcelId   = obj['Parcel ID'] || obj['Parcel Number'] || obj['Account Number'] || cells[0] || '';
    const ownerName  = obj['Owner Name'] || obj['Owner']         || cells[1] || '';
    const address    = obj['Property Address'] || obj['Situs Address'] || obj['Address'] || cells[2] || '';
    const appraised  = obj['Appraised Value'] || obj['Total Appraised'] || obj['Market Value'] || '';

    const summaryRecord = {
      parcelId, ownerName, propertyAddress: address, taxAmountDue: appraised,
      legalDescription: obj['Legal Description'] || obj['Legal'] || '',
      taxYear: '', paymentStatus: '', county: '', state: '',
    };

    let detailFields = {};
    try {
      let detailUrl = '';
      if (href) {
        detailUrl = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      }

      if (detailUrl) {
        onProgress(`Loading detail for ${parcelId || 'record ' + (i + 1)}...`);
        console.log(`[qpublic] Detail URL: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForAngularContent(page);
        detailFields = await extractDetailFields(page);
        console.log(`[qpublic] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 600));
        onProgress(`Extracted ${Object.keys(detailFields).length} detail fields.`);
      }
    } catch (err) {
      console.log(`[qpublic] Detail error for ${parcelId}: ${err.message}`);
    }

    records.push({
      ...summaryRecord,
      ownerName:        detailFields['Owner Name']          || detailFields['Owner']            || summaryRecord.ownerName,
      propertyAddress:  detailFields['Situs Address']       || detailFields['Property Address'] || detailFields['Address'] || summaryRecord.propertyAddress,
      legalDescription: detailFields['Legal Description']   || detailFields['Legal']            || summaryRecord.legalDescription,
      taxAmountDue:     detailFields['Total Appraised']     || detailFields['Market Value']     || detailFields['Appraised Value'] || summaryRecord.taxAmountDue,
      additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
    });

    if (i < cappedRows.length - 1) {
      try {
        await page.goto(searchResultsUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForResults(page);
      } catch (_) {}
    }
  }

  const label = searchMode === 'parcel' ? `Parcel ID ${accountNumber}` : (fullName || lastName);
  const totalStr = rows.length > cappedRows.length
    ? `${rows.length} total, showing first ${records.length}`
    : `${records.length}`;
  return {
    records,
    totalFound: rows.length,
    summary: `Found ${totalStr} record(s) for ${label} (qPublic).`,
    searchedUrl: searchResultsUrl,
  };
}

module.exports = { search };
