'use strict';

/**
 * field-rules.js
 *
 * Single source of truth for WHAT a complete tax report must contain.
 * Every field has a tier (CRITICAL / IMPORTANT / OPTIONAL), a validator
 * function, and a human-readable description used in reports.
 *
 * Modelled on the Andrews County gap:
 *   - CAD sites  → property description only (parcel, owner, legal, acres)
 *   - Tax office → assessment values + tax bills + amounts due (often missing)
 */

// ─── Tier constants ───────────────────────────────────────────────────────────
const TIER = { CRITICAL: 'CRITICAL', IMPORTANT: 'IMPORTANT', OPTIONAL: 'OPTIONAL' };

// ─── Helper validators ────────────────────────────────────────────────────────
const notEmpty  = v => v != null && String(v).trim() !== '' && String(v).trim() !== '—' && String(v).trim().toUpperCase() !== 'N/A';
const isDollar  = v => notEmpty(v) && /^\$?[\d,]+(\.\d{1,2})?$/.test(String(v).trim());
const isYear    = v => notEmpty(v) && /^20[12]\d$/.test(String(v).trim());
const isAcres   = v => notEmpty(v) && parseFloat(String(v).replace(/[^0-9.]/g,'')) > 0;
const isPhone   = v => notEmpty(v) && /[\d\-\(\)\+\s]{7,}/.test(String(v));

