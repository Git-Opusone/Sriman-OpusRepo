'use strict';

/**
 * src/countyDirectory.js
 *
 * Offline-first county URL lookup with live netronline fallback.
 * Provides:
 *   getCountyUrl(state, county)      → { url, platform, source }
 *   updateCountyUrl(state, county, newUrl)
 *   getAllStates()                   → [{ code, name }]
 *   getCountiesForState(stateCode)   → [countyName, ...]
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const DB_PATH = path.join(__dirname, '../data/counties.json');

const STATE_NAMES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', DC:'District of Columbia',
  FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois',
  IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana',
  ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota',
  MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada',
  NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York',
  NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon',
  PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota',
  TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
  WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming',
};

// ─── DB access ───────────────────────────────────────────────────────────────

let _db = null;

function loadDb() {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) {
    _db = { version: '1.0', lastUpdated: '', states: {} };
    return _db;
  }
  try {
    _db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (_) {
    _db = { version: '1.0', lastUpdated: '', states: {} };
  }
  return _db;
}

function saveDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(_db, null, 2));
}

// Normalise county name for lookup (case-insensitive, trim)
function normalise(name) {
  return (name || '').trim().toLowerCase();
}

function findCountyEntry(db, stateCode, countyName) {
  const stateData = db.states[stateCode.toUpperCase()];
  if (!stateData) return null;
  const norm = normalise(countyName);
  // Exact match first
  const exactKey = Object.keys(stateData).find(k => normalise(k) === norm);
  if (exactKey) return { key: exactKey, entry: stateData[exactKey] };
  // Partial match fallback
  const partialKey = Object.keys(stateData).find(k => normalise(k).includes(norm) || norm.includes(normalise(k)));
  if (partialKey) return { key: partialKey, entry: stateData[partialKey] };
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function getAllStates() {
  return Object.entries(STATE_NAMES).map(([code, name]) => ({ code, name }));
}

function getCountiesForState(stateCode) {
  const db = loadDb();
  const stateData = db.states[stateCode.toUpperCase()];
  if (!stateData) return [];
  return Object.keys(stateData)
    .filter(k => k !== '_done')
    .sort();
}

/**
 * Look up the property search URL for a county.
 * Returns { url, platform, source: 'offline'|'not_found' }
 */
function getCountyUrl(stateCode, countyName) {
  const db    = loadDb();
  const found = findCountyEntry(db, stateCode, countyName);
  if (!found || !found.entry.url) {
    return { url: null, platform: 'unknown', source: 'not_found' };
  }
  return { url: found.entry.url, platform: found.entry.platform || 'generic', source: 'offline' };
}

/**
 * Update a county's URL in the local database (called after live lookup).
 */
function updateCountyUrl(stateCode, countyName, newUrl, platform) {
  const db    = loadDb();
  const found = findCountyEntry(db, stateCode, countyName);
  const today = new Date().toISOString().split('T')[0];

  if (found) {
    found.entry.url          = newUrl;
    found.entry.platform     = platform || found.entry.platform;
    found.entry.lastVerified = today;
  } else {
    // New county not previously in DB
    const state = stateCode.toUpperCase();
    if (!db.states[state]) db.states[state] = {};
    db.states[state][countyName] = {
      url: newUrl, platform: platform || 'generic',
      lastVerified: today, netronlinePath: null,
    };
  }
  db.lastUpdated = today;
  saveDb();
  console.log(`[countyDirectory] Updated ${stateCode}/${countyName} → ${newUrl}`);
}

module.exports = { getAllStates, getCountiesForState, getCountyUrl, updateCountyUrl };
