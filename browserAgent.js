'use strict';

/**
 * AI Browser Agent
 * Uses Playwright for browser automation and Ollama (llama3.1) to intelligently
 * navigate county property tax websites, fill search forms, and extract results.
 */

const { chromium } = require('playwright');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const LLM_MODEL       = process.env.LLM_MODEL       || 'llama3.1';

// ---------------------------------------------------------------------------
// Ollama API call (5-minute timeout per call)
// ---------------------------------------------------------------------------

async function callOllama(messages, tools) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        tools,
        stream: false,
        options: { num_ctx: 8192 },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI / Ollama function-calling format)
// ---------------------------------------------------------------------------

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        'Capture the current state of the browser page. Confirms the page is loaded. Follow up with get_page_content to read form fields and buttons.',
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
            description: 'CSS selector for the input (e.g. "#ownerName", "input[name=\'search\']", ".search-input")',
          },
          value: { type: 'string', description: 'The text value to enter into the field' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click on a page element such as a button, link, or tab. Waits for the page to settle after clicking.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click' },
          text: {
            type: 'string',
            description: 'Visible text of the element to click (used when selector is unknown). E.g. "Search", "Submit"',
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
      description: 'Press a keyboard key. Common uses: "Enter" to submit a form, "Tab" to move focus.',
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
                ownerName:         { type: 'string', description: 'Full name of the property owner/taxpayer' },
                propertyAddress:   { type: 'string', description: 'Full property/mailing address' },
                parcelId:          { type: 'string', description: 'Parcel ID, account number, or property ID' },
                taxYear:           { type: 'string', description: 'Tax year (e.g. "2025")' },
                taxAmountDue:      { type: 'string', description: 'Total tax amount due (e.g. "$1,234.56")' },
                paymentStatus:     { type: 'string', description: 'Payment status: Paid, Unpaid, Partial, Delinquent, etc.' },
                county:            { type: 'string', description: 'County name' },
                state:             { type: 'string', description: 'State abbreviation (e.g. "TX")' },
                legalDescription:  { type: 'string', description: 'Legal description of the property' },
                additionalDetails: { type: 'object', description: 'Any other relevant details' },
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
// Tool executor (Playwright actions)
// ---------------------------------------------------------------------------

async function executeTool(page, toolName, input) {
  switch (toolName) {
    case 'take_screenshot': {
      // Take screenshot for server-side debugging; return text to LLM (llama3.1 is not a vision model)
      await page.screenshot({ encoding: 'base64', fullPage: false }).catch(() => {});
      return {
        success: true,
        message: 'Screenshot captured. The page is loaded in the browser. Use get_page_content to read the form fields, buttons, and visible text.',
      };
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
        await page.fill(input.selector, input.value, { timeout: 30000 });
        return { success: true, message: `Filled "${input.value}" into ${input.selector}` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'click_element': {
      try {
        if (input.selector) {
          await page.click(input.selector, { timeout: 30000 });
        } else if (input.text) {
          await page.getByText(input.text, { exact: false }).first().click({ timeout: 30000 });
        } else {
          return { success: false, message: 'Provide either selector or text' };
        }
        await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
        return { success: true, message: 'Clicked and page settled' };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'select_option': {
      try {
        await page
          .selectOption(input.selector, { label: input.value }, { timeout: 30000 })
          .catch(async () => {
            await page.selectOption(input.selector, { value: input.value }, { timeout: 30000 });
          });
        return { success: true, message: `Selected "${input.value}"` };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'press_key': {
      await page.keyboard.press(input.key);
      await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
      return { success: true, message: `Pressed ${input.key}` };
    }

    case 'wait': {
      await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
      if (input.milliseconds > 0) await page.waitForTimeout(input.milliseconds);
      return { success: true, message: 'Page settled' };
    }

    case 'navigate': {
      await page.goto(input.url, { waitUntil: 'networkidle', timeout: 90000 });
      return { success: true, message: `Navigated to ${input.url}` };
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
 * @param {string} params.url            - County search website URL
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

  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(90000);

  const page = await context.newPage();

  try {
    onProgress(`Launching browser with ${LLM_MODEL} via Ollama...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });

    // Build search criteria list
    const criteria = [];
    if (firstName)     criteria.push(`First Name: "${firstName}"`);
    if (lastName)      criteria.push(`Last Name: "${lastName}"`);
    if (fullName)      criteria.push(`Full Name: "${fullName}"`);
    if (accountNumber) criteria.push(`Account / Property ID: "${accountNumber}"`);

    const nameForSearch =
      fullName || (lastName && firstName ? `${lastName} ${firstName}` : lastName || firstName || '');

    const systemPrompt = `You are an expert AI agent that navigates US county property tax and title search websites using browser automation tools.

Your goal: Search for property and tax records using the criteria provided, then return ALL found records via the extract_results tool.

## Step-by-step process
1. Call get_page_content to understand the form fields and buttons available.
2. Fill in the search form using the criteria provided:
   - Owner name fields: try "LASTNAME FIRSTNAME" or "FIRSTNAME LASTNAME"
   - For a single keyword/general search box, use just: SMITH JOHN or just the last name
   - If there is a year/tax year field, use 2025 or 2026
   - Account/parcel ID fields: enter the account number directly
3. Submit the form (click Search button or press Enter).
4. Call wait to let results load.
5. Call get_page_content to read the results text.
6. Extract ALL records using extract_results.

## Key rules
- Always start with get_page_content.
- If a search attempt returns no results, try an alternative format (e.g., swap first/last name order, try just the last name).
- Collect these fields for each record: ownerName, propertyAddress, parcelId, taxYear, taxAmountDue, paymentStatus, county, state, legalDescription, additionalDetails.
- Do NOT loop forever — after 3 failed search attempts call extract_results with empty records and explain in the summary.
- Always call extract_results when done, even if no records were found.`;

    const userMessage = `Please search the county property tax website for the following:

County URL: ${url}

Search Criteria:
${criteria.length > 0 ? criteria.join('\n') : 'No specific criteria provided'}
${nameForSearch ? `\nName string to use in search: "${nameForSearch}"` : ''}

Start by calling get_page_content to see the page structure, then proceed with the search. Return all found property/tax records.`;

    // Messages array — system + user to start
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ];

    let finalResults = null;
    const MAX_ITERATIONS = 18;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      onProgress(`AI agent working... (step ${iteration}/${MAX_ITERATIONS})`);

      const response = await callOllama(messages, AGENT_TOOLS);
      const assistantMsg = response.message; // { role, content, tool_calls? }

      // Add assistant turn to history
      messages.push(assistantMsg);

      // Log any text the model produced
      if (assistantMsg.content && assistantMsg.content.trim()) {
        onProgress(`Agent: ${assistantMsg.content.trim().substring(0, 200)}`);
      }

      // No tool calls — model finished without calling extract_results
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        onProgress('Agent finished reasoning.');
        break;
      }

      // Execute each tool call
      let done = false;

      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function.name;

        // arguments may be an object or a JSON string depending on Ollama version
        let toolInput = toolCall.function.arguments || {};
        if (typeof toolInput === 'string') {
          try { toolInput = JSON.parse(toolInput); } catch (_) { toolInput = {}; }
        }

        onProgress(`Running: ${toolName}...`);

        if (toolName === 'extract_results') {
          finalResults = { ...toolInput, searchedUrl: page.url() };
          messages.push({ role: 'tool', content: 'Results extracted successfully. Task complete.' });
          done = true;
          break;
        }

        const result = await executeTool(page, toolName, toolInput);
        messages.push({
          role: 'tool',
          content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        });
      }

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
