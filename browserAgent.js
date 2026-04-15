'use strict';

/**
 * AI Browser Agent — OpenAI-compatible LLM backend
 *
 * Supports any OpenAI-compatible provider out of the box:
 *   • Ollama   (local, free)  – default
 *   • Groq     (cloud, free tier)
 *   • Together AI (cloud, cheap)
 *   • OpenRouter (cloud, multi-model)
 *
 * Required env vars:
 *   LLM_PROVIDER  = ollama | groq | together | openrouter  (default: ollama)
 *   LLM_API_KEY   = your API key  (use any string for Ollama)
 *   LLM_MODEL     = model name    (default: llama3.2-vision)
 *   LLM_BASE_URL  = override base URL if needed
 *
 * Recommended models (vision + tool calling required):
 *   Ollama  : llama3.2-vision
 *   Groq    : llama-3.2-11b-vision-preview
 *   Together: meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo
 */

const { chromium } = require('playwright');
const { OpenAI } = require('openai');

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

const PROVIDER_BASE_URLS = {
  ollama:     'http://localhost:11434/v1',
  groq:       'https://api.groq.com/openai/v1',
  together:   'https://api.together.xyz/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
const LLM_API_KEY  = process.env.LLM_API_KEY  || 'ollama';        // any string works for Ollama
const LLM_MODEL    = process.env.LLM_MODEL    || 'llama3.2-vision';
const LLM_BASE_URL = process.env.LLM_BASE_URL || PROVIDER_BASE_URLS[LLM_PROVIDER] || PROVIDER_BASE_URLS.ollama;

const client = new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL });

