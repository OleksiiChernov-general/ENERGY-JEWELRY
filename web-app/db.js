const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const APP_ROOT = __dirname;
const DATA_ROOT = path.join(APP_ROOT, "data");
const LEGACY_ORDERS_JSON_PATH = path.join(DATA_ROOT, "product-orders.json");
const INIT_SQL_PATH = path.join(APP_ROOT, "sql", "init.sql");

let pool;

async function initializeOrdersStore() {
  pool = new Pool(buildPoolConfig());
  await getPool().query("SELECT 1");
  await getPool().query(fs.readFileSync(INIT_SQL_PATH, "utf8"));
  await migrateLegacyOrdersIfNeeded();
}

async function listOrders() {
  const result = await getPool().query(
    `SELECT
       order_id,
       product,
       quantity,
       price,
       total,
       request_description,
       customer_name,
       customer_address,
       opened_at,
       created_at,
       status,
       completed_at
     FROM orders
     ORDER BY
       CASE WHEN status = 'Completed' THEN 1 ELSE 0 END ASC,
       opened_at DESC`
  );

  return result.rows.map(mapOrderRow);
}

async function createOrder(order) {
  const result = await getPool().query(
    `INSERT INTO orders (
       order_id,
       product,
       quantity,
       price,
       total,
       request_description,
       customer_name,
       customer_address,
       opened_at,
       created_at,
       status,
       completed_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10::timestamp, $11, $12::timestamp)
     RETURNING
       order_id,
       product,
       quantity,
       price,
       total,
       request_description,
       customer_name,
       customer_address,
       opened_at,
       created_at,
       status,
       completed_at`,
    [
      order.orderId,
      order.product,
      order.quantity,
      order.price,
      order.total,
      order.requestDescription,
      order.customerName,
      order.customerAddress,
      nullableTimestamp(order.openedAt),
      nullableTimestamp(order.createdAt),
      order.status,
      nullableTimestamp(order.completedAt)
    ]
  );

  return mapOrderRow(result.rows[0]);
}

async function completeOrder(orderId) {
  const existing = await getOrderById(orderId);

  if (!existing) {
    throw new Error("Order not found.");
  }

  if (existing.status === "Completed") {
    throw new Error("Order is already completed.");
  }

  const completedAt = formatDateTime(new Date());
  const result = await getPool().query(
    `UPDATE orders
     SET status = 'Completed', completed_at = $2::timestamp
     WHERE order_id = $1
     RETURNING
       order_id,
       product,
       quantity,
       price,
       total,
       request_description,
       customer_name,
       customer_address,
       opened_at,
       created_at,
       status,
       completed_at`,
    [orderId, completedAt]
  );

  return mapOrderRow(result.rows[0]);
}

async function deleteOrder(orderId) {
  const result = await getPool().query("DELETE FROM orders WHERE order_id = $1 RETURNING order_id", [orderId]);

  if (!result.rowCount) {
    throw new Error("Order not found.");
  }
}

function buildPoolConfig() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  const config = { connectionString };
  if (shouldEnableSsl(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function getPool() {
  if (!pool) {
    throw new Error("Orders store is not initialized.");
  }

  return pool;
}

function shouldEnableSsl(connectionString) {
  if (String(process.env.DATABASE_SSL || "").toLowerCase() === "false") {
    return false;
  }

  if (String(process.env.DATABASE_SSL || "").toLowerCase() === "true") {
    return true;
  }

  const sslMode = String(process.env.PGSSLMODE || "").toLowerCase();
  if (["require", "prefer", "verify-ca", "verify-full"].includes(sslMode)) {
    return true;
  }

  try {
    const url = new URL(connectionString);
    const urlSslMode = String(url.searchParams.get("sslmode") || "").toLowerCase();
    return ["require", "prefer", "verify-ca", "verify-full"].includes(urlSslMode);
  } catch (_error) {
    return false;
  }
}

async function migrateLegacyOrdersIfNeeded() {
  const countResult = await getPool().query("SELECT COUNT(*)::integer AS count FROM orders");
  if (countResult.rows[0].count > 0) {
    return;
  }

  if (!fs.existsSync(LEGACY_ORDERS_JSON_PATH)) {
    return;
  }

  const raw = fs.readFileSync(LEGACY_ORDERS_JSON_PATH, "utf8").trim();
  if (!raw) {
    return;
  }

  const parsed = JSON.parse(raw);
  const sourceOrders = Array.isArray(parsed) ? parsed : [parsed];
  const orders = sourceOrders.map(normalizeLegacyOrder).filter((order) => order.orderId);
  if (!orders.length) {
    return;
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    for (const order of orders) {
      await client.query(
        `INSERT INTO orders (
           order_id,
           product,
           quantity,
           price,
           total,
           request_description,
           customer_name,
           customer_address,
           opened_at,
           created_at,
           status,
           completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10::timestamp, $11, $12::timestamp)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          order.orderId,
          order.product,
          order.quantity,
          order.price,
          order.total,
          order.requestDescription,
          order.customerName,
          order.customerAddress,
          nullableTimestamp(order.openedAt),
          nullableTimestamp(order.createdAt),
          order.status,
          nullableTimestamp(order.completedAt)
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`Imported ${orders.length} legacy orders from ${LEGACY_ORDERS_JSON_PATH}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getOrderById(orderId) {
  const result = await getPool().query(
    `SELECT
       order_id,
       product,
       quantity,
       price,
       total,
       request_description,
       customer_name,
       customer_address,
       opened_at,
       created_at,
       status,
       completed_at
     FROM orders
     WHERE order_id = $1`,
    [orderId]
  );

  return result.rowCount ? mapOrderRow(result.rows[0]) : null;
}

function mapOrderRow(row) {
  return {
    orderId: asString(row.order_id),
    product: asString(row.product),
    quantity: Number.parseInt(row.quantity, 10) || 0,
    price: roundMoney(row.price),
    total: roundMoney(row.total),
    requestDescription: asString(row.request_description),
    customerName: asString(row.customer_name),
    customerAddress: asString(row.customer_address),
    openedAt: formatNullableDateTime(row.opened_at),
    createdAt: formatNullableDateTime(row.created_at),
    status: asString(row.status) || "Open",
    completedAt: formatNullableDateTime(row.completed_at)
  };
}

function normalizeLegacyOrder(order) {
  const openedAt = asString(order.openedAt) || asString(order.createdAt);
  const createdAt = asString(order.createdAt) || openedAt;
  const quantity = Number.parseInt(order.quantity, 10) || 0;
  const price = roundMoney(order.price);

  return {
    orderId: asString(order.orderId),
    product: asString(order.product),
    quantity,
    price,
    total: roundMoney(order.total || quantity * price),
    requestDescription: asString(order.requestDescription),
    customerName: asString(order.customerName),
    customerAddress: asString(order.customerAddress),
    openedAt,
    createdAt,
    status: asString(order.status) || "Open",
    completedAt: asString(order.completedAt)
  };
}

function nullableTimestamp(value) {
  const text = asString(value).trim();
  return text || null;
}

function formatNullableDateTime(value) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return formatDateTime(date);
}

function formatDateTime(value) {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hour = pad(value.getHours());
  const minute = pad(value.getMinutes());
  const second = pad(value.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function roundMoney(value) {
  return Math.round(parseDecimal(value) * 100) / 100;
}

function parseDecimal(value) {
  const normalized = asString(value).trim().replace(/\s+/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value) {
  return value == null ? "" : String(value);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  initializeOrdersStore,
  listOrders,
  createOrder,
  completeOrder,
  deleteOrder
};
