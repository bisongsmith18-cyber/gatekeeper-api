# Gatekeeper API

A small Node.js and PostgreSQL API for events and ticket bookings. Booking and
cancellation use database transactions, and a conditional update protects the
seat counter from concurrent bookings.

## Requirements

- Node.js 20.6 or newer
- PostgreSQL 13 or newer

## Set up locally

Create two PostgreSQL databases, one for the API and one disposable database for
tests:

```sh
createdb gatekeeper
createdb gatekeeper_test
```

Copy `.env.example` to `.env` and set `DATABASE_URL` and `TEST_DATABASE_URL` to
the connection strings for those databases. Then install dependencies and
create the tables and sample customers:

```sh
npm ci
npm run db:setup
npm start
```

The API listens on port 3000 by default. Set `PORT` to change it. The sample
customers are `customer@example.com` (ID 1) and `second@example.com` (ID 2) in
a freshly created database. Use the actual IDs returned by PostgreSQL if the
database already had customer rows.

## API

Interactive documentation is served at `/docs`; liveness and database
availability are checked at `/health`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/events` | Create an event |
| `GET` | `/events?after=&limit=` | List events using an ID cursor |
| `GET` | `/events/:id` | Get event details and remaining seats |
| `POST` | `/events/:id/bookings` | Book 1–10 tickets |
| `GET` | `/events/:id/bookings?after=&limit=` | List bookings using an ID cursor |
| `GET` | `/bookings/:id` | Get a booking |
| `POST` | `/bookings/:id/cancel` | Cancel a booking and return its seats |

Collection responses have `items` and `next_cursor`. Pass the returned cursor
as `after` to fetch the next page; a `null` cursor means there are no more
results. The default page size is 20 and the maximum is 100.

Booking input is `{"customer_id": 1, "quantity": 2}`. Create customers directly
in PostgreSQL; this API deliberately has no customer-management endpoint.
Invalid input and unknown customers return `400`; missing resources return
`404`; insufficient seats, cancelled events, and repeated cancellations return
`409`. A successful booking returns `201` and a `Location` header. Successful
cancellation returns `204`.

## Tests

Tests only run when `TEST_DATABASE_URL` points to a database whose name ends in
`_test`. The suite creates the schema and clears its event, customer, and
booking tables between tests. **Use a disposable test database; its data will
be erased.**

```sh
npm test
```

The tests cover API responses and pagination, concurrent attempts for the
last seat, rollback after a simulated insert failure, cancellation, and a SQL
injection regression check. The test process closes its HTTP server and
PostgreSQL pool when it finishes.

## Deploy to Render

The included `render.yaml` defines a web service and PostgreSQL database.
Create a public GitHub repository, push this branch, then connect that
repository in the Render dashboard and deploy the Blueprint. Render supplies
`DATABASE_URL`; the start command applies the schema and sample seed before
starting the API. After deployment, set the deployed service URL as the
`servers` URL in `openapi.yaml` if you want Swagger UI to issue live requests.

## Project layout

- `src/` — API routes, configuration, and database connection
- `db/` — PostgreSQL schema and sample customer seed
- `test/` — `node:test` integration tests
- `scripts/` — database setup command
- `openapi.yaml` — API contract used by Swagger UI
- `render.yaml` — Render Blueprint
