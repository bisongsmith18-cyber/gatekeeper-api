import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { createApp } from '../src/app.js';

const { Pool } = pg;
const testDatabaseUrlResult = z.string().url().safeParse(process.env.TEST_DATABASE_URL);

if (!testDatabaseUrlResult.success) {
  throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database ending in _test.');
}

const testDatabaseUrl = testDatabaseUrlResult.data;
const testDatabase = new URL(testDatabaseUrl);
if (!testDatabase.pathname.slice(1).endsWith('_test')) {
  throw new Error('Refusing to run tests: TEST_DATABASE_URL must target a database ending in _test.');
}
if (process.env.DATABASE_URL === testDatabaseUrl) {
  throw new Error('Refusing to run tests against DATABASE_URL.');
}

const pool = new Pool({ connectionString: testDatabaseUrl });
let server;
let baseUrl;
let customerIds;

async function createEvent(capacity = 5, name = 'Test concert') {
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      venue: 'Test venue',
      starts_at: '2030-01-01T18:00:00Z',
      capacity,
    }),
  });
  return { response, body: await response.json() };
}

async function book(eventId, customerId, quantity = 1) {
  return fetch(`${baseUrl}/events/${eventId}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, quantity }),
  });
}

before(async () => {
  const schemaUrl = new URL('../db/schema.sql', import.meta.url);
  const schema = await readFile(fileURLToPath(schemaUrl), 'utf8');
  await pool.query(schema);

  const app = await createApp(pool);
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE bookings, customers, events RESTART IDENTITY CASCADE');
  const customers = await pool.query(
    `INSERT INTO customers (full_name, email)
     VALUES ('First Customer', 'first@example.com'),
            ('Second Customer', 'second@example.com')
     RETURNING id`,
  );
  customerIds = customers.rows.map((row) => row.id);
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await pool.end();
});

test('health and interactive API documentation are available', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const docs = await fetch(`${baseUrl}/docs/`);
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-type'), /text\/html/);
});

test('creates and paginates events, and reports missing events', async () => {
  const invalid = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '', venue: 'Test venue', starts_at: 'tomorrow', capacity: -1 }),
  });
  assert.equal(invalid.status, 400);

  const first = await createEvent(5);
  const second = await createEvent(5);
  const third = await createEvent(5);
  assert.equal(first.response.status, 201);

  const firstPage = await fetch(`${baseUrl}/events?limit=2`);
  const firstPageBody = await firstPage.json();
  assert.equal(firstPage.status, 200);
  assert.equal(firstPageBody.items.length, 2);
  assert.equal(firstPageBody.next_cursor, second.body.event.id);

  const secondPage = await fetch(`${baseUrl}/events?after=${firstPageBody.next_cursor}&limit=2`);
  const secondPageBody = await secondPage.json();
  assert.deepEqual(
    secondPageBody.items.map((event) => event.id),
    [third.body.event.id],
  );
  assert.equal(secondPageBody.next_cursor, null);

  const event = await fetch(`${baseUrl}/events/${first.body.event.id}`);
  assert.equal(event.status, 200);
  assert.equal((await event.json()).event.seats_remaining, 5);
  assert.equal((await fetch(`${baseUrl}/events/999`)).status, 404);
});

test('books tickets, lists bookings, and cancels exactly once', async () => {
  const { body: createdEvent } = await createEvent(2);
  const bookingResponse = await book(createdEvent.event.id, customerIds[0], 2);
  const booking = (await bookingResponse.json()).booking;

  assert.equal(bookingResponse.status, 201);
  assert.equal(bookingResponse.headers.get('location'), `/bookings/${booking.id}`);

  const event = await fetch(`${baseUrl}/events/${createdEvent.event.id}`);
  assert.equal((await event.json()).event.seats_remaining, 0);

  const bookingPage = await fetch(`${baseUrl}/events/${createdEvent.event.id}/bookings?limit=1`);
  assert.equal((await bookingPage.json()).items[0].id, booking.id);
  assert.equal((await fetch(`${baseUrl}/bookings/${booking.id}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/events/999/bookings`)).status, 404);
  assert.equal((await book(createdEvent.event.id, customerIds[1])).status, 409);

  const cancel = await fetch(`${baseUrl}/bookings/${booking.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 204);
  const restoredEvent = await fetch(`${baseUrl}/events/${createdEvent.event.id}`);
  assert.equal((await restoredEvent.json()).event.seats_remaining, 2);
  assert.equal((await fetch(`${baseUrl}/bookings/${booking.id}/cancel`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${baseUrl}/bookings/999/cancel`, { method: 'POST' })).status, 404);
});

test('rejects invalid quantities, unknown customers, and cancelled events', async () => {
  const { body } = await createEvent(3);
  assert.equal((await book(body.event.id, customerIds[0], 0)).status, 400);
  assert.equal((await book(body.event.id, customerIds[0], 11)).status, 400);
  assert.equal((await book(body.event.id, 999)).status, 400);

  await pool.query("UPDATE events SET status = 'cancelled' WHERE id = $1", [body.event.id]);
  assert.equal((await book(body.event.id, customerIds[0])).status, 409);
});

test('simultaneous requests for the last seat cannot oversell', async () => {
  const { body } = await createEvent(1);
  const responses = await Promise.all([
    book(body.event.id, customerIds[0]),
    book(body.event.id, customerIds[1]),
  ]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [201, 409]);
  const event = await pool.query(
    'SELECT seats_remaining FROM events WHERE id = $1',
    [body.event.id],
  );
  assert.equal(event.rows[0].seats_remaining, 0);
  assert.ok(event.rows[0].seats_remaining >= 0);
});

test('rolls back a seat decrement when creating the booking fails', async () => {
  const { body } = await createEvent(2);
  await pool.query('DROP TRIGGER IF EXISTS gatekeeper_test_fail_booking_insert ON bookings');
  await pool.query('DROP FUNCTION IF EXISTS gatekeeper_test_fail_booking_insert()');
  await pool.query(`
    CREATE FUNCTION gatekeeper_test_fail_booking_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'intentional test failure';
    END;
    $$;
  `);
  await pool.query(`
    CREATE TRIGGER gatekeeper_test_fail_booking_insert
    BEFORE INSERT ON bookings
    FOR EACH ROW EXECUTE FUNCTION gatekeeper_test_fail_booking_insert();
  `);

  try {
    assert.equal((await book(body.event.id, customerIds[0])).status, 500);
    const event = await pool.query(
      'SELECT seats_remaining FROM events WHERE id = $1',
      [body.event.id],
    );
    assert.equal(event.rows[0].seats_remaining, 2);
    const bookings = await pool.query('SELECT count(*)::int AS count FROM bookings');
    assert.equal(bookings.rows[0].count, 0);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS gatekeeper_test_fail_booking_insert ON bookings');
    await pool.query('DROP FUNCTION IF EXISTS gatekeeper_test_fail_booking_insert()');
  }
});

test('treats SQL injection text as ordinary event data', async () => {
  const injection = "Concert'); DROP TABLE customers; --";
  const { response, body } = await createEvent(3, injection);

  assert.equal(response.status, 201);
  assert.equal(body.event.name, injection);
  const customers = await pool.query('SELECT count(*)::int AS count FROM customers');
  assert.equal(customers.rows[0].count, 2);
});