// ─── Field Rules ──────────────────────────────────────────────────────────────
const FIELD_RULES = [

  // ── GROUP 1: Property Identity (from CAD — always required) ─────────────────
  {
    id:          'parcelId',
    group:       'Property Identity',
    label:       'Parcel / Account #',
    tier:        TIER.CRITICAL,
    source:      'CAD',
    description: 'Unique identifier for the property',
    extract:     (r, ad) => r.parcelId || ad?.['Property ID'] || ad?.propId,
    validate:    notEmpty,
    failMsg:     'Parcel ID is missing — core identifier required for all downstream lookups',
  },
  {
    id:          'ownerName',
    group:       'Property Identity',
    label:       'Owner Name',
    tier:        TIER.CRITICAL,
    source:      'CAD',
    description: 'Current property owner of record',
    extract:     (r) => r.ownerName,
    validate:    notEmpty,
    failMsg:     'Owner name missing — cannot produce a valid tax report',
  },
  {
    id:          'propertyAddress',
    group:       'Property Identity',
    label:       'Property / Situs Address',
    tier:        TIER.CRITICAL,
    source:      'CAD',
    description: 'Physical location of the property',
    extract:     (r) => r.propertyAddress,
    validate:    notEmpty,
    failMsg:     'Property address missing',
  },
  {
    id:          'legalDescription',
    group:       'Property Identity',
    label:       'Legal Description',
    tier:        TIER.IMPORTANT,
    source:      'CAD',
    description: 'Survey / plat legal description',
    extract:     (r, ad) => r.legalDescription || ad?.['Legal Description'] || ad?.legalDescription,
    validate:    notEmpty,
    failMsg:     'Legal description missing — needed for title/deed verification',
  },
  {
    id:          'acres',
    group:       'Property Identity',
    label:       'Acres / Lot Size',
    tier:        TIER.IMPORTANT,
    source:      'CAD',
    description: 'Land area',
    extract:     (r, ad) => ad?.['Effective Acres'] || ad?.legalAcreage || ad?.acres || ad?.Acres,
    validate:    isAcres,
    failMsg:     'Acres / lot size missing',
  },
  {
    id:          'taxYear',
    group:       'Property Identity',
    label:       'Tax Year',
    tier:        TIER.CRITICAL,
    source:      'BOTH',
    description: 'Year the assessment / tax applies to',
    extract:     (r, ad) => {
      const direct = r.taxYear || ad?.year || ad?.taxYear || ad?.['Tax Year'] || ad?.['Year'];
      if (direct && /^20[12]\d$/.test(String(direct).trim())) return direct;
      // BIS-specific: pick the newest 20XX key from additionalDetails
      if (ad) {
        const years = Object.keys(ad).filter(k => /^20[2-3]\d$/.test(k)).sort((a, b) => Number(b) - Number(a));
        if (years.length > 0) return years[0];
      }
      return null;
    },
    validate:    isYear,
    failMsg:     'Tax year missing or out of range (expected 2020–2026)',
  },
  {
    id:          'countyState',
    group:       'Property Identity',
    label:       'County + State',
    tier:        TIER.CRITICAL,
    source:      'BOTH',
    description: 'County and state must be present',
    extract:     (r) => (r.county && r.state) ? `${r.county}, ${r.state}` : null,
    validate:    notEmpty,
    failMsg:     'County / state missing from record',
  },

  // ── GROUP 2: Assessment Values (from CAD — critical gap for BIS/generic) ─────
  {
    id:          'landValue',
    group:       'Assessment',
    label:       'Land Value',
    tier:        TIER.CRITICAL,
    source:      'CAD',
    description: 'Appraised land value from appraisal district',
    extract:     (r, ad) => {
      const explicit = ad?.['Land Value'] || ad?.['Land Market'] || ad?.landMarketValue || ad?.landValue || ad?.land_value;
      if (explicit) return explicit;
      // PublicPortal land-only: if no improvement value, the market value IS the land value
      const noImprov = !ad?.improvementValue && !ad?.['Improvement Value'] && !ad?.['Improvements'];
      if (noImprov && (ad?.marketValue || ad?.appraisedValue)) {
        const v = ad.marketValue || ad.appraisedValue;
        return typeof v === 'number' ? '$' + v.toLocaleString() : String(v);
      }
      return null;
    },
    validate:    notEmpty,
    failMsg:     'Land value missing — CAD extraction incomplete (BIS/PublicPortal may need handler fix)',
  },
  {
    id:          'improvementValue',
    group:       'Assessment',
    label:       'Improvement / Building Value',
    tier:        TIER.IMPORTANT,
    source:      'CAD',
    description: 'Appraised building/improvement value',
    extract:     (r, ad) => ad?.['Improvement Value'] || ad?.['Improvements'] || ad?.improvementValue || ad?.improvement_value,
    validate:    notEmpty,
    failMsg:     'Improvement value missing (may be $0 for bare land — acceptable if explicit)',
  },
  {
    id:          'totalAssessedValue',
    group:       'Assessment',
    label:       'Total Assessed Value',
    tier:        TIER.CRITICAL,
    source:      'CAD',
    description: 'Total appraised / assessed value used for tax calculation',
    extract:     (r, ad) => {
      const v = r.taxAmountDue || ad?.['Total Assessed Value'] || ad?.appraisedValue ||
                ad?.assessedValue || ad?.marketValue || ad?.['Assessed Value'];
      return v;
    },
    validate:    notEmpty,
    failMsg:     'Total assessed value missing — cannot verify tax calculation',
  },

  // ── GROUP 3: Tax Payment Data (from TAX OFFICE — major gap for most counties)
  {
    id:          'taxAmountDue',
    group:       'Tax Payment',
    label:       'Current Amount Due',
    tier:        TIER.CRITICAL,
    source:      'TAX_OFFICE',
    description: 'Current year tax amount owed to all entities',
    extract:     (r, ad) => {
      if (notEmpty(r.paymentStatus) && r.paymentStatus.toLowerCase().includes('paid')) return '$0.00';
      return ad?.['Current Due'] || ad?.['Total Due'] || ad?.['Total Taxes Due'] || ad?.currentDue;
    },
    validate:    v => notEmpty(v),
    failMsg:     'Current amount due missing — tax office website likely not searched (CAD-only result)',
  },
  {
    id:          'paymentStatus',
    group:       'Tax Payment',
    label:       'Payment Status',
    tier:        TIER.IMPORTANT,
    source:      'TAX_OFFICE',
    description: '"Paid", "Balance Due", "Past Due", "Delinquent"',
    extract:     (r) => r.paymentStatus,
    validate:    notEmpty,
    failMsg:     'Payment status missing — need tax office source',
  },
  {
    id:          'billHistory',
    group:       'Tax Payment',
    label:       'Tax Bill History (≥1 year)',
    tier:        TIER.IMPORTANT,
    source:      'TAX_OFFICE',
    description: 'At least one year of historical tax bill detail',
    extract:     (r, ad) => {
      const bills = ad?.['Bill Tables'] || ad?.billTables || ad?.taxHistory;
      if (Array.isArray(bills) && bills.length > 0) return bills;
      if (ad?.valueHistory && Object.keys(ad.valueHistory||{}).length > 0) return ad.valueHistory;
      // BIS-specific: year-keyed dollar-amount entries (per-year tax bill history)
      if (ad) {
        const yearEntries = Object.entries(ad).filter(([k, v]) => /^20[12]\d$/.test(k) && /^\$/.test(String(v)));
        if (yearEntries.length > 0) return Object.fromEntries(yearEntries);
      }
      return null;
    },
    validate:    v => v != null,
    failMsg:     'No tax bill history — tax office website likely not searched',
  },
  {
    id:          'collectingEntities',
    group:       'Tax Payment',
    label:       'Collecting Entities (County/City/School)',
    tier:        TIER.IMPORTANT,
    source:      'TAX_OFFICE',
    description: 'List of taxing entities (county, school district, city, etc.)',
    extract:     (r, ad) => {
      if (ad?.taxingUnits || ad?.collectingEntities || ad?.entities) {
        return ad.taxingUnits || ad.collectingEntities || ad.entities;
      }
      // BIS-specific: entity names appear as object keys with rate/amount values
      // Pattern: ALL-CAPS multi-word strings containing COUNTY, SCHOOL, DIST, CITY, etc.
      if (ad) {
        const entities = {};
        Object.entries(ad).forEach(([k, v]) => {
          if (
            /^[A-Z][A-Z\s\.\-]+$/.test(k) && k.length > 4 &&
            (k.includes('COUNTY') || k.includes('SCHOOL') || k.includes('DIST') ||
             k.includes('CITY') || k.includes('COLLEGE') || k.includes('HOSPITAL') ||
             k.includes('FIRE') || k.includes('WATER') || k.includes('MUD') ||
             k.includes('FMFC') || k.includes('MPC') || k.includes('WCID'))
          ) {
            entities[k] = v;
          }
        });
        if (Object.keys(entities).length > 0) return entities;
      }
      return null;
    },
    validate:    v => v != null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0),
    failMsg:     'Taxing entities missing — tax office not queried',
  },

  // ── GROUP 4: Tax Office Contact (from TAX OFFICE) ──────────────────────────
  {
    id:          'taxOfficeEntity',
    group:       'Tax Office Contact',
    label:       'Tax Office Entity Name',
    tier:        TIER.IMPORTANT,
    source:      'TAX_OFFICE',
    description: 'Name of the Tax Assessor-Collector office',
    extract:     (r, ad) => ad?.['Source'] || ad?.taxOfficeName || ad?.entityName,
    validate:    notEmpty,
    failMsg:     'Tax office entity name missing',
  },
  {
    id:          'taxOfficeAddress',
    group:       'Tax Office Contact',
    label:       'Tax Office Address',
    tier:        TIER.OPTIONAL,
    source:      'TAX_OFFICE',
    description: 'Mailing/physical address of the tax office',
    extract:     (r, ad) => ad?.taxOfficeAddress || ad?.['Tax Office Address'],
    validate:    notEmpty,
    failMsg:     'Tax office address not extracted',
  },
  {
    id:          'taxOfficePhone',
    group:       'Tax Office Contact',
    label:       'Tax Office Phone',
    tier:        TIER.OPTIONAL,
    source:      'TAX_OFFICE',
    description: 'Phone number for the tax collector office',
    extract:     (r, ad) => ad?.taxOfficePhone || ad?.['Tax Office Phone'],
    validate:    isPhone,
    failMsg:     'Tax office phone not extracted',
  },
];

