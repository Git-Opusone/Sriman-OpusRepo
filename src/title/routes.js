'use strict';

// ─── Title Search Routes ──────────────────────────────────────────────────────
// Namespace: /api/title/*
// Team:      Title search team (separate from tax team)
// Handlers:  src/title/handlers/  (county register of deeds, eCourts, PACER, etc.)
//
// Status: Skeleton — implementation in progress

const express = require('express');
const router  = express.Router();

// Health check for title namespace
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'title-search',
    version: '0.1.0-skeleton',
    message: 'Title search namespace active. Handlers coming soon.',
  });
});

// Placeholder — will become the title SSE search endpoint
// GET /api/title/search/stream
router.get('/search/stream', (_req, res) => {
  res.status(501).json({
    error: 'Title search not yet implemented.',
    message: 'This endpoint will stream title search results (Register of Deeds, eCourts, PACER).',
  });
});

module.exports = router;
