# ENERGY JEWELRY Orders Web App

Web application for registering ENERGY JEWELRY product orders.

## Current architecture

- `server.js` serves the static UI and the existing API routes.
- `static/` contains the current frontend and does not depend on the storage implementation.
- `db.js` contains the PostgreSQL connection, schema initialization, legacy JSON import, and all order queries.
- `sql/init.sql` contains a provider-neutral PostgreSQL schema for the `orders` table.
- `data/catalog/*_csv.csv` is the product catalog bundled inside `web-app` for deployment.

Orders are now stored in PostgreSQL. Local JSON and XLS files are no longer the source of truth.
The product catalog CSV is now also stored inside `web-app`, so deployments do not depend on sibling folders outside the service root.

## What stays unchanged

- Existing UI
- Product catalog loading from CSV
- Creating an order
- Viewing the order list
- Completing an order
- Deleting an order
- Downloading `/download/product-orders.xls`
- Existing frontend API contracts

## Requirements

- Node.js 20+
- npm
- PostgreSQL доступный по connection string в `DATABASE_URL`

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

### Product catalog location

The catalog is loaded from:

- `data/catalog/*_csv.csv`

This path is fully inside `web-app`, so it is included in Railway and other container deployments even when only `web-app` is used as the service root.

### How database initialization works

The project uses the lowest-risk option: automatic schema initialization at server startup.

At startup the server:

1. connects to PostgreSQL using `DATABASE_URL`
2. executes `sql/init.sql`
3. checks whether the `orders` table is empty
4. if the table is empty and `data/product-orders.json` exists, imports legacy orders once
5. starts the web server

Because the import runs only when the table is empty, repeated restarts do not duplicate orders.

## Database structure

Table: `orders`

- `order_id` - unique primary key
- `product` - product name
- `quantity` - integer quantity
- `price` - `NUMERIC(12,2)`
- `total` - `NUMERIC(12,2)`
- `request_description` - request text
- `customer_name` - customer name
- `customer_address` - customer address
- `opened_at` - `TIMESTAMP`
- `created_at` - `TIMESTAMP`
- `status` - `Open` or `Completed`
- `completed_at` - nullable `TIMESTAMP`

Sort order is preserved exactly as before:

1. open orders first
2. completed orders after them
3. inside each group, newer `opened_at` first

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

This means the app is safe for restarts on ephemeral platforms such as Render Web Service.

## XLS export

Route:

- `/download/product-orders.xls`

Behavior:

- The file is generated on demand from PostgreSQL data.
- The response is returned directly to the browser.
- No local XLS file is required as persistent storage.

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

### Free Render limitations to keep in mind

- Free Web Services can sleep after inactivity.
- The local filesystem is ephemeral and must not be used for important order data.
- The service can restart at any time.
- All important data must live in PostgreSQL.

This project is designed around those constraints: orders persist in PostgreSQL, while XLS is generated per request.

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

### Why the previous Railway error is fixed

Railway deploys only the selected service directory. The app previously looked for the catalog in a sibling folder outside `web-app`, which produced:

```text
CSV catalog directory was not found: /CSV_Export
```

The app now loads the catalog from `web-app/data/catalog`, so the CSV is packaged with the service and available inside the Railway container.

## PostgreSQL provider portability

The app is not tied to Render Postgres.

It works with any PostgreSQL provider that gives you a standard connection string in `DATABASE_URL`, including:

- Render Postgres
- Neon
- Supabase
- Railway
- local PostgreSQL
- any managed PostgreSQL with a regular connection URL

To move from one provider to another, update `DATABASE_URL` and migrate the data. The frontend and business logic do not need to change.

## Files changed for the PostgreSQL migration

Updated:

- `server.js` - server routes now use PostgreSQL for order operations
- `package.json` - added PostgreSQL dependency
- `README.md` - updated local run and deployment instructions

Added:

- `db.js` - isolated PostgreSQL data-access layer
- `sql/init.sql` - schema initialization script
- `.env.example` - example environment variables
