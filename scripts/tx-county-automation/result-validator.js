'use strict';

/**
 * result-validator.js
 *
 * Validates and deeply analyses a county test result, producing a structured
 * validation report with field-level details so the self-fixer can act on it.
 */

// ─── Required fields that a "good" ID-search result should have ───────────────
const REQUIRED_FIELDS = [
  { key: 'parcelId',       label: 'Parcel ID',        weight: 10 },
  { key: 'ownerName',      label: 'Owner Name',        weight: 10 },
  { key: 'propertyAddress',label: 'Property Address',  weight: 10 },
  { key: 'taxAmountDue',   label: 'Tax Amount Due',    weight:  8 },
  { key: 'paymentStatus',  label: 'Payment Status',    weight:  3 }, // optional — CAD sites rarely have this
  { key: 'taxYear',        label: 'Tax Year',          weight:  5 },
];

const DETAIL_FIELDS = [
  { key: 'Legal Description',   label: 'Legal Description',   weight: 10 },
  { key: 'Land Value',          label: 'Land Value',           weight:  5 },
  { key: 'Improvement Value',   label: 'Improvement Value',    weight:  5 },
  { key: 'Effective Acres',     label: 'Effective Acres',      weight:  5 },
  { key: 'Bill Tables',         label: 'Bill History',         weight: 10 },
  { key: 'Total Taxes Due',     label: 'Total Taxes Due',      weight:  5 },
  { key: 'Assessed Value',      label: 'Assessed Value',       weight:  5 },
];

