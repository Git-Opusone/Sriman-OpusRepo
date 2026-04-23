'use strict';
const { chromium } = require('playwright-extra');
const stealth      = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  const url = 'https://gis.vgsi.com/BoltonCT/';
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`Landed at: ${page.url()}`);

  // Dump all tab/nav links
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, td.tab, li, [onclick]'))
      .filter(el => {
        const t = el.innerText?.trim() || '';
        return t && t.length < 60;
      })
      .slice(0, 30)
      .map(el => ({
        tag: el.tagName,
        id: el.id,
        text: el.innerText?.trim(),
        href: el.getAttribute('href') || el.getAttribute('onclick') || null,
      }))
  );
  console.log('\n── Tabs / nav elements ─────────────────────');
  tabs.forEach(t => console.log(JSON.stringify(t)));

  // Dump all visible inputs
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, textarea'))
      .map(el => ({
        tag:   el.tagName,
        type:  el.type || null,
        id:    el.id   || null,
        name:  el.name || null,
        value: el.value?.substring(0, 40) || null,
        placeholder: el.placeholder || null,
      }))
  );
  console.log('\n── All inputs ──────────────────────────────');
  inputs.forEach(i => console.log(JSON.stringify(i)));

  // Check for VIEWSTATE
  const hasVS = await page.evaluate(() => !!document.querySelector('input[name="__VIEWSTATE"]'));
  console.log('\n__VIEWSTATE present:', hasVS);

  // Try clicking owner tab
  const ownerTabSels = [
    'a:has-text("Owner Name")',
    'a:has-text("By Owner")',
    'a:has-text("Owner")',
    'input[type="submit"][value*="Owner" i]',
    '[id*="lbtnOwner" i]',
    '[id*="lnkOwner" i]',
    'td.tab:has-text("Owner")',
  ];
  let clicked = null;
  for (const sel of ownerTabSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`\nFound owner tab: ${sel}`);
        await el.click({ timeout: 5000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(800);
        clicked = sel;
        break;
      }
    } catch (_) {}
  }
  console.log('\nOwner tab clicked:', clicked || 'NONE FOUND');

  // Dump inputs after tab click
  const inputs2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(el => el.type !== 'hidden')
      .map(el => ({
        type:  el.type || null,
        id:    el.id   || null,
        name:  el.name || null,
        placeholder: el.placeholder || null,
      }))
  );
  console.log('\n── Inputs after owner tab click ────────────');
  inputs2.forEach(i => console.log(JSON.stringify(i)));

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
