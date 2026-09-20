'use strict';

// The Investigator's blast-radius control, deliberately free of any AWS
// import and taking its manifest as a parameter — so it can be required by
// lambdas/guard/ AND by tests/guard.test.js on a fresh clone, where
// shared-allowlist-manifest.generated.json does not exist yet (it is
// gitignored and written during `cdk synth`).

const crypto = require('node:crypto');

// Named (not just .name-tagged) so a Step Functions Catch on
// ["GUARD_REJECTED"] matches this error's errorType directly.
class GUARD_REJECTED extends Error {
  constructor(message) {
    super(message);
    this.name = 'GUARD_REJECTED';
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verifies a proposed patch against the allowlist and the target file's
 * CURRENT content. Throws GUARD_REJECTED on either failure; returns the
 * patch unchanged on success.
 *
 * This is a security control, so it re-derives the hash from the manifest
 * rather than trusting anything the Investigator claimed. Enforcement is
 * independent of the prompt and of investigator/'s own schema enum — two
 * layers, on purpose.
 */
function verifyPatch(patch, manifest) {
  const allowlist = Object.keys(manifest);

  if (!patch || typeof patch.file !== 'string') {
    throw new GUARD_REJECTED('Patch is missing a "file" field');
  }
  if (!allowlist.includes(patch.file)) {
    throw new GUARD_REJECTED(`File "${patch.file}" is not in the allowlist: ${allowlist.join(', ')}`);
  }
  if (typeof patch.full_new_content !== 'string') {
    throw new GUARD_REJECTED(`Patch for ${patch.file} is missing "full_new_content"`);
  }

  const currentHash = sha256(manifest[patch.file]);
  if (patch.original_sha256 !== currentHash) {
    throw new GUARD_REJECTED(
      `original_sha256 mismatch for ${patch.file}: patch says ${patch.original_sha256}, ` +
        `current file hash is ${currentHash} — the file may have drifted since the patch was proposed`
    );
  }

  return patch;
}

module.exports = { GUARD_REJECTED, sha256, verifyPatch };
