const express = require('express');
const requestContext = require('./requestContext');
const metrics = require('./metrics');
const logger = require('./logger');

const healthRoute = require('./routes/health');
const authRoute = require('./routes/auth');
const productsRoute = require('./routes/products');
const ordersRoute = require('./routes/orders');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const store = { dbQueries: 0, flushOps: 0 };
  requestContext.run(store, () => {
    res.on('finish', () => {
      metrics.emitRequestMetric({
        endpoint: req.path,
        dbQueries: store.dbQueries,
        flushOps: store.flushOps,
      });
    });
    next();
  });
});

app.use(healthRoute);
app.use(authRoute);
app.use(productsRoute);
app.use(ordersRoute);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error('unhandled_error', { message: err.message, path: req.path });
  res.status(500).json({ error: 'internal_error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  logger.info('server.start', { port: PORT });
});