// ─── Score weights by tier ────────────────────────────────────────────────────
const TIER_WEIGHTS = {
  [TIER.CRITICAL]:  15,
  [TIER.IMPORTANT]:  8,
  [TIER.OPTIONAL]:   3,
};

// ─── Issue type classification ────────────────────────────────────────────────
const ISSUE_TYPES = {
  CAD_ONLY: {
    id:    'CAD_ONLY',
    label: 'CAD Data Only',
    color: '#f97316',
    description: 'Only appraisal district data retrieved — tax office not queried. '
               + 'Missing: amounts due, payment status, bill history, taxing entities.',
    fix:   'Add dual-search: also query the county Tax Assessor-Collector website.',
  },
  MISSING_ASSESSMENT: {
    id:    'MISSING_ASSESSMENT',
    label: 'Assessment Values Missing',
    color: '#ef4444',
    description: 'Handler connected to the CAD site but did not extract land/improvement/total values.',
    fix:   'Fix CAD handler extraction — check if the site uses a different field name or page layout.',
  },
  SITE_TIMEOUT: {
    id:    'SITE_TIMEOUT',
    label: 'Site Timeout',
    color: '#dc2626',
    description: 'County website did not respond within the 90s Playwright timeout.',
    fix:   'Check if the URL is correct and the site is live. May need a newer URL from Netronline.',
  },
  DEAD_URL: {
    id:    'DEAD_URL',
    label: 'Dead / Invalid URL',
    color: '#6b7280',
    description: 'County URL in registry returns 404 or connection refused.',
    fix:   'Look up the correct URL on Netronline and update data/counties.json.',
  },
  NO_RESULTS: {
    id:    'NO_RESULTS',
    label: 'No Search Results',
    color: '#f59e0b',
    description: 'Site is alive but returned no results for the test name.',
    fix:   'The site may require a different search format (full name, account number only, etc.).',
  },
  CAPTCHA: {
    id:    'CAPTCHA',
    label: 'CAPTCHA Blocked',
    color: '#8b5cf6',
    description: 'Site requires CAPTCHA verification — automation cannot proceed.',
    fix:   'Needs manual handling or a CAPTCHA-solving integration.',
  },
  PARTIAL_HANDLER: {
    id:    'PARTIAL_HANDLER',
    label: 'Partial Handler',
    color: '#d97706',
    description: 'Handler runs and returns some fields but misses assessment or tax data.',
    fix:   'Review handler extraction selectors — some fields may have changed on the site.',
  },
  GOOD: {
    id:    'GOOD',
    label: 'Complete Report',
    color: '#22c55e',
    description: 'All critical fields present.',
    fix:   null,
  },
};

module.exports = { FIELD_RULES, TIER, TIER_WEIGHTS, ISSUE_TYPES, notEmpty };
