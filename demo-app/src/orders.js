const express = require('express');
const db = require('./db');
const logger = require('./logger');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// SEEDED BUG (perf issue #1): fetches a page of orders, then loops over
// them issuing one SELECT per order for the product it references, instead
// of a single batched `WHERE id IN (...)` query. At pageSize=50 this is
// 1 + 50 queries per request. The fix batches the product lookups.
router.get('/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE)
    );
    const offset = (page - 1) * pageSize;

    const { rows: orders } = await db.query(
      `SELECT id, product_id, customer_email, quantity, status, created_at
       FROM app.orders
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    const items = [];
    for (const order of orders) {
      const { rows: productRows } = await db.query(
        'SELECT id, name, price_cents FROM app.products WHERE id = $1',
        [order.product_id]
      );
      const product = productRows[0] || null;
      items.push({
        id: order.id,
        customerEmail: order.customer_email,
        quantity: order.quantity,
        status: order.status,
        createdAt: order.created_at,
        product,
      });
    }

    logger.info('orders.list', { page, pageSize, returned: items.length });

    res.status(200).json({ page, pageSize, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
