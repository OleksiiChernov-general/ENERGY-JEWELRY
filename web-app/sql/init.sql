CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
  request_description TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_address TEXT NOT NULL,
  opened_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Open', 'Completed')),
  completed_at TIMESTAMP NULL
);

CREATE INDEX IF NOT EXISTS orders_status_opened_at_idx
  ON orders (status, opened_at DESC);
