const express = require('express');
const db = require('../db');
const logger = require('../logger');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

router.get('/products', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE)
    );
    const offset = (page - 1) * pageSize;

    const { rows } = await db.query(
      `SELECT id, name, category, price_cents, sku
       FROM app.products
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS total FROM app.products');

    logger.info('products.list', { page, pageSize, returned: rows.length });

    res.status(200).json({
      page,
      pageSize,
      total: countRows[0].total,
      items: rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
