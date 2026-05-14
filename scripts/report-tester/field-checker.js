'use strict';

/**
 * field-checker.js
 *
 * Runs every FIELD_RULE against a normalised county result and produces a
 * per-field pass/fail breakdown with a weighted completeness score.
 */

const { FIELD_RULES, TIER, TIER_WEIGHTS } = require('./field-rules');

// ─── Check one county result ──────────────────────────────────────────────────

function checkCounty(parsed) {
  const results = [];
  let earned = 0;
  let possible = 0;

  for (const rule of FIELD_RULES) {
    const weight  = TIER_WEIGHTS[rule.tier];
    possible += weight;

    // Extract value using the rule's extractor
    let value = null;
    try {
      value = rule.extract(parsed.record, parsed.ad);
    } catch (_) {}

    const pass    = value != null && rule.validate(value);
    if (pass) earned += weight;

    results.push({
      id:          rule.id,
      group:       rule.group,
      label:       rule.label,
      tier:        rule.tier,
      source:      rule.source,
      weight,
      pass,
      value:       pass ? _truncate(String(value), 80) : null,
      failMsg:     pass ? null : rule.failMsg,
    });
  }

  const scorePct = possible > 0 ? Math.round((earned / possible) * 100) : 0;

  // Group by CRITICAL failures specifically
  const criticalFails = results.filter(r => !r.pass && r.tier === TIER.CRITICAL);
  const importantFails= results.filter(r => !r.pass && r.tier === TIER.IMPORTANT);
  const passCount     = results.filter(r => r.pass).length;

  return {
    county:        parsed.county,
    state:         parsed.state,
    platform:      parsed.platform,
    scorePct,
    earned,
    possible,
    passCount,
    totalRules:    results.length,
    criticalFails: criticalFails.length,
    importantFails:importantFails.length,
    grade:         _grade(scorePct, criticalFails.length),
    fieldResults:  results,
    groupSummary:  _groupSummary(results),
  };
}

// ─── Grade ────────────────────────────────────────────────────────────────────

function _grade(scorePct, criticalFails) {
  if (criticalFails >= 4) return { letter: 'F', label: 'FAIL — Critical data missing',   color: '#dc2626' };
  if (criticalFails >= 2) return { letter: 'D', label: 'POOR — Major gaps',              color: '#ef4444' };
  if (scorePct >= 85)     return { letter: 'A', label: 'EXCELLENT — Anderson-quality',   color: '#16a34a' };
  if (scorePct >= 70)     return { letter: 'B', label: 'GOOD — Minor gaps only',         color: '#22c55e' };
  if (scorePct >= 55)     return { letter: 'C', label: 'PARTIAL — Missing tax office data', color: '#f59e0b' };
  if (scorePct >= 35)     return { letter: 'D', label: 'POOR — Major gaps',              color: '#f97316' };
  return                         { letter: 'F', label: 'FAIL — Critical data missing',   color: '#dc2626' };
}

// ─── Group results by field group for the report table ────────────────────────

function _groupSummary(results) {
  const groups = {};
  for (const r of results) {
    if (!groups[r.group]) groups[r.group] = { pass: 0, fail: 0, fields: [] };
    groups[r.group].fields.push(r);
    r.pass ? groups[r.group].pass++ : groups[r.group].fail++;
  }
  return groups;
}

function _truncate(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

// ─── Check multiple counties and return aggregate ─────────────────────────────

function checkAll(parsedList) {
  const results = parsedList.map(p => {
    // If the automation result itself had no record, still run — all fields will fail
    return { parsed: p, check: checkCounty(p) };
  });

  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const sourceDist = { CAD_ONLY: 0, TAX_ONLY: 0, BOTH: 0, NONE: 0 };
  let totalScore = 0;

  results.forEach(({ check, parsed }) => {
    grades[check.grade.letter]++;
    totalScore += check.scorePct;

    // Source distribution
    const { detectDataSource } = require('./report-parser');
    const src = detectDataSource(parsed);
    if (src.cadOnly)           sourceDist.CAD_ONLY++;
    else if (src.taxOnly)      sourceDist.TAX_ONLY++;
    else if (src.both)         sourceDist.BOTH++;
    else                       sourceDist.NONE++;
  });

  return {
    results,
    grades,
    sourceDist,
    avgScore:    results.length ? Math.round(totalScore / results.length) : 0,
    totalCounties: results.length,
  };
}

module.exports = { checkCounty, checkAll };
