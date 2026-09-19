-- Idempotent reset + seed for the Klyro demo app.
-- Safe to run repeatedly: always drops and rebuilds the "app" schema, then
-- fills it with a fixed, deterministic dataset (no random()), so before/after
-- perf runs see byte-identical data.

DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;

CREATE TABLE app.products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  sku TEXT NOT NULL UNIQUE
);

CREATE TABLE app.orders (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES app.products(id),
  customer_email TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_orders_product_id ON app.orders (product_id);
CREATE INDEX idx_orders_created_at ON app.orders (created_at);

-- 300 deterministic products across 8 categories.
INSERT INTO app.products (name, category, price_cents, sku)
SELECT
  'Product ' || i,
  (ARRAY['Electronics', 'Home', 'Toys', 'Books', 'Sports', 'Grocery', 'Outdoor', 'Office'])[1 + (i % 8)],
  500 + (i * 37) % 9500,
  'SKU-' || lpad(i::text, 6, '0')
FROM generate_series(1, 300) AS s(i);

-- 3000 deterministic orders spread evenly across products, statuses, and time.
INSERT INTO app.orders (product_id, customer_email, quantity, status, created_at)
SELECT
  1 + (i % 300),
  'customer' || (i % 500) || '@example.com',
  1 + (i % 5),
  (ARRAY['pending', 'paid', 'shipped', 'delivered', 'cancelled'])[1 + (i % 5)],
  TIMESTAMP '2025-01-01 00:00:00' + (i || ' minutes')::interval
FROM generate_series(1, 3000) AS s(i);
