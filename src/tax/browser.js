'use strict';

// Thin wrapper — tax team imports browser automation from here.
// The shared core lives in src/shared/browserAgent.js.
// Only src/shared/ changes affect this; tax handler changes never touch shared code.
module.exports = require('../shared/browserAgent');
