const express = require("express");
const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const app = express();

const PORT = Number(process.env.PORT || 8086);
const HOST = "0.0.0.0";

const APP_ROOT = __dirname;
const PROJECT_ROOT = path.dirname(APP_ROOT);
const STATIC_ROOT = path.join(APP_ROOT, "static");
const DATA_ROOT = path.join(APP_ROOT, "data");
const PRODUCTS_DIR = path.join(PROJECT_ROOT, "CSV_Export");
const ORDERS_JSON_PATH = path.join(DATA_ROOT, "product-orders.json");
const ORDERS_XLS_PATH = path.join(DATA_ROOT, "product-orders.xls");
const PRODUCTS_CSV_PATH = resolveProductsCsvPath();

fs.mkdirSync(DATA_ROOT, { recursive: true });

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});
app.use(express.static(STATIC_ROOT));

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_ROOT, "index.html"));
});

app.get("/api/products", (_req, res) => {
  res.json({ items: getProductCatalog() });
});

app.get("/api/orders", (_req, res) => {
  res.json({
    items: getSortedOrders(loadOrders()),
    workbook: "/download/product-orders.xls"
  });
});

app.post("/api/orders", (req, res) => {
  try {
    const order = buildOrder(req.body || {});
    const orders = getSortedOrders([...loadOrders(), order]);
    saveOrders(orders);
    exportOrdersWorkbook(orders);

    res.status(201).json({
      item: order,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders/:orderId/complete", (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    const orders = loadOrders();
    const target = orders.find((order) => order.orderId === orderId);

    if (!target) {
      throw new Error("Order not found.");
    }

    if (target.status === "Completed") {
      throw new Error("Order is already completed.");
    }

    target.status = "Completed";
    target.completedAt = timestampNow();

    const sortedOrders = getSortedOrders(orders);
    saveOrders(sortedOrders);
    exportOrdersWorkbook(sortedOrders);

    res.json({
      item: target,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders/:orderId/cancel", (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    const orders = loadOrders();
    const remainingOrders = orders.filter((order) => order.orderId !== orderId);

    if (remainingOrders.length === orders.length) {
      throw new Error("Order not found.");
    }

    const sortedOrders = getSortedOrders(remainingOrders);
    saveOrders(sortedOrders);
    exportOrdersWorkbook(sortedOrders);

    res.json({
      removedOrderId: orderId,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/download/product-orders.xls", (_req, res) => {
  if (!fs.existsSync(ORDERS_XLS_PATH)) {
    exportOrdersWorkbook(loadOrders());
  }

  res.download(ORDERS_XLS_PATH, "product-orders.xls");
});

ensureDataFiles();

app.listen(PORT, HOST, () => {
  console.log(`Product order app started at http://${HOST}:${PORT}`);
  console.log(`Catalog source: ${PRODUCTS_CSV_PATH}`);
  console.log(`Workbook output: ${ORDERS_XLS_PATH}`);
});

function resolveProductsCsvPath() {
  if (!fs.existsSync(PRODUCTS_DIR)) {
    throw new Error(`CSV catalog directory was not found: ${PRODUCTS_DIR}`);
  }

  const match = fs
    .readdirSync(PRODUCTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith("_csv.csv"))
    .map((entry) => path.join(PRODUCTS_DIR, entry.name))
    .sort()[0];

  if (!match) {
    throw new Error(`CSV catalog file was not found in ${PRODUCTS_DIR}`);
  }

  return match;
}

function ensureDataFiles() {
  if (!fs.existsSync(ORDERS_JSON_PATH)) {
    saveOrders([]);
  }

  const normalizedOrders = getSortedOrders(loadOrders());
  saveOrders(normalizedOrders);
  exportOrdersWorkbook(normalizedOrders);
}

function getProductCatalog() {
  const csvBuffer = fs.readFileSync(PRODUCTS_CSV_PATH);
  const csvText = iconv.decode(csvBuffer, "win1251");
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = lines
    .slice(1)
    .map((name) => ({ id: name, name }))
    .filter((item) => item.name);

  const unique = new Map();
  items.forEach((item) => unique.set(item.name, item));

  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function loadOrders() {
  if (!fs.existsSync(ORDERS_JSON_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(ORDERS_JSON_PATH, "utf8").trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map(normalizeOrder);
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_JSON_PATH, `${JSON.stringify(orders, null, 2)}\n`, "utf8");
}

function normalizeOrder(order) {
  const openedAt = asString(order.openedAt) || asString(order.createdAt);
  const createdAt = asString(order.createdAt) || openedAt;
  const status = asString(order.status) || "Open";

  return {
    orderId: asString(order.orderId),
    product: asString(order.product),
    quantity: Number.parseInt(order.quantity, 10) || 0,
    price: roundMoney(order.price),
    total: roundMoney(order.total),
    requestDescription: asString(order.requestDescription),
    customerName: asString(order.customerName),
    customerAddress: asString(order.customerAddress),
    openedAt,
    createdAt,
    status,
    completedAt: asString(order.completedAt)
  };
}

function buildOrder(payload) {
  validateOrderPayload(payload);

  const quantity = Number.parseInt(payload.quantity, 10);
  const price = parseDecimal(payload.price);
  const openedAt = timestampNow();

  return {
    orderId: `ORD-${compactTimestampNow()}`,
    product: asString(payload.product).trim(),
    quantity,
    price: roundMoney(price),
    total: roundMoney(quantity * price),
    requestDescription: asString(payload.requestDescription).trim(),
    customerName: asString(payload.customerName).trim(),
    customerAddress: asString(payload.customerAddress).trim(),
    openedAt,
    createdAt: openedAt,
    status: "Open",
    completedAt: ""
  };
}

function validateOrderPayload(payload) {
  for (const field of ["product", "requestDescription", "customerName", "customerAddress"]) {
    if (!asString(payload[field]).trim()) {
      throw new Error(`Field '${field}' is required.`);
    }
  }

  const productNames = new Set(getProductCatalog().map((item) => item.name));
  if (!productNames.has(asString(payload.product).trim())) {
    throw new Error("Selected product is missing from the CSV catalog.");
  }

  const quantity = Number.parseInt(payload.quantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be greater than zero.");
  }

  const price = parseDecimal(payload.price);
  if (price < 0) {
    throw new Error("Price must not be negative.");
  }
}

function getSortedOrders(orders) {
  return [...orders].sort((left, right) => {
    const leftRank = left.status === "Completed" ? 1 : 0;
    const rightRank = right.status === "Completed" ? 1 : 0;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return compareTimestampsDesc(left.openedAt, right.openedAt);
  });
}

function compareTimestampsDesc(left, right) {
  const leftValue = asString(left);
  const rightValue = asString(right);

  if (leftValue === rightValue) {
    return 0;
  }

  return leftValue < rightValue ? 1 : -1;
}

function exportOrdersWorkbook(orders) {
  const xml = buildSpreadsheetXml(orders);
  fs.writeFileSync(ORDERS_XLS_PATH, xml, "utf8");
}

function buildSpreadsheetXml(orders) {
  const headers = [
    "Order ID",
    "Product",
    "Quantity",
    "Price",
    "Total",
    "Request Description",
    "Customer Name",
    "Customer Address",
    "Opened At",
    "Status",
    "Completed At"
  ];

  const rows = [];
  rows.push('<Row ss:StyleID="Header">');
  for (const header of headers) {
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`);
  }
  rows.push("</Row>");

  for (const order of orders) {
    rows.push("<Row>");
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.orderId)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.product)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="Number">${formatDecimal(order.quantity)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="Number">${formatDecimal(order.price)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="Number">${formatDecimal(order.total)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.requestDescription)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.customerName)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.customerAddress)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.openedAt)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.status)}</Data></Cell>`);
    rows.push(`<Cell><Data ss:Type="String">${escapeXml(order.completedAt)}</Data></Cell>`);
    rows.push("</Row>");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Borders/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#E6D4BC" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Orders">
  <Table>
${rows.join("\n")}
  </Table>
 </Worksheet>
</Workbook>
`;
}

function timestampNow() {
  const value = new Date();
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hour = pad(value.getHours());
  const minute = pad(value.getMinutes());
  const second = pad(value.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function compactTimestampNow() {
  const value = new Date();
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hour = pad(value.getHours());
  const minute = pad(value.getMinutes());
  const second = pad(value.getSeconds());
  const millisecond = String(value.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}${hour}${minute}${second}${millisecond}`;
}

function parseDecimal(value) {
  const normalized = asString(value).trim().replace(/\s+/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized || "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round(parseDecimal(value) * 100) / 100;
}

function formatDecimal(value) {
  return roundMoney(value).toFixed(2);
}

function escapeXml(value) {
  return asString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asString(value) {
  return value == null ? "" : String(value);
}

function pad(value) {
  return String(value).padStart(2, "0");
}
