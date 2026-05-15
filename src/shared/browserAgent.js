'use strict';

/**
 * AI Browser Agent
 * Uses Playwright for browser automation and OpenAI (GPT-4o-mini vision) to intelligently
 * navigate county property tax websites, fill search forms, and extract results.
 */

const { chromium: chromiumBase } = require('playwright');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const OpenAI = require('openai');

// Apply stealth plugin — bypasses Cloudflare and other bot-detection systems
chromiumExtra.use(StealthPlugin());

const { detectFromUrl, detectFromHtml, platformLabel } = require('./platformDetector');
const qpublicHandler          = require('../tax/handlers/qpublic');
const tylerHandler            = require('../tax/handlers/tyler');
const beaconHandler           = require('../tax/handlers/beacon');
const patriotHandler          = require('../tax/handlers/patriot');
const visionHandler           = require('../tax/handlers/vision');
const bisHandler              = require('../tax/handlers/bis');
const publicPortalHandler     = require('../tax/handlers/publicportal');
const andersonTaxHandler      = require('../tax/handlers/andersontax');
const actwebHandler           = require('../tax/handlers/actweb');
const ptaxproHandler          = require('../tax/handlers/ptaxpro');
const { detectCaptcha }       = require('./captchaDetector');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Model to use — must support both vision and tool/function calling.
// Default: gpt-4o-mini (vision + tool calling)
// See all models at: https://platform.openai.com/docs/models
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Tool definitions — OpenAI format  ({ type: "function", function: {...} })
// ---------------------------------------------------------------------------

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        'Capture a screenshot of the current browser page. Use this to visually inspect the page layout, find form fields, and verify results.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_content',
      description:
        'Get the current page URL, title, visible text content, all input fields, and all clickable buttons/links. Use this to understand page structure and available form fields.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill_input',
      description: 'Fill a form input field with a value. Clears the field first before typing.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description:
              "CSS selector for the input (e.g. \"#ownerName\", \"input[name='search']\", \".search-input\")",
          },
          value: {
            type: 'string',
            description: 'The text value to enter into the field',
          },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description:
        'Click on a page element such as a button, link, or tab. Waits for the page to settle after clicking.',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS selector for the element to click',
          },
          text: {
            type: 'string',
            nullable: true,
            description:
              'Visible text of the element to click (used when selector is unknown). E.g. "Search", "Submit". Omit or pass null if using selector.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: 'Select a value from a <select> dropdown element.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the <select> element' },
          value: { type: 'string', description: 'The option value or visible text to select' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Press a keyboard key. Common uses: "Enter" to submit a form, "Tab" to move focus.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: "Enter", "Tab", "Escape", etc.' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for the page to finish loading, or add extra delay for slow pages.',
      parameters: {
        type: 'object',
        properties: {
          milliseconds: {
            type: 'number',
            description: 'Extra milliseconds to wait after network is idle (default 0)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the browser to a different URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_results',
      description:
        'Call this ONLY when you have successfully found and read all property/tax records. This finalizes the agent run and returns the structured results.',
      parameters: {
        type: 'object',
        properties: {
          records: {
            type: 'array',
            description: 'All property/tax records found on the page',
            items: {
              type: 'object',
              properties: {
                ownerName: { type: 'string', description: 'Full name of the property owner/taxpayer' },
                propertyAddress: { type: 'string', description: 'Full property/mailing address' },
                parcelId: { type: 'string', description: 'Parcel ID, account number, or property ID' },
                taxYear: { type: 'string', description: 'Tax year (e.g. "2025")' },
                taxAmountDue: { type: 'string', description: 'Total tax amount due (e.g. "$1,234.56")' },
                paymentStatus: {
                  type: 'string',
                  description: 'Payment status: Paid, Unpaid, Partial, Delinquent, etc.',
                },
                county: { type: 'string', description: 'County name' },
                state: { type: 'string', description: 'State abbreviation (e.g. "TX")' },
                legalDescription: { type: 'string', description: 'Legal description of the property' },
                additionalDetails: {
                  type: 'object',
                  description: 'Any other relevant details (appraised value, exemptions, due dates, etc.)',
                },
              },
            },
          },
          totalFound: { type: 'number', description: 'Total count of matching records found' },
          summary: {
            type: 'string',
            description: 'One-sentence summary of what was found (e.g. "Found 2 records for John Smith")',
          },
          searchedUrl: { type: 'string', description: 'The URL where results were found' },
        },
        required: ['records', 'totalFound', 'summary'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(page, toolName, input) {
  switch (toolName) {
    case 'take_screenshot': {
      // Get raw Buffer and convert to base64 manually — avoids potential whitespace/line-break
      // issues that occur when using Playwright's encoding:'base64' option directly.
      const buf = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 });
      const data = buf.toString('base64').replace(/\s/g, '');
      return { _type: 'image', data, mimeType: 'image/jpeg' };
    }

    case 'get_page_content': {
      return await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          id: el.id || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          className: el.className || null,
          value: el.value || null,
          options:
            el.tagName === 'SELECT'
              ? Array.from(el.options).map((o) => ({ value: o.value, text: o.text }))
              : undefined,
        }));

        const buttons = Array.from(
          document.querySelectorAll('button, input[type="submit"], input[type="button"], a[class*="btn"]')
        ).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || '').trim().substring(0, 80),
          id: el.id || null,
          className: (el.className || '').substring(0, 100),
        }));

        return {
          url: window.location.href,
          title: document.title,
          bodyText: document.body.innerText.substring(0, 6000),
          inputs,
          buttons,
        };
      });
    }

    case 'fill_input': {
      try {
        await page.fill(input.selector, input.value, { timeout: 15000 });
        return { success: true, message: `Filled "${input.value}" into ${input.selector}` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'click_element': {
      try {
        if (input.selector) {
          await page.click(input.selector, { timeout: 15000 });
        } else if (input.text && typeof input.text === 'string') {
          await page.getByText(input.text, { exact: false }).first().click({ timeout: 15000 });
        } else {
          return { success: false, message: 'Provide either selector or text' };
        }
        await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
        return { success: true, message: 'Clicked and page settled' };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'select_option': {
      try {
        await page
          .selectOption(input.selector, { label: input.value }, { timeout: 15000 })
          .catch(async () => {
            await page.selectOption(input.selector, { value: input.value }, { timeout: 15000 });
          });
        return { success: true, message: `Selected "${input.value}"` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'press_key': {
      await page.keyboard.press(input.key);
      await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
      return { success: true, message: `Pressed ${input.key}` };
    }

    case 'wait': {
      await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
      if (input.milliseconds > 0) await page.waitForTimeout(input.milliseconds);
      return { success: true, message: 'Page settled' };
    }

    case 'navigate': {
      try {
        await page.goto(input.url, { waitUntil: 'networkidle', timeout: 90000 });
        return { success: true, message: `Navigated to ${input.url}` };
      } catch (err) {
        return { success: false, message: `Navigation failed: ${err.message}. Stay on the current page and try a different approach.` };
      }
    }

    case 'extract_results':
      return { success: true, message: 'Results captured' };

    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Main agent runner
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string} params.url          - County search website URL
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} [params.fullName]
 * @param {string} [params.accountNumber]
 * @param {function} [params.onProgress] - Optional callback(message: string)
 */
async function runBrowserAgent({
  url,
  firstName,
  lastName,
  fullName,
  accountNumber,
  onProgress = () => {},
}) {
  const headless = process.env.BROWSER_HEADLESS !== 'false';

  // Use stealth-enhanced chromium for platforms that use Cloudflare/bot detection
  const chromium = chromiumExtra;

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Forward browser console.log messages to Node stdout (useful for handler debug logs)
  page.on('console', msg => {
    if (msg.type() === 'log') console.log('[browser-console]', msg.text());
  });

  // Remove the webdriver flag that sites use to detect automation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    onProgress('Launching browser and navigating to county website...');
    // Use 'domcontentloaded' — BIS SPAs with continuous polling never reach networkidle,
    // and 'load' can also stall waiting for large JS bundles. The handler waits for the
    // search form itself, which is a more reliable signal than network state.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Build search criteria list
    const criteria = [];
    if (firstName) criteria.push(`First Name: "${firstName}"`);
    if (lastName) criteria.push(`Last Name: "${lastName}"`);
    if (fullName) criteria.push(`Full Name: "${fullName}"`);
    if (accountNumber) criteria.push(`Account / Property ID: "${accountNumber}"`);

    const nameForSearch =
      fullName ||
      (lastName && firstName ? `${lastName} ${firstName}` : lastName || firstName || '');

    const searchMode = accountNumber ? 'property_id' : 'name';

    // -----------------------------------------------------------------------
    // PLATFORM ROUTING: route to a dedicated handler before falling back to
    // the generic AI loop. Handlers return null to signal fallback needed.
    // -----------------------------------------------------------------------
    let platform = detectFromUrl(url);

    // If URL alone wasn't enough, fingerprint the live page HTML.
    // This catches counties whose URLs don't match any known pattern but whose
    // page source reveals the underlying platform (qPublic, Tyler, Beacon, etc.)
    if (platform === 'generic') {
      try {
        const html = await page.content();
        const htmlPlatform = detectFromHtml(html);
        if (htmlPlatform !== 'generic') {
          platform = htmlPlatform;
          onProgress(`Detected ${platformLabel(htmlPlatform)} platform via page fingerprint — using dedicated handler...`);
        }
      } catch (_) {}
    }

    console.log(`[agent] platform=${platform}`);

    if (platform === 'qpublic') {
      onProgress('Detected qPublic platform — using dedicated handler...');
      try {
        const handlerResult = await qpublicHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('qPublic handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] qPublic handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('qPublic handler error — falling back to AI agent...');
      }
    }

    if (platform === 'tyler') {
      onProgress('Detected Tyler iasWorld platform — using dedicated handler...');
      try {
        const handlerResult = await tylerHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('Tyler handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] Tyler handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('Tyler handler error — falling back to AI agent...');
      }
    }

    if (platform === 'beacon') {
      onProgress('Detected Beacon/Schneider platform — using dedicated handler...');
      try {
        const handlerResult = await beaconHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('Beacon handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] Beacon handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('Beacon handler error — falling back to AI agent...');
      }
    }

    if (platform === 'patriot') {
      onProgress('Detected Patriot Properties platform — using dedicated handler...');
      try {
        const handlerResult = await patriotHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('Patriot handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] Patriot handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('Patriot handler error — falling back to AI agent...');
      }
    }

    if (platform === 'vision') {
      onProgress('Detected Vision Government Solutions platform — using dedicated handler...');
      try {
        const handlerResult = await visionHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('Vision handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] Vision handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('Vision handler error — falling back to AI agent...');
      }
    }

    if (platform === 'bis') {
      onProgress('Detected BIS Consultants platform — using dedicated handler...');
      try {
        const handlerResult = await bisHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('BIS handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] BIS handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('BIS handler error — falling back to AI agent...');
      }
    }

    if (platform === 'publicportal') {
      onProgress('Detected Public Portal (Aumentum) platform — using dedicated handler...');
      try {
        const handlerResult = await publicPortalHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('Public Portal handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] Public Portal handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('Public Portal handler error — falling back to AI agent...');
      }
    }

    if (platform === 'actweb') {
      onProgress('Detected ACTweb tax portal — using dedicated handler...');
      try {
        const handlerResult = await actwebHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('ACTweb handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] ACTweb handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('ACTweb handler error — falling back to AI agent...');
      }
    }

    if (platform === 'txcountytax') {
      onProgress('Detected TX County Tax Office (Kendo) — using dedicated handler...');
      try {
        const handlerResult = await andersonTaxHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('TX County Tax handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] TX County Tax handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('TX County Tax handler error — falling back to AI agent...');
      }
    }

    if (platform === 'ptaxpro') {
      onProgress('Detected PTaxPro/whoownsit.com template — using dedicated handler...');
      try {
        const handlerResult = await ptaxproHandler.search(page, {
          accountNumber, firstName, lastName, fullName, onProgress,
        });
        if (handlerResult) return handlerResult;
        onProgress('PTaxPro handler fell back — continuing with AI agent...');
      } catch (handlerErr) {
        console.log(`[agent] PTaxPro handler error: ${handlerErr.message} — continuing with AI`);
        onProgress('PTaxPro handler error — falling back to AI agent...');
      }
    }

    // -----------------------------------------------------------------------
    // PROPERTY ID: use Playwright directly to navigate the search form.
    // Direct URL approaches fail on sites that require a session token
    // (e.g. Andrews CAD redirects to /Search/Expired without one).
    // Submitting the actual form generates a valid session automatically.
    // -----------------------------------------------------------------------
    if (searchMode === 'property_id') {
      onProgress('Searching by Property ID via form...');
      let formNavigated = false;

      try {
        // Try clicking a "By ID" / "Property ID" / "Account" tab if one exists
        const idTabSelectors = [
          'a:has-text("By ID")', 'button:has-text("By ID")',
          'a:has-text("Property ID")', 'button:has-text("Property ID")',
          'a:has-text("By Account")', 'button:has-text("By Account")',
          'a:has-text("Account")', 'button:has-text("Account")',
          'a:has-text("Parcel")', 'button:has-text("Parcel")',
        ];
        for (const sel of idTabSelectors) {
          try {
            const tab = page.locator(sel).first();
            if (await tab.count() > 0) {
              await tab.click({ timeout: 5000 });
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
              console.log(`[agent] Clicked tab: ${sel}`);
              break;
            }
          } catch (_) {}
        }

        // Find the Property ID / Account Number input field
        const inputSelectors = [
          'input[name*="PropertyId"]', 'input[id*="PropertyId"]',
          'input[name*="propertyId"]', 'input[id*="propertyId"]',
          'input[name*="AccountNumber"]', 'input[id*="AccountNumber"]',
          'input[name*="accountNumber"]', 'input[id*="accountNumber"]',
          'input[placeholder*="Property ID" i]',
          'input[placeholder*="Account" i]',
          'input[placeholder*="Parcel" i]',
        ];
        let filled = false;
        for (const sel of inputSelectors) {
          try {
            const input = page.locator(sel).first();
            if (await input.count() > 0) {
              await input.clear();
              await input.fill(accountNumber, { timeout: 5000 });
              console.log(`[agent] Filled input: ${sel} = ${accountNumber}`);
              filled = true;
              break;
            }
          } catch (_) {}
        }

        if (!filled) {
          // Last resort: fill the first visible text/number input on the page
          const anyInput = page.locator('input[type="text"], input[type="number"], input:not([type])').first();
          if (await anyInput.count() > 0) {
            await anyInput.clear();
            await anyInput.fill(accountNumber, { timeout: 5000 });
            console.log(`[agent] Filled fallback input with ${accountNumber}`);
            filled = true;
          }
        }

        if (filled) {
          // Submit the form
          const submitSelectors = [
            'button:has-text("Search")', 'input[type="submit"]',
            'button[type="submit"]', 'a:has-text("Search")',
          ];
          for (const sel of submitSelectors) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.count() > 0) {
                await btn.click({ timeout: 5000 });
                await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
                console.log(`[agent] Clicked submit: ${sel}`);
                formNavigated = true;
                break;
              }
            } catch (_) {}
          }
          if (!formNavigated) {
            // Try pressing Enter as fallback
            await page.keyboard.press('Enter');
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            formNavigated = true;
          }
        }

        console.log(`[agent] After form nav, URL: ${page.url()}`);
        onProgress(`Loaded: ${page.url()}`);

        // Wait for the results table to finish rendering (some sites use JS/AJAX)
        try {
          await page.waitForSelector('table tbody tr, table tr:nth-child(2)', { timeout: 12000 });
          console.log('[agent] Results table detected in DOM');
        } catch (_) {
          console.log('[agent] No table detected — waiting 3s for JS rendering');
          await page.waitForTimeout(3000);
        }

        // Log actual page text so we can see what the browser shows
        const pageBodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
        console.log(`[agent] Page body text:\n${pageBodyText}\n---`);

        // ── Step 1: Extract summary rows from results table ─────────────────
        const summaryExtract = await page.evaluate(() => {
          const allRows = Array.from(document.querySelectorAll('table tr'));
          if (allRows.length < 2) return null;
          const headers = Array.from(allRows[0].querySelectorAll('th, td')).map(el => el.innerText.trim());
          const dataRows = allRows.slice(1)
            .map(row => ({
              cells: Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()),
              // Capture first link href in the row (usually the property detail link)
              href: row.querySelector('a')?.getAttribute('href') || null,
            }))
            .filter(r => r.cells.some(c => c.length > 0));
          if (dataRows.length === 0) return null;
          return { headers, rows: dataRows };
        });

        console.log('[agent] summaryExtract:', JSON.stringify(summaryExtract || null).substring(0, 600));

        if (summaryExtract && summaryExtract.rows.length > 0) {
          const { headers, rows } = summaryExtract;
          const baseUrl = url.replace(/\/$/, '');
          const records = [];

          for (const { cells, href } of rows) {
            const obj = {};
            headers.forEach((h, i) => { if (h) obj[h] = cells[i] || ''; });

            const propId   = obj['Property ID'] || obj['PropertyID'] || cells[0] || '';
            const ownerId  = obj['Owner ID']    || obj['OwnerID']    || cells[4] || '';
            const summaryRecord = {
              ownerName:        obj['Owner Name']        || obj['OwnerName'] || cells[3] || '',
              parcelId:         propId,
              propertyAddress:  obj['Situs Address']     || obj['Address']   || cells[5] || '',
              legalDescription: obj['Legal Description'] || obj['Legal Desc']|| cells[6] || '',
              taxAmountDue:     obj['Appraised']         || obj['Tax Amount Due'] || '',
              county: '', state: '',
            };

            // ── Step 2: Navigate to the property detail page ─────────────
            let detailFields = {};
            try {
              // Build detail URL — try clicked href first, then common patterns
              let detailUrl = href
                ? (href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`)
                : `${baseUrl}/Property/View/${propId}${ownerId ? `?year=2025&ownerId=${ownerId}` : ''}`;

              onProgress(`Loading detail page for Property ID ${propId}...`);
              console.log(`[agent] Detail URL: ${detailUrl}`);
              await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });

              // Wait for detail content to load
              await page.waitForSelector('table, .property-details, h1, h2', { timeout: 10000 }).catch(() => {});

              // ── Step 3: Extract all labeled fields from the detail page ──
              detailFields = await page.evaluate(() => {
                const data = {};

                // Pattern A: <tr><th>Label</th><td>Value</td></tr>  (most CAD sites)
                document.querySelectorAll('tr').forEach(row => {
                  const ths = row.querySelectorAll('th');
                  const tds = row.querySelectorAll('td');
                  // Row has alternating label/value cells
                  const allCells = Array.from(row.querySelectorAll('th, td'));
                  for (let i = 0; i < allCells.length - 1; i++) {
                    const label = allCells[i].innerText.trim().replace(/:$/, '');
                    const value = allCells[i + 1]?.innerText.trim() || '';
                    if (label && value && !label.match(/^\s*$/) && label.length < 60) {
                      data[label] = value;
                    }
                  }
                });

                // Pattern B: <dt>Label</dt><dd>Value</dd>
                const dts = Array.from(document.querySelectorAll('dt'));
                dts.forEach(dt => {
                  const dd = dt.nextElementSibling;
                  if (dd && dd.tagName === 'DD') {
                    const label = dt.innerText.trim().replace(/:$/, '');
                    if (label) data[label] = dd.innerText.trim();
                  }
                });

                // Pattern C: elements with data-label / aria-label attributes
                document.querySelectorAll('[data-label]').forEach(el => {
                  data[el.getAttribute('data-label')] = el.innerText.trim();
                });

                return data;
              });

              console.log(`[agent] Detail fields (${Object.keys(detailFields).length}):`, JSON.stringify(detailFields).substring(0, 800));
              onProgress(`Extracted ${Object.keys(detailFields).length} detail fields for Property ID ${propId}.`);
            } catch (detailErr) {
              console.log(`[agent] Detail page error for ${propId}: ${detailErr.message}`);
            }

            // Merge summary + detail into one rich record
            records.push({
              ...summaryRecord,
              // Override/enrich with detail page values where available
              ownerName:        detailFields['Owner Name']        || detailFields['Owner']           || summaryRecord.ownerName,
              propertyAddress:  detailFields['Situs Address']     || detailFields['Address']         || summaryRecord.propertyAddress,
              legalDescription: detailFields['Legal Description'] || detailFields['Legal Desc']      || summaryRecord.legalDescription,
              taxAmountDue:     detailFields['Market Value']      || detailFields['Assessed Value']  || detailFields['Appraised']     || summaryRecord.taxAmountDue,
              // All raw detail fields for display
              additionalDetails: JSON.stringify({ ...obj, ...detailFields }),
            });
          }

          Object.assign(page, { _directResults: {
            records,
            totalFound: records.length,
            summary: `Found ${records.length} record(s) for Property ID ${accountNumber} with full property details.`,
            searchedUrl: page.url(),
          }});

          console.log(`[agent] Full extraction complete — ${records.length} record(s)`);
          onProgress(`Extraction complete — ${records.length} record(s) with full details.`);
        }
        // ────────────────────────────────────────────────────────────────────
      } catch (formErr) {
        console.log(`[agent] Form navigation error: ${formErr.message}`);
      }

      if (!formNavigated) {
        console.log('[agent] Form navigation failed — AI will attempt navigation');
      }

      // If direct extraction succeeded, return immediately — skip AI loop
      if (page._directResults) {
        return page._directResults;
      }
    }

    // System prompt with explicit numbered tool-call sequence
    const systemPrompt = searchMode === 'property_id'
      ? `You are a property data extraction agent for US county tax/appraisal websites.
The browser is already on the county website. Search for Property ID: ${accountNumber}.

STEP 1: Call take_screenshot — inspect the page visually.
STEP 2: Call get_page_content — read inputs, buttons, page text.
STEP 3: Handle disclaimers — if you see an "Accept", "I Agree", or "Continue" button, click it first.
STEP 4: Find the search form. Look for tabs like "By ID", "Account", "Parcel", "Property ID" and click one if visible.
STEP 5: Fill the account/parcel/property ID field with: ${accountNumber}
STEP 6: Submit by clicking Search or pressing Enter.
STEP 7: Call wait.
STEP 8: Call take_screenshot — see results.
STEP 9: Call get_page_content — read the results table.
STEP 10: If a results row is shown, click into the property detail page to get full data.
STEP 11: Call extract_results with: ownerName, propertyAddress, parcelId, taxYear, taxAmountDue, paymentStatus, legalDescription, county, state, additionalDetails (include assessed value, market value, exemptions, due dates, account number).

RULES:
- If you see a CAPTCHA or "blocked" page, call extract_results with records=[] and explain in summary.
- Never navigate to a different domain.
- If the site asks for a different ID format (e.g. "R60110" vs "60110"), try both.
- If the page shows no results, retry once with a trimmed or reformatted ID.
- After 2 failed attempts call extract_results with records=[] and explain in summary.`

      : `You are a browser automation agent searching a US county property tax or appraisal website by owner name.
You can handle any county in any of the 50 US states.

Execute these steps IN ORDER:

STEP 1: Call take_screenshot.
STEP 2: Call get_page_content — read available tabs, inputs, and buttons.
STEP 3: Handle disclaimers — if you see "Accept", "I Agree", "Agree", or "Continue" button, click it.
STEP 4: Find and click the owner name search tab.
  - Look for text: "By Owner", "Owner Name", "Owner", "Name Search", "Search by Name".
STEP 5: Fill the name fields:
  - Separate last/first inputs: lastName="${lastName || ''}", firstName="${firstName || ''}".
  - Single name field or keyword box: type "${nameForSearch}".
  - If there is a year/tax year field, set it to the current year (2025).
STEP 6: Submit — click Search, Find, or press Enter.
STEP 7: Call wait.
STEP 8: Call take_screenshot — see the results.
STEP 9: Call get_page_content — read the results.
STEP 10: For each result row visible, extract: ownerName, propertyAddress, parcelId, taxAmountDue, paymentStatus, county, state, legalDescription, assessed value, market value, exemptions.
STEP 11: If pagination exists and there are more pages, note the total count in summary.
STEP 12: Call extract_results with ALL records found (up to 20).

RULES:
- Never navigate to a different domain.
- If results show "no records found", retry with last name only: "${lastName || nameForSearch}".
- If the site is blocked by CAPTCHA or login wall, call extract_results with records=[] and describe the blocker in summary.
- After 2 failed search attempts call extract_results with records=[] and explain why.
- Extract as much data per record as possible: address, parcel ID, assessed value, tax amount, payment status, legal description.`;

    const userMessage = searchMode === 'property_id'
      ? `Search the county property tax website for Property ID: ${accountNumber}

County URL: ${url}

Follow your step-by-step instructions exactly. The property ID to search is: ${accountNumber}`
      : `Search the county property tax website for owner: ${nameForSearch}

County URL: ${url}

Search criteria: ${criteria.join(', ')}`;

    // OpenAI messages array.
    // System prompt goes as the first message with role "system".
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    console.log(`[agent] mode=${searchMode} accountNumber="${accountNumber}" url=${url}`);

    let finalResults = null;
    const MAX_ITERATIONS = 18;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      onProgress(`AI agent working... (step ${iteration}/${MAX_ITERATIONS})`);
      console.log(`[agent] iteration ${iteration}`);

      // Force tool use for the first 6 iterations so the model can't skip navigation
      // by returning a plain-text "I couldn't find it" answer.
      const toolChoice = iteration <= 6 ? 'required' : 'auto';

      // Call the model; if the API rejects an image payload, strip images and retry once.
      let response;
      try {
        response = await client.chat.completions.create({
          model: MODEL,
          max_tokens: 4096,
          messages,
          tools: AGENT_TOOLS,
          tool_choice: toolChoice,
        });
      } catch (apiErr) {
        const msg = apiErr?.message || '';
        if (msg.includes('invalid base64') || msg.includes('image')) {
          onProgress('Vision rejected by API — retrying without images...');
          const textOnlyMessages = messages.map((m) => {
            if (!Array.isArray(m.content)) return m;
            const textParts = m.content.filter((c) => c.type !== 'image_url');
            return { ...m, content: textParts.length ? textParts : 'Screenshot taken — use get_page_content to read the page.' };
          });
          response = await client.chat.completions.create({
            model: MODEL,
            max_tokens: 4096,
            messages: textOnlyMessages,
            tools: AGENT_TOOLS,
            tool_choice: toolChoice,
          });
        } else {
          throw apiErr;
        }
      }

      const assistantMessage = response.choices[0].message;
      // Push the assistant message as-is (includes tool_calls if present)
      messages.push(assistantMessage);

      // Log any text the model produced
      if (assistantMessage.content && assistantMessage.content.trim()) {
        const text = assistantMessage.content.trim();
        onProgress(`Agent: ${text.substring(0, 200)}`);
        console.log(`[agent]   model text: ${text.substring(0, 300)}`);
      }

      const finishReason = response.choices[0].finish_reason;
      console.log(`[agent]   finish_reason=${finishReason}`);

      // Only allow a clean stop if extract_results was already called.
      // Otherwise the model gave a text answer without navigating — keep going.
      if (finishReason === 'stop') {
        if (finalResults) {
          onProgress('Agent finished.');
          break;
        }
        // Model tried to answer without using tools — nudge it to continue
        onProgress('Agent responded without tools — nudging to continue...');
        messages.push({
          role: 'user',
          content: 'You have not called extract_results yet. Please continue executing the steps: take_screenshot, get_page_content, navigate the site, and call extract_results when done.',
        });
        continue;
      }

      if (finishReason !== 'tool_calls') {
        console.log(`[agent]   unexpected finish_reason=${finishReason}, stopping`);
        break;
      }

      // -----------------------------------------------------------------------
      // Process tool calls
      // OpenAI returns tool_calls array in the assistant message.
      // Screenshots cannot be returned inline in a "tool" role message, so we
      // collect them and inject them as a follow-up "user" role message with
      // image_url content — which the vision model can see.
      // -----------------------------------------------------------------------
      const toolCalls = assistantMessage.tool_calls || [];
      const toolMessages = [];      // {role:"tool"} responses
      const pendingScreenshots = []; // { data, mimeType } to attach after tool results
      let done = false;

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        let input = {};
        try {
          input = JSON.parse(toolCall.function.arguments || '{}');
        } catch (_) {
          // leave input as {}
        }

        onProgress(`Running: ${toolName}...`);
        console.log(`[agent]   tool=${toolName} input=${JSON.stringify(input).substring(0, 120)}`);

        if (toolName === 'extract_results') {
          finalResults = { ...input, searchedUrl: page.url() };
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Results extracted successfully. Task complete.',
          });
          done = true;
          break;
        }

        const result = await executeTool(page, toolName, input);

        // After navigate or page-read, check for CAPTCHA before the AI wastes more turns.
        if (toolName === 'navigate' || toolName === 'get_page_content') {
          const captcha = await detectCaptcha(page);
          if (captcha.detected) {
            onProgress(`CAPTCHA detected (${captcha.type}) — search cannot continue automatically.`);
            console.log(`[agent] CAPTCHA detected (${captcha.type}) at ${page.url()} — aborting AI loop`);
            finalResults = { ...captcha, searchedUrl: page.url() };
            done = true;
            break;
          }
        }

        if (typeof result === 'string') console.log(`[agent]   result="${result.substring(0, 150)}"`);
        else if (result && result._type !== 'image') console.log(`[agent]   result=${JSON.stringify(result).substring(0, 150)}`);

        if (result && result._type === 'image') {
          // Screenshot: collect for vision injection; confirm via tool message
          pendingScreenshots.push({ data: result.data, mimeType: result.mimeType });
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Screenshot captured. See the image in the next message for visual analysis.',
          });
        } else {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        }
      }

      // Add tool-result messages first
      messages.push(...toolMessages);

      // Then inject screenshots as a user message so the vision model can see them.
      // This follows the OpenAI multi-modal pattern: image_url inside a user message.
      if (pendingScreenshots.length > 0) {
        const imageContent = pendingScreenshots.map(({ data, mimeType }) => ({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${data}` },
        }));
        messages.push({
          role: 'user',
          content: [
            ...imageContent,
            {
              type: 'text',
              text: 'Above is the current browser page screenshot. Analyze it and decide your next action.',
            },
          ],
        });
      }

      if (done) break;
    }

    onProgress('Search complete.');

    if (finalResults) return finalResults;

    // Agent exhausted iterations without calling extract_results.
    // Grab the raw page text so the user still sees whatever the county site returned.
    onProgress('Capturing raw page content as fallback...');
    let rawText = '';
    try {
      rawText = await page.evaluate(() => document.body.innerText.trim());
    } catch (_) {}

    return {
      records: [],
      totalFound: 0,
      summary: 'Structured extraction incomplete — raw page content shown below.',
      rawText: rawText.substring(0, 15000),
      searchedUrl: page.url(),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runBrowserAgent };