// ---------------------------------------------------------------------------
// Tool definitions — OpenAI / JSON Schema format
// ---------------------------------------------------------------------------

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        'Capture a screenshot of the current browser page. Use this to visually inspect the page layout, find form fields, and verify results.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_content',
      description:
        'Get the current page URL, title, visible text content, all input fields, and all clickable buttons/links. Use this to understand page structure and available form fields.',
      parameters: { type: 'object', properties: {} },
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
            description: 'CSS selector for the input (e.g. "#ownerName", "input[name=\'search\']")',
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
      description: 'Click on a page element such as a button, link, or tab.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click' },
          text: {
            type: 'string',
            description: 'Visible text of the element to click (used when selector is unknown)',
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
      description: 'Press a keyboard key. Common uses: "Enter" to submit a form.',
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
        'Call this ONLY when you have successfully found and read all property/tax records. This finalizes the agent run and returns structured results.',
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
          totalFound:  { type: 'number', description: 'Total count of matching records found' },
          summary:     { type: 'string', description: 'One-sentence summary of what was found' },
          searchedUrl: { type: 'string', description: 'The URL where results were found' },
        },
        required: ['records', 'totalFound', 'summary'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor (Playwright actions — unchanged from original)
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
          await page.getByText(input.text, { exact: false }).first().click({ timeout: 5000 });
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
        await page
          .selectOption(input.selector, { label: input.value }, { timeout: 5000 })
          .catch(async () => {
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
      if (input.milliseconds > 0) await page.waitForTimeout(input.milliseconds);
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
// Main agent runner
// ---------------------------------------------------------------------------

/**
 * @param {object}   params
 * @param {string}   params.url           - County search website URL
 * @param {string}  [params.firstName]
 * @param {string}  [params.lastName]
 * @param {string}  [params.fullName]
 * @param {string}  [params.accountNumber]
 * @param {function}[params.onProgress]  - Optional callback(message: string)
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
    onProgress(`Launching browser (provider: ${LLM_PROVIDER}, model: ${LLM_MODEL})...`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Build search criteria list
    const criteria = [];
    if (firstName)     criteria.push(`First Name: "${firstName}"`);
    if (lastName)      criteria.push(`Last Name: "${lastName}"`);
    if (fullName)      criteria.push(`Full Name: "${fullName}"`);
    if (accountNumber) criteria.push(`Account / Property ID: "${accountNumber}"`);

    const nameForSearch =
      fullName ||
      (lastName && firstName ? `${lastName} ${firstName}` : lastName || firstName || '');

    // System prompt
    const SYSTEM_PROMPT = `You are an expert AI agent that navigates US county property tax and title search websites using browser automation tools.

Your goal: Search for property and tax records using the criteria provided, then return ALL found records via the extract_results tool.

## Step-by-step process
1. Take a screenshot to see the current page.
2. Call get_page_content to understand the form fields and buttons available.
3. Fill in the search form using the criteria provided:
   - Owner name fields: try "LASTNAME FIRSTNAME" or "FIRSTNAME LASTNAME"
   - For a single keyword/general search box, use: SMITH JOHN
   - If there's a year/tax year field, use 2025 or 2026
   - Account/parcel ID fields: enter the account number directly
4. Submit the form (click Search button or press Enter).
5. Wait for results to load.
6. Take a screenshot of the results page.
7. Call get_page_content to read the results text.
8. Extract ALL records using extract_results.

## Key rules
- Always start with take_screenshot.
- If a search returns no results, try an alternative format (swap first/last order, or try just the last name).
- Collect these fields per record: ownerName, propertyAddress, parcelId, taxYear, taxAmountDue, paymentStatus, county, state, legalDescription, additionalDetails.
- After 3 failed search attempts call extract_results with empty records and explain in the summary.`;

    const userMessage = `Please search the county property tax website for the following:

County URL: ${url}

Search Criteria:
${criteria.length > 0 ? criteria.join('\n') : 'No specific criteria provided'}
${nameForSearch ? `\nName string to use in search: "${nameForSearch}"` : ''}

Start by taking a screenshot to see the page, then proceed with the search. Return all found property/tax records.`;

    // Conversation history — system message goes first in OpenAI format
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ];

    let finalResults = null;
    const MAX_ITERATIONS = 18;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      onProgress(`AI agent working... (step ${iteration}/${MAX_ITERATIONS})`);

      const response = await client.chat.completions.create({
        model: LLM_MODEL,
        max_tokens: 4096,
        tools: AGENT_TOOLS,
        messages,
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      // Add assistant turn to history
      messages.push(assistantMessage);

      // Log any text the model produced
      if (assistantMessage.content && assistantMessage.content.trim()) {
        onProgress(`Agent: ${assistantMessage.content.trim().substring(0, 200)}`);
      }

      // No tool calls — model is done
      if (choice.finish_reason === 'stop' || !assistantMessage.tool_calls?.length) {
        onProgress('Agent finished reasoning.');
        break;
      }

      if (choice.finish_reason !== 'tool_calls') break;

      // -----------------------------------------------------------------------
      // Process each tool call
      // Screenshots are handled specially: the image is injected as a
      // follow-up user message so vision models can see it regardless of
      // whether the provider supports images inside tool results.
      // -----------------------------------------------------------------------
      let done = false;
      let pendingScreenshot = null;

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

        onProgress(`Running: ${toolName}...`);

        if (toolName === 'extract_results') {
          finalResults = { ...toolArgs, searchedUrl: page.url() };
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Results extracted successfully. Task complete.',
          });
          done = true;
          break;
        }

        const result = await executeTool(page, toolName, toolArgs);

        if (toolName === 'take_screenshot' && result._type === 'image') {
          // Return a text acknowledgment as the tool result...
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Screenshot captured. See the image in the next message.',
          });
          // ...then inject the actual image as a user message so the vision
          // model can process it on the next inference call.
          pendingScreenshot = result;
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        }
      }

      // Append the screenshot as a user message (after all tool results)
      if (pendingScreenshot) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${pendingScreenshot.mimeType};base64,${pendingScreenshot.data}`,
              },
            },
            {
              type: 'text',
              text: 'Above is the current browser screenshot. Analyze it and decide your next action.',
            },
          ],
        });
      }

      if (done) break;
    }

    onProgress('Search complete.');

    return (
      finalResults || {
        records: [],
        totalFound: 0,
        summary:
          'The agent was unable to extract structured results. The county website may have an unsupported layout.',
        searchedUrl: page.url(),
      }
    );
  } finally {
    await browser.close();
  }
}

module.exports = { runBrowserAgent };
