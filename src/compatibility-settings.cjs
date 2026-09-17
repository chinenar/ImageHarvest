'use strict';
// The old domain-specific opt-in default does not represent a choice about this engine.
// Explicit choices made after migration are preserved.
function compatibilitySettings(value = {}) {
  return {
    protectionCompatibility: typeof value.protectionCompatibility === 'boolean' ? value.protectionCompatibility : true,
    browserMode: ['chrome', 'electron'].includes(value.browserMode) ? value.browserMode : 'chrome'
  };
}
module.exports = { compatibilitySettings };
