'use strict';

const client = require('prom-client');

const register = new client.Registry();

register.setDefaultLabels({ app: 'opus-one', service: 'mortgage-search' });
client.collectDefaultMetrics({ register });

// ─── HTTP layer ───────────────────────────────────────────────────────────────

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// ─── Search operations ────────────────────────────────────────────────────────

const searchesTotal = new client.Counter({
  name: 'opus_searches_total',
  help: 'Total property searches completed',
  labelNames: ['endpoint', 'status'],  // status: success | error | timeout | captcha
  registers: [register],
});

const activeSearchesGauge = new client.Gauge({
  name: 'opus_active_searches',
  help: 'Browser search sessions currently running',
  registers: [register],
});

const searchDurationSeconds = new client.Histogram({
  name: 'opus_search_duration_seconds',
  help: 'End-to-end browser search time in seconds',
  labelNames: ['endpoint'],
  buckets: [5, 15, 30, 60, 90, 120, 180, 300],
  registers: [register],
});

// ─── Cache ────────────────────────────────────────────────────────────────────

const cacheHitsTotal = new client.Counter({
  name: 'opus_cache_hits_total',
  help: 'Search result cache hits',
  registers: [register],
});

const cacheMissesTotal = new client.Counter({
  name: 'opus_cache_misses_total',
  help: 'Search result cache misses',
  registers: [register],
});

const cacheSizeGauge = new client.Gauge({
  name: 'opus_cache_size_entries',
  help: 'Current number of entries in the search result cache',
  registers: [register],
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

const concurrencyRejectedTotal = new client.Counter({
  name: 'opus_concurrency_rejected_total',
  help: 'Requests rejected due to server-busy (max concurrent searches reached)',
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  searchesTotal,
  activeSearchesGauge,
  searchDurationSeconds,
  cacheHitsTotal,
  cacheMissesTotal,
  cacheSizeGauge,
  concurrencyRejectedTotal,
};