// Alias map for fields that appear under different names in additionalDetails
const FIELD_ALIASES = {
  // Public Portal / CAD keys use camelCase; tax-office keys use Title Case
  'Legal Description':  ['legalDescription', 'legal_desc', 'legal description', 'legaldescription'],
  'Land Value':         ['land_value', 'landValue', 'land value', 'landMarketValue', 'land market value', 'landmarket'],
  'Improvement Value':  ['improvement_value', 'improvementValue', 'improvement value', 'bldg value', 'building value', 'improvValue', 'imprv value'],
  'Effective Acres':    ['Acres', 'acres', 'effectiveAcres', 'effective_acres', 'acreage', 'legalAcreage', 'legal acreage', 'legal_acreage'],
  'Total Taxes Due':    ['totalTaxesDue', 'total_taxes_due', 'taxes due', 'Total Due', 'total due'],
  'Assessed Value':     ['assessedValue', 'assessed_value', 'total assessed value', 'appraisedValue', 'appraised value', 'appraisedvalue', 'marketValue', 'market value'],
  'Bill Tables':        ['billTables', 'bill_tables', 'taxHistory', 'tax history', 'paymentHistory', 'payment history', 'valueHistory'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPresent(value) {
  if (value == null)                return false;
  if (typeof value === 'string')    return value.trim() !== '' && value.trim().toUpperCase() !== 'N/A';
  if (typeof value === 'number')    return !isNaN(value);
  if (Array.isArray(value))         return value.length > 0;
  if (typeof value === 'object')    return Object.keys(value).length > 0;
  return Boolean(value);
}

function getDetailField(ad, fieldKey) {
  if (!ad) return null;
  // Exact match first
  if (isPresent(ad[fieldKey])) return ad[fieldKey];
  // Alias match
  const aliases = FIELD_ALIASES[fieldKey] || [];
  for (const alias of aliases) {
    // Case-insensitive key search
    const found = Object.entries(ad).find(([k]) => k.toLowerCase() === alias.toLowerCase());
    if (found && isPresent(found[1])) return found[1];
  }
  return null;
}

function parseAdditionalDetails(rec) {
  try {
    return typeof rec.additionalDetails === 'string'
      ? JSON.parse(rec.additionalDetails)
      : (rec.additionalDetails || {});
  } catch (_) {
    return {};
  }
}

// ─── Validate a single idSearch result ───────────────────────────────────────

function validateIdSearch(idSearch, referenceFields) {
  const report = {
    valid: false,
    score: 0,
    maxScore: 0,
    fieldResults: [],
    detailResults: [],
    missingCritical: [],
    missingOptional: [],
    presentFields: [],
    notes: [],
  };

  // Support both full records array and the compressed {sampleRecord} format
  const records = idSearch?.records?.length
    ? idSearch.records
    : (idSearch?.sampleRecord ? [idSearch.sampleRecord] : []);

  if (!records.length) {
    report.notes.push('No records returned from ID search');
    return report;
  }

  const rec = records[0];
  const ad  = parseAdditionalDetails(rec);

  // ── Top-level record fields ──────────────────────────────────────────────────
  for (const field of REQUIRED_FIELDS) {
    const present = isPresent(rec[field.key]);
    report.maxScore += field.weight;
    if (present) {
      report.score += field.weight;
      report.presentFields.push(field.label);
    } else {
      report.missingCritical.push(field.label);
    }
    report.fieldResults.push({ label: field.label, key: field.key, present, weight: field.weight, value: rec[field.key] });
  }

  // ── additionalDetails fields ───────────────────────────────────────────────
  for (const field of DETAIL_FIELDS) {
    const val     = getDetailField(ad, field.key);
    const present = isPresent(val);
    report.maxScore += field.weight;
    if (present) {
      report.score += field.weight;
      report.presentFields.push(field.label);
    } else {
      report.missingOptional.push(field.label);
    }
    report.detailResults.push({ label: field.label, key: field.key, present, weight: field.weight, value: val });
  }

  // ── Percentage score ──────────────────────────────────────────────────────
  report.scorePct  = report.maxScore > 0
    ? Math.round((report.score / report.maxScore) * 100)
    : 0;
  report.valid     = report.scorePct >= 60;

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (idSearch.totalFound > 1)
    report.notes.push(`ID search returned ${idSearch.totalFound} records (expected 1)`);
  if (rec.county && rec.state)
    report.notes.push(`County/state in record: ${rec.county}, ${rec.state}`);
  if (!rec.county || !rec.state)
    report.notes.push('Record is missing county or state field');

  return report;
}

// ─── Compare against Anderson County baseline ─────────────────────────────────

const ANDERSON_BASELINE = {
  requiredTopFields:  ['parcelId', 'ownerName', 'propertyAddress', 'taxAmountDue'],
  requiredDetailKeys: ['Legal Description', 'Land Value', 'Improvement Value', 'Bill Tables'],
  minScore: 70,
};

function compareToBaseline(validationReport) {
  const gaps = [];
  for (const field of ANDERSON_BASELINE.requiredTopFields) {
    const fieldResult = validationReport.fieldResults.find(f => f.key === field);
    if (!fieldResult?.present) gaps.push(field);
  }
  for (const detailKey of ANDERSON_BASELINE.requiredDetailKeys) {
    const detailResult = validationReport.detailResults.find(f => f.key === detailKey);
    if (!detailResult?.present) gaps.push(detailKey + ' (detail)');
  }
  return {
    meetsBaseline: gaps.length === 0 && validationReport.scorePct >= ANDERSON_BASELINE.minScore,
    gaps,
    scorePct: validationReport.scorePct,
    baselineMinScore: ANDERSON_BASELINE.minScore,
  };
}

// ─── Validate a full county test result ──────────────────────────────────────

function validateCountyResult(testResult) {
  const report = {
    county:          testResult.county,
    state:           testResult.state,
    platform:        testResult.platform,
    status:          testResult.status,
    score:           testResult.score,
    testedAt:        testResult.testedAt,
    durationMs:      testResult.durationMs,
    nameSearch:      null,
    idSearch:        null,
    baseline:        null,
    recommendations: [],
  };

  // ── Name search summary ────────────────────────────────────────────────────
  if (testResult.nameSearch) {
    const ns = testResult.nameSearch;
    report.nameSearch = {
      nameUsed:    testResult.nameUsed,
      found:       ns.recordCount > 0,
      recordCount: ns.recordCount,
      captcha:     ns.captcha,
      error:       ns.error,
    };
  }

  // ── ID search deep validation ──────────────────────────────────────────────
  if (testResult.idSearch) {
    report.idSearch   = validateIdSearch(testResult.idSearch);
    report.baseline   = compareToBaseline(report.idSearch);
  }

  // ── Recommendations ────────────────────────────────────────────────────────
  if (testResult.status === 'no_url') {
    report.recommendations.push({ type: 'find_url', message: 'No URL in registry — check Netronline for this county' });
  }
  if (testResult.status === 'captcha') {
    report.recommendations.push({ type: 'captcha', message: 'Site requires CAPTCHA — may need manual handling or CAPTCHA solver' });
  }
  if (testResult.status === 'no_results') {
    report.recommendations.push({ type: 'check_url', message: 'Site accessible but no Smith/Johnson results — verify URL is correct search page' });
  }
  if (testResult.status === 'no_property_id') {
    report.recommendations.push({ type: 'fix_parcel_id', message: 'Records returned without parcelId — handler needs to extract parcel/account number' });
  }
  if (testResult.platform === 'generic' && testResult.status === 'pass') {
    report.recommendations.push({ type: 'identify_platform', message: 'Passing via AI fallback — identify the platform and add a dedicated handler for better reliability' });
  }
  if (testResult.platform === 'generic' && testResult.status === 'fail') {
    report.recommendations.push({ type: 'build_handler', message: 'Failing with generic AI — needs URL investigation and possibly a dedicated handler' });
  }
  if (report.idSearch && !report.baseline?.meetsBaseline) {
    const gaps = report.baseline?.gaps ?? [];
    if (gaps.length > 0) {
      report.recommendations.push({ type: 'missing_fields', message: `Missing fields vs Anderson baseline: ${gaps.join(', ')}` });
    }
  }

  return report;
}

// ─── Aggregate validation across all counties ─────────────────────────────────

function aggregateResults(allResults) {
  const counts = { pass: 0, partial: 0, fail: 0, captcha: 0, no_results: 0, no_url: 0, no_property_id: 0, error: 0, pending: 0 };
  const byPlatform = {};
  const totalScores = [];

  for (const r of allResults) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const plat = r.platform || 'unknown';
    if (!byPlatform[plat]) byPlatform[plat] = { pass: 0, partial: 0, fail: 0, other: 0, total: 0 };
    byPlatform[plat].total++;
    if (r.status === 'pass')         byPlatform[plat].pass++;
    else if (r.status === 'partial') byPlatform[plat].partial++;
    else if (r.status === 'fail')    byPlatform[plat].fail++;
    else                             byPlatform[plat].other++;
    if (r.score != null) totalScores.push(r.score);
  }

  const avgScore = totalScores.length ? Math.round(totalScores.reduce((a, b) => a + b, 0) / totalScores.length) : 0;

  return { counts, byPlatform, avgScore, totalCounties: allResults.length };
}

module.exports = { validateIdSearch, validateCountyResult, aggregateResults, compareToBaseline, isPresent };
