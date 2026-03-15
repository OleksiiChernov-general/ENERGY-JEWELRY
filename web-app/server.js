const express = require("express");
const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const {
  initializeOrdersStore,
  listOrders,
  createOrder,
  completeOrder,
  deleteOrder
} = require("./db");

const app = express();

const PORT = Number(process.env.PORT || 8086);
const HOST = "0.0.0.0";

const APP_ROOT = __dirname;
const STATIC_ROOT = path.join(APP_ROOT, "static");
const DATA_ROOT = path.join(APP_ROOT, "data");
const PRODUCTS_DIR = path.join(DATA_ROOT, "catalog");
const PRODUCTS_CSV_PATH = resolveProductsCsvPath();

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

app.get("/api/orders", async (_req, res) => {
  try {
    res.json({
      items: await listOrders(),
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load orders." });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const order = buildOrder(req.body || {});
    const savedOrder = await createOrder(order);

    res.status(201).json({
      item: savedOrder,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(error.message === "DATABASE_URL environment variable is required." ? 500 : 400).json({
      error: error.message
    });
  }
});

app.post("/api/orders/:orderId/complete", async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    const order = await completeOrder(orderId);

    res.json({
      item: order,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/orders/:orderId/cancel", async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "");
    await deleteOrder(orderId);

    res.json({
      removedOrderId: orderId,
      workbook: "/download/product-orders.xls"
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/download/product-orders.xls", async (_req, res) => {
  try {
    const orders = await listOrders();
    const xml = buildSpreadsheetXml(orders);

    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="product-orders.xls"');
    res.send(xml);
  } catch (error) {
    res.status(500).json({ error: "Failed to build workbook." });
  }
});

startServer();

async function startServer() {
  try {
    await initializeOrdersStore();

    app.listen(PORT, HOST, () => {
      console.log(`Product order app started at http://${HOST}:${PORT}`);
      console.log(`Catalog source: ${PRODUCTS_CSV_PATH}`);
      console.log("Orders storage: PostgreSQL via DATABASE_URL");
      console.log("Workbook route: /download/product-orders.xls");
    });
  } catch (error) {
    console.error("Application startup failed.");
    console.error(error.message);
    process.exit(1);
  }
}

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
  return formatDateTime(new Date());
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

function formatDateTime(value) {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hour = pad(value.getHours());
  const minute = pad(value.getMinutes());
  const second = pad(value.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
