'use strict';

/**
 * issue-classifier.js
 *
 * Takes a normalised county result + its field-check results and classifies
 * it into one or more ISSUE_TYPES.  Also produces an actionable fix list.
 */

const { ISSUE_TYPES } = require('./field-rules');
const { detectDataSource } = require('./report-parser');

// ─── Classify a single county ─────────────────────────────────────────────────

function classifyIssues(parsed, fieldCheck) {
  const issues = [];
  const fixes  = [];

  const autoStatus = parsed.autoStatus;
  const src        = detectDataSource(parsed);

  // ── Automation-level issues ────────────────────────────────────────────────

  if (autoStatus === 'no_url') {
    issues.push({ ...ISSUE_TYPES.DEAD_URL, detail: 'No URL registered in counties.json' });
    fixes.push({ priority: 1, action: 'Find URL', detail: `Look up ${parsed.county} on Netronline and add to data/counties.json` });
    return { issues, fixes, primaryIssue: ISSUE_TYPES.DEAD_URL.id };
  }

  if (autoStatus === 'captcha') {
    issues.push({ ...ISSUE_TYPES.CAPTCHA, detail: parsed.errors?.[0] || 'CAPTCHA detected' });
    fixes.push({ priority: 3, action: 'CAPTCHA', detail: 'Needs manual handling or anti-CAPTCHA integration' });
    return { issues, fixes, primaryIssue: ISSUE_TYPES.CAPTCHA.id };
  }

  if (autoStatus === 'error') {
    const err = (parsed.errors?.[0] || '').toLowerCase();
    if (err.includes('timeout')) {
      issues.push({ ...ISSUE_TYPES.SITE_TIMEOUT, detail: `Playwright timed out: ${parsed.errors?.[0]?.slice(0, 120)}` });
      fixes.push({ priority: 2, action: 'Check URL', detail: `Verify ${parsed.url} is live. Try loading it in a browser. May need updated URL.` });
    } else if (err.includes('503') || err.includes('busy')) {
      issues.push({ ...ISSUE_TYPES.SITE_TIMEOUT, detail: 'Server was busy (503) — all retries exhausted' });
      fixes.push({ priority: 2, action: 'Retry', detail: 'Retry when server is less loaded, or increase MAX_CONCURRENT on the server' });
    } else {
      issues.push({ ...ISSUE_TYPES.DEAD_URL, detail: parsed.errors?.[0] || 'Unknown error' });
      fixes.push({ priority: 2, action: 'Investigate', detail: `Error: ${parsed.errors?.[0]?.slice(0, 100)}` });
    }
    return { issues, fixes, primaryIssue: issues[0]?.id };
  }

  if (autoStatus === 'no_results') {
    issues.push({ ...ISSUE_TYPES.NO_RESULTS, detail: 'No records for Smith/Johnson/Williams — search form may need different parameters' });
    fixes.push({ priority: 3, action: 'Test manually', detail: `Open ${parsed.url} and try a name search to check format` });
  }

  // ── Data quality issues (even if automation "passed") ─────────────────────

  if (!parsed.hasIdRecord) {
    issues.push({ ...ISSUE_TYPES.NO_RESULTS, detail: 'Name search found records but could not navigate to detail page' });
    fixes.push({ priority: 2, action: 'Fix handler', detail: `Platform: ${parsed.platform} — detail page navigation failing` });
  }

  // CAD-only detection
  if (src.cadOnly) {
    issues.push({
      ...ISSUE_TYPES.CAD_ONLY,
      detail: 'Only CAD appraisal data retrieved — Tax Assessor-Collector website not queried',
    });
    fixes.push({
      priority: 1,
      action:   'Add Tax Office URL',
      detail:   `Find the ${parsed.county} County Tax Assessor-Collector URL and add a dual-search`,
    });
  }

  // Missing assessment values despite having a CAD record
  if (parsed.hasIdRecord && !src.hasAssessment && !src.cadOnly) {
    issues.push({ ...ISSUE_TYPES.MISSING_ASSESSMENT, detail: 'Handler connected but land/improvement values not extracted' });
    fixes.push({ priority: 2, action: 'Fix CAD handler', detail: `Check ${parsed.platform} handler — assessment field selectors may have changed` });
  }

  // Partial handler: some fields present but key ones missing
  const critFails = fieldCheck.criticalFails;
  if (critFails > 0 && critFails < 4 && parsed.hasIdRecord) {
    if (!issues.find(i => i.id === ISSUE_TYPES.CAD_ONLY.id)) {
      issues.push({
        ...ISSUE_TYPES.PARTIAL_HANDLER,
        detail: `${critFails} critical field(s) missing: ${
          fieldCheck.fieldResults
            .filter(f => !f.pass && f.tier === 'CRITICAL')
            .map(f => f.label)
            .join(', ')
        }`,
      });
      fixes.push({ priority: 2, action: 'Improve handler', detail: `Platform: ${parsed.platform} — extract missing critical fields` });
    }
  }

  // No issues at all
  if (issues.length === 0) {
    issues.push({ ...ISSUE_TYPES.GOOD, detail: 'All critical fields present' });
  }

  return {
    issues,
    fixes: fixes.sort((a, b) => a.priority - b.priority),
    primaryIssue: issues[0]?.id,
    dataSource: src,
  };
}

// ─── Aggregate across all counties ────────────────────────────────────────────

function aggregateIssues(allClassified) {
  const issueCounts  = {};
  const fixPriority  = {};
  const byPlatform   = {};

  for (const c of allClassified) {
    const plat = c.parsed?.platform || 'unknown';
    if (!byPlatform[plat]) byPlatform[plat] = { counties: [], primaryIssues: {} };
    byPlatform[plat].counties.push(c.parsed?.county);

    for (const issue of c.classification.issues) {
      issueCounts[issue.id] = (issueCounts[issue.id] || 0) + 1;
      byPlatform[plat].primaryIssues[issue.id] = (byPlatform[plat].primaryIssues[issue.id] || 0) + 1;
    }

    for (const fix of c.classification.fixes) {
      const key = fix.action;
      if (!fixPriority[key]) fixPriority[key] = { action: key, count: 0, priority: fix.priority, examples: [] };
      fixPriority[key].count++;
      if (fixPriority[key].examples.length < 3) fixPriority[key].examples.push(c.parsed?.county);
    }
  }

  // Build ordered fix roadmap
  const roadmap = Object.values(fixPriority)
    .sort((a, b) => a.priority - b.priority || b.count - a.count)
    .map((f, i) => ({ rank: i + 1, ...f }));

  return { issueCounts, byPlatform, roadmap };
}

module.exports = { classifyIssues, aggregateIssues };
