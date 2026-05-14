'use strict';

/**
 * src/tax/handlers/ptaxpro.js
 *
 * Handler for the PTaxPro / whoownsit.com county aggregator template.
 * Used by ~60+ TX counties at {county}cad.com / {county}cad.org domains.
 *
 * Search flow:
 *   1. Fill #name-addr-acctno with owner name
 *   2. Submit form → POST to results/
 *   3. Parse #results_table for first match
 *   4. Navigate to property/?id=... detail page
 *   5. Parse #property_table (Owner Name, Property Location, Legal Description)
 *
 * Note: these sites do not expose appraised/assessed values (freemium model),
 * so results are always partial (owner + address + legal desc only).
 */

const { detectCaptcha } = require('../../shared/captchaDetector');

async function search(page, { firstName, lastName, fullName, onProgress }) {
  const searchName = fullName || [lastName, firstName].filter(Boolean).join(', ') || lastName || firstName || 'Smith';
  onProgress(`[ptaxpro] Searching for "${searchName}"…`);

  try {
    // Ensure we're on the homepage with the search form
    const currentUrl = page.url();
    const base = new URL(currentUrl).origin + '/';

    // Navigate to homepage if not already there
    if (!currentUrl.endsWith('/') && !currentUrl.match(/\/$|\/index/)) {
      await page.goto(base, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    }

    // Check captcha
    if (await detectCaptcha(page)) {
      return { status: 'captcha', source: page.url() };
    }

    // Find and fill the search input
    const inputSel = '#name-addr-acctno, input[name="name-addr-acctno"], .search-input[type="text"]';
    const input = page.locator(inputSel).first();
    if (await input.count({ timeout: 8000 }) === 0) {
      onProgress('[ptaxpro] Search input not found');
      return null;
    }

    await input.clear({ timeout: 5000 });
    await input.fill(searchName, { timeout: 5000 });

    // Submit the form
    const submitSel = '#search_form button[type="submit"], #search_form input[type="submit"], .search-input ~ button, button:has-text("Search")';
    const submitBtn = page.locator(submitSel).first();
    if (await submitBtn.count({ timeout: 3000 }) > 0) {
      await submitBtn.click({ timeout: 5000 });
    } else {
      await input.press('Enter');
    }

    // Wait for results page
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(500);

    if (await detectCaptcha(page)) {
      return { status: 'captcha', source: page.url() };
    }

    // Check for "no results" or "more specific" message
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    if (/please enter a more specific|no results found|no records found/i.test(bodyText)) {
      onProgress('[ptaxpro] No results for search term — trying last name only');
      // Try again with just last name if full name was used
      if (lastName && searchName !== lastName) {
        await page.goto(base, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
        const input2 = page.locator(inputSel).first();
        if (await input2.count({ timeout: 5000 }) > 0) {
          await input2.fill(lastName, { timeout: 5000 });
          await input2.press('Enter');
          await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
        }
      } else {
        return { status: 'no_results', source: page.url() };
      }
    }

    // Parse results table
    const tableData = await page.evaluate(() => {
      const table = document.querySelector('#results_table');
      if (!table) return null;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      if (!rows.length) return null;
      const first = rows[0];
      const cells = Array.from(first.querySelectorAll('td'));
      const accountNumber = (cells[0]?.innerText || '').trim();
      const ownerName = (cells[1]?.innerText || '').trim();
      const address = (cells[2]?.innerText || '').trim();
      const link = first.querySelector('a[href*="property"]')?.href || null;
      return { accountNumber, ownerName, address, link, total: rows.length };
    }).catch(() => null);

    if (!tableData) {
      return { status: 'no_results', source: page.url() };
    }

    onProgress(`[ptaxpro] Found ${tableData.total} result(s), loading detail for account ${tableData.accountNumber}`);

    // Navigate to property detail page
    if (tableData.link) {
      await page.goto(tableData.link, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Parse property detail table
    const detail = await page.evaluate(() => {
      const table = document.querySelector('#property_table');
      if (!table) return {};
      const map = {};
      Array.from(table.querySelectorAll('tr')).forEach(row => {
        const th = row.querySelector('th');
        const td = row.querySelector('td');
        if (th && td) {
          const key = (th.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const val = (td.innerText || '').replace(/\s+/g, ' ').trim();
          if (key && val) map[key] = val;
        }
      });
      return map;
    }).catch(() => ({}));

    const ownerName   = detail['owner name'] || tableData.ownerName || '';
    const situsAddr   = detail['property location'] || tableData.address || '';
    const legalDesc   = detail['legal description'] || '';

    if (!ownerName && !situsAddr) {
      return { status: 'no_results', source: page.url() };
    }

    return {
      status: 'partial',
      source: page.url(),
      accountNumber: tableData.accountNumber || '',
      ownerName,
      situsAddress: situsAddr,
      legalDescription: legalDesc,
      appraisedValue: '',
      assessedValue: '',
      taxAmountDue: '',
      taxYear: '',
      score: 40,
    };

  } catch (err) {
    onProgress(`[ptaxpro] Error: ${err.message}`);
    return null;
  }
}

module.exports = { search };
