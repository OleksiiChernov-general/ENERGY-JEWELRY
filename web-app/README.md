# ENERGY JEWELRY Orders Web App

Web application for registering ENERGY JEWELRY product orders.

## Current architecture

- `server.js` serves the static UI and the existing API routes.
- `static/` contains the frontend, including the Home Screen manifest and icons.
- `db.js` contains the PostgreSQL connection, schema initialization, legacy JSON import, and all order queries.
- `sql/init.sql` contains a provider-neutral PostgreSQL schema for the `orders` table.
- `data/catalog/*_csv.csv` is the product catalog bundled inside `web-app` for deployment.

Orders are stored in PostgreSQL. Local JSON and XLS files are not the source of truth.
The product catalog CSV is stored inside `web-app`, so deployments do not depend on sibling folders outside the service root.

## What stays unchanged

- Existing UI structure and visual style
- Product catalog loading from CSV
- Creating an order
- Viewing the order list
- Completing an order
- Deleting an order
- Downloading `/download/product-orders.xls`
- Existing frontend API routes

## New additions

- `Себестоимость` field in the order form
- `Общая прибыль` metric in the top ENERGY JEWELRY block
- `Cost TL` and `Profit TL` columns in the XLS export
- Home Screen support via `manifest.json`
- App icons:
  `static/icons/amethyst-192.png`
  `static/icons/amethyst-512.png`

## Requirements

- Node.js 20+
- npm
- PostgreSQL available via `DATABASE_URL`

## Environment variables

Required:

- `DATABASE_URL` - PostgreSQL connection string, for example `postgres://user:password@host:5432/dbname`

Optional:

- `PORT` - local port, default `8086`
- `DATABASE_SSL=true` - force TLS for providers that require SSL when the URL does not already include `sslmode=require`

If `DATABASE_URL` is missing, the server stops at startup with a clear error:

```text
DATABASE_URL environment variable is required.
```

## Local run

1. Install dependencies:

```bash
cd "ENERGY JEWELRY/web-app"
npm install
```

2. Set `DATABASE_URL`.

macOS/Linux:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/energy_jewelry"
```

PowerShell:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/energy_jewelry"
```

3. Start the app:

```bash
npm start
```

4. Open:

```text
http://localhost:8086
```

## Product catalog location

The catalog is loaded from:

- `data/catalog/*_csv.csv`

This path is fully inside `web-app`, so it is included in Railway and other container deployments even when only `web-app` is used as the service root.

## Database initialization and compatibility

At startup the server:

1. connects to PostgreSQL using `DATABASE_URL`
2. executes `sql/init.sql`
3. checks whether the `orders` table is empty
4. if the table is empty and `data/product-orders.json` exists, imports legacy orders once
5. starts the web server

Because the import runs only when the table is empty, repeated restarts do not duplicate orders.

The schema now includes `cost_tl` and uses a safe migration:

```sql
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS cost_tl NUMERIC(12, 2) NOT NULL DEFAULT 0;
```

This keeps old orders valid. Existing rows automatically work with `cost_tl = 0`.

## Database structure

Table: `orders`

- `order_id` - unique primary key
- `product` - product name
- `quantity` - integer quantity
- `cost_tl` - `NUMERIC(12,2)`, default `0`
- `price` - `NUMERIC(12,2)`
- `total` - `NUMERIC(12,2)`
- `request_description` - request text
- `customer_name` - customer name
- `customer_address` - customer address
- `opened_at` - `TIMESTAMP`
- `created_at` - `TIMESTAMP`
- `status` - `Open` or `Completed`
- `completed_at` - nullable `TIMESTAMP`

Sort order is preserved:

1. open orders first
2. completed orders after them
3. inside each group, newer `opened_at` first

## Profit calculation

Profit is calculated as:

```text
(Price TL - Cost TL) × Quantity
```

The top `Общая прибыль` metric sums that value across the orders currently shown in the UI.
For old orders that were created before `cost_tl` existed, `cost_tl` is treated as `0`.

## JSON to PostgreSQL migration

Legacy file:

- `data/product-orders.json`

Migration behavior:

- The file is treated only as a one-time import source.
- Import happens only if the PostgreSQL table `orders` is empty.
- Each imported row is inserted by `order_id`.
- The import uses `ON CONFLICT (order_id) DO NOTHING`, so duplicate IDs are not inserted.
- After a successful import, PostgreSQL becomes the only primary storage.
- The JSON file is not updated anymore and is not used for runtime reads.

## XLS export

Route:

- `/download/product-orders.xls`

Behavior:

- The file is generated on demand from PostgreSQL data.
- The response is returned directly to the browser.
- The export now includes `Cost TL` and `Profit TL`.

## Home Screen / PWA support

The app now includes:

- `static/manifest.json`
- `static/icons/amethyst-192.png`
- `static/icons/amethyst-512.png`

`index.html` connects the manifest, theme color, and Apple mobile web app tags so the app can be added to the phone Home Screen.

## Deploy to Railway

Recommended setup:

- deploy the service from `ENERGY JEWELRY/web-app`
- use PostgreSQL provided by Railway or any external PostgreSQL

### Railway settings

- Root Directory: `ENERGY JEWELRY/web-app`
- Build Command: `npm install`
- Start Command: `npm start`

### Required environment variables on Railway

- `DATABASE_URL` - PostgreSQL connection string

Optional:

- `DATABASE_SSL=true` if your PostgreSQL provider requires TLS and the URL does not already include SSL settings

### Why the previous Railway catalog error is fixed

Railway deploys only the selected service directory. The app previously looked for the catalog in a sibling folder outside `web-app`, which produced:

```text
CSV catalog directory was not found: /CSV_Export
```

The app now loads the catalog from `web-app/data/catalog`, so the CSV is packaged with the service and available inside the Railway container.

## Deploy to Render Free Web Service

Recommended target:

- Render `Web Service`
- free plan
- no Docker required

### Render settings

- Root Directory: `ENERGY JEWELRY/web-app`
- Build Command: `npm install`
- Start Command: `npm start`

### Required environment variables on Render

- `DATABASE_URL` - external PostgreSQL connection string

Optional:

- `DATABASE_SSL=true` if your PostgreSQL provider requires TLS and the URL does not already include SSL settings

You do not need to set `PORT` manually. Render injects it automatically.

## PostgreSQL provider portability

The app is not tied to Render Postgres.

It works with any PostgreSQL provider that gives you a standard connection string in `DATABASE_URL`, including:

- Render Postgres
- Neon
- Supabase
- Railway
- local PostgreSQL
- any managed PostgreSQL with a regular connection URL

## Files added in this stage

- `static/manifest.json`
- `static/icons/amethyst-192.png`
- `static/icons/amethyst-512.png`

## Files updated in this stage

- `server.js`
- `db.js`
- `sql/init.sql`
- `static/index.html`
- `static/app.js`
- `static/styles.css`
- `README.md`
