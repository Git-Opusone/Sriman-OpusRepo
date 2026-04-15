'use strict';

/**
 * AI Browser Agent
 * Uses Playwright for browser automation and Claude claude-opus-4-6 (vision) to intelligently
 * navigate county property tax websites, fill search forms, and extract results.
 */

const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Tool definitions for the AI agent
// ---------------------------------------------------------------------------

const AGENT_TOOLS = [
  {
    name: 'take_screenshot',
    description:
      'Capture a screenshot of the current browser page. Use this to visually inspect the page layout, find form fields, and verify results.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_page_content',
    description:
      'Get the current page URL, title, visible text content, all input fields, and all clickable buttons/links. Use this to understand page structure and available form fields.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fill_input',
    description: 'Fill a form input field with a value. Clears the field first before typing.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS selector for the input (e.g. "#ownerName", "input[name=\'search\']", ".search-input")',
        },
        value: {
          type: 'string',
          description: 'The text value to enter into the field',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'click_element',
    description:
      'Click on a page element such as a button, link, or tab. Waits for the page to settle after clicking.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element to click',
        },
        text: {
          type: 'string',
          description:
            'Visible text of the element to click (used when selector is unknown). E.g. "Search", "Submit"',
        },
      },
    },
  },
  {
    name: 'select_option',
    description: 'Select a value from a <select> dropdown element.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the <select> element' },
        value: { type: 'string', description: 'The option value or visible text to select' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key. Common uses: "Enter" to submit a form, "Tab" to move focus.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name: "Enter", "Tab", "Escape", etc.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for the page to finish loading, or add extra delay for slow pages.',
    input_schema: {
      type: 'object',
      properties: {
        milliseconds: {
          type: 'number',
          description: 'Extra milliseconds to wait after network is idle (default 0)',
        },
      },
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the browser to a different URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'extract_results',
    description:
      'Call this ONLY when you have successfully found and read all property/tax records. This finalizes the agent run and returns the structured results.',
    input_schema: {
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
];

// Mark the last tool for prompt caching (tools list is static)
const CACHED_TOOLS = AGENT_TOOLS.map((tool, i) =>
  i === AGENT_TOOLS.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
);

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(page, toolName, input) {
  switch (toolName) {
    case 'take_screenshot': {
      const data = await page.screenshot({ encoding: 'base64', fullPage: false });
      return { _type: 'image', data, mimeType: 'image/png' };
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
        await page.fill(input.selector, input.value, { timeout: 5000 });
        return { success: true, message: `Filled "${input.value}" into ${input.selector}` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'click_element': {
      try {
        if (input.selector) {
          await page.click(input.selector, { timeout: 5000 });
        } else if (input.text) {
          await page
            .getByText(input.text, { exact: false })
            .first()
            .click({ timeout: 5000 });
        } else {
          return { success: false, message: 'Provide either selector or text' };
        }
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        return { success: true, message: 'Clicked and page settled' };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'select_option': {
      try {
        await page.selectOption(input.selector, { label: input.value }, { timeout: 5000 }).catch(async () => {
          await page.selectOption(input.selector, { value: input.value }, { timeout: 5000 });
        });
        return { success: true, message: `Selected "${input.value}"` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'press_key': {
      await page.keyboard.press(input.key);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return { success: true, message: `Pressed ${input.key}` };
    }

    case 'wait': {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (input.milliseconds > 0) {
        await page.waitForTimeout(input.milliseconds);
      }
      return { success: true, message: 'Page settled' };
    }

    case 'navigate': {
      await page.goto(input.url, { waitUntil: 'networkidle', timeout: 30000 });
      return { success: true, message: `Navigated to ${input.url}` };
    }

    case 'extract_results':
      return { success: true, message: 'Results captured' };

    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Build tool-result message content (handles image vs text)
// ---------------------------------------------------------------------------

function buildToolResult(toolUseId, result) {
  if (result && result._type === 'image') {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: result.mimeType, data: result.data },
        },
        { type: 'text', text: 'Screenshot captured. Analyze the page and decide next action.' },
      ],
    };
  }

  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  };
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
async function runBrowserAgent({ url, firstName, lastName, fullName, accountNumber, onProgress = () => {} }) {
  const headless = process.env.BROWSER_HEADLESS !== 'false';

  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    onProgress('Launching browser and navigating to county website...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Build search criteria list
    const criteria = [];
    if (firstName) criteria.push(`First Name: "${firstName}"`);
    if (lastName) criteria.push(`Last Name: "${lastName}"`);
    if (fullName) criteria.push(`Full Name: "${fullName}"`);
    if (accountNumber) criteria.push(`Account / Property ID: "${accountNumber}"`);

    // Construct the name string that will most likely appear on county sites
    const nameForSearch =
      fullName ||
      (lastName && firstName ? `${lastName} ${firstName}` : lastName || firstName || '');

    // System prompt (cached — static for all iterations)
    const systemContent = [
      {
        type: 'text',
        text: `You are an expert AI agent that navigates US county property tax and title search websites using browser automation tools.

Your goal: Search for property and tax records using the criteria provided, then return ALL found records via the extract_results tool.

## Step-by-step process
1. Take a screenshot to see the current page.
2. Call get_page_content to understand the form fields and buttons available.
3. Fill in the search form using the criteria provided:
   - Owner name fields: try "LASTNAME FIRSTNAME" or "FIRSTNAME LASTNAME"
   - For a single keyword/general search box, use format like: OwnerName:"SMITH JOHN" or just SMITH JOHN
   - If there's a year/tax year field, use 2025 or 2026
   - Account/parcel ID fields: enter the account number directly
4. Submit the form (click Search button or press Enter).
5. Wait for results to load.
6. Take a screenshot of the results page.
7. Call get_page_content to read the results text.
8. Extract ALL records using extract_results.

## Key rules
- Always start with take_screenshot.
- If a search attempt returns no results, try an alternative format (e.g., swap first/last name order, try just the last name).
- If the page has a keyword search box, try syntax like: OwnerName:"SMITH JOHN" Year:2025
- Collect these fields for each record: ownerName, propertyAddress, parcelId, taxYear, taxAmountDue, paymentStatus, county, state, legalDescription, additionalDetails.
- Do NOT loop forever — after 3 failed search attempts call extract_results with empty records and explain in the summary.`,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const userMessage = `Please search the county property tax website for the following:

County URL: ${url}

Search Criteria:
${criteria.length > 0 ? criteria.join('\n') : 'No specific criteria provided'}
${nameForSearch ? `\nName string to use in search: "${nameForSearch}"` : ''}

Start by taking a screenshot to see the page, then proceed with the search. Return all found property/tax records.`;

    const messages = [{ role: 'user', content: userMessage }];

    let finalResults = null;
    const MAX_ITERATIONS = 18;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      onProgress(`AI agent working... (step ${iteration}/${MAX_ITERATIONS})`);

      const response = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        system: systemContent,
        tools: CACHED_TOOLS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      // Log any text blocks from the model
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          onProgress(`Agent: ${block.text.trim().substring(0, 200)}`);
        }
      }

      if (response.stop_reason === 'end_turn') {
        onProgress('Agent finished reasoning.');
        break;
      }

      if (response.stop_reason !== 'tool_use') {
        break;
      }

      // Process tool calls
      const toolResults = [];
      let done = false;

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        onProgress(`Running: ${block.name}...`);

        if (block.name === 'extract_results') {
          finalResults = {
            ...block.input,
            searchedUrl: page.url(),
          };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Results extracted successfully. Task complete.',
          });
          done = true;
          break;
        }

        const result = await executeTool(page, block.name, block.input);
        toolResults.push(buildToolResult(block.id, result));
      }

      messages.push({ role: 'user', content: toolResults });

      if (done) break;
    }

    onProgress('Search complete.');

    return (
      finalResults || {
        records: [],
        totalFound: 0,
        summary: 'The agent was unable to extract structured results. The county website may have an unsupported layout.',
        searchedUrl: page.url(),
      }
    );
  } finally {
    await browser.close();
  }
}

module.exports = { runBrowserAgent };
