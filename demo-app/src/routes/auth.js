const crypto = require('node:crypto');
const express = require('express');
const logger = require('../logger');

const router = express.Router();

// Stub login: accepts anything, hands back an opaque, non-verifiable token.
// There is no real auth backing this — good enough for load-testing the
// rest of the app.
router.post('/login', (req, res) => {
  const token = `stub.${crypto.randomBytes(16).toString('hex')}`;
  logger.info('login', { user: req.body && req.body.username });
  res.status(200).json({ token });
});

module.exports = router;
