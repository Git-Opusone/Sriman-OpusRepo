'use strict';

// Thin wrapper — title team imports browser automation from here.
// The shared core lives in src/shared/browserAgent.js.
// Only src/shared/ changes affect this; title handler changes never touch shared code.
module.exports = require('../shared/browserAgent');
