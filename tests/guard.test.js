'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyPatch, sha256 } = require('../lambdas/shared/patchGuard');

// The real manifest (lambdas/shared-allowlist-manifest.generated.json) is
// gitignored and only written during `cdk synth`, which is exactly why
// verifyPatch takes the manifest as a parameter — these tests run on a
// fresh clone with no AWS and no synth.
const ORDERS = 'module.exports = function getOrders() { /* n+1 */ };\n';
const LOGGER = 'module.exports = { info() {} };\n';
const manifest = {
  'demo-app/src/orders.js': ORDERS,
  'demo-app/src/logger.js': LOGGER,
  'demo-app/config/logger.json': '{"flushIntervalMs":50}\n',
};

const validPatch = (over = {}) => ({
  file: 'demo-app/src/orders.js',
  original_sha256: sha256(ORDERS),
  full_new_content: 'module.exports = function getOrders() { /* batched */ };\n',
  reason: 'batch the product lookups',
  expected_effect: 'fewer db queries per request',
  ...over,
});

test('a well-formed patch against current content is accepted', () => {
  const patch = validPatch();
  assert.equal(verifyPatch(patch, manifest), patch);
});

test('every allowlisted file is accepted', () => {
  for (const [file, content] of Object.entries(manifest)) {
    const patch = validPatch({ file, original_sha256: sha256(content) });
    assert.doesNotThrow(() => verifyPatch(patch, manifest));
  }
});

test('a file outside the allowlist is rejected', () => {
  assert.throws(() => verifyPatch(validPatch({ file: 'demo-app/src/db.js' }), manifest), {
    name: 'GUARD_REJECTED',
    message: /not in the allowlist/,
  });
});

test('path traversal is rejected — it is simply not on the allowlist', () => {
  for (const file of ['../../etc/passwd', '/etc/passwd', 'demo-app/../../../etc/passwd', 'demo-app/src/../../x.js']) {
    assert.throws(() => verifyPatch(validPatch({ file }), manifest), { name: 'GUARD_REJECTED' });
  }
});

test('a stale original_sha256 is rejected', () => {
  // The Investigator proposed against content that has since changed —
  // applying it would silently patch something it never saw.
  const stale = sha256('some older version of orders.js\n');
  assert.throws(() => verifyPatch(validPatch({ original_sha256: stale }), manifest), {
    name: 'GUARD_REJECTED',
    message: /original_sha256 mismatch/,
  });
});

test('the hash is recomputed, not trusted', () => {
  // A patch claiming the hash of its OWN new content must still fail:
  // guard hashes the manifest's current content, never the patch's.
  const patch = validPatch();
  patch.original_sha256 = sha256(patch.full_new_content);
  assert.throws(() => verifyPatch(patch, manifest), { name: 'GUARD_REJECTED' });
});

test('a missing or non-string file field is rejected', () => {
  for (const patch of [null, {}, { file: 42 }, { file: null }]) {
    assert.throws(() => verifyPatch(patch, manifest), { name: 'GUARD_REJECTED' });
  }
});

test('a patch with no replacement content is rejected', () => {
  const patch = validPatch();
  delete patch.full_new_content;
  assert.throws(() => verifyPatch(patch, manifest), {
    name: 'GUARD_REJECTED',
    message: /full_new_content/,
  });
});

test('sha256 matches a known digest', () => {
  // Pins the hash function itself, so a change to encoding or algorithm
  // cannot quietly invalidate every stored original_sha256.
  assert.equal(sha256('klyro'), crypto.createHash('sha256').update('klyro', 'utf8').digest('hex'));
  assert.equal(sha256('').length, 64);
});
