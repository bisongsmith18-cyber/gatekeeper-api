import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { z } from 'zod';

const eventStatusSchema = z.enum(['on_sale', 'sold_out', 'cancelled']);
const bookingStatusSchema = z.enum(['confirmed', 'cancelled']);

const createEventSchema = z.object({
  name: z.string().trim().min(1).max(150),
  venue: z.string().trim().min(1).max(150),
  starts_at: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(0).max(2147483647),
});

const createBookingSchema = z.object({
  customer_id: z.number().int().positive().max(2147483647),
  quantity: z.number().int().min(1).max(10),
});

const idSchema = z.coerce.number().int().positive().max(2147483647);
const paginationSchema = z.object({
  after: z.coerce.number().int().min(0).max(2147483647).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'bad_request', 'Request validation failed.');
  }
  return result.data;
}

function toBooking(row) {
  return { ...row, status: bookingStatusSchema.parse(row.status) };
}

function toEvent(row) {
  return { ...row, status: eventStatusSchema.parse(row.status) };
}

async function loadOpenApiSpec() {
  const specUrl = new URL('../openapi.yaml', import.meta.url);
  const contents = await readFile(fileURLToPath(specUrl), 'utf8');
  return YAML.parse(contents);
}

export async function createApp(pool) {
  const app = express();
  const openApiSpec = await loadOpenApiSpec();

  app.use(express.json({ limit: '16kb' }));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.get('/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.status(200).json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error);
      response.status(503).json({
        error: { code: 'service_unavailable', message: 'The database is unavailable.' },
      });
    }
  });

  app.post('/events', async (request, response, next) => {
    try {
      const event = parseOrThrow(createEventSchema, request.body);
      const status = event.capacity === 0 ? 'sold_out' : 'on_sale';
      const result = await pool.query(
        `INSERT INTO events
          (name, venue, starts_at, capacity, seats_remaining, status)
         VALUES ($1, $2, $3, $4, $4, $5)
         RETURNING id, name, venue, starts_at, capacity, seats_remaining, status`,
        [event.name, event.venue, event.starts_at, event.capacity, status],
      );
      response.status(201).json({ event: toEvent(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/events', async (request, response, next) => {
    try {
      const { after, limit } = parseOrThrow(paginationSchema, request.query);
      const result = await pool.query(
        `SELECT id, name, venue, starts_at, capacity, seats_remaining, status
         FROM events
         WHERE id > $1
         ORDER BY id
         LIMIT $2`,
        [after, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      response.status(200).json({
        items: rows.map(toEvent),
        next_cursor: hasMore ? rows.at(-1).id : null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/events/:id', async (request, response, next) => {
    try {
      const id = parseOrThrow(idSchema, request.params.id);
      const result = await pool.query(
        `SELECT id, name, venue, starts_at, capacity, seats_remaining, status
         FROM events
         WHERE id = $1`,
        [id],
      );
      if (result.rowCount === 0) {
        throw new ApiError(404, 'not_found', 'Event not found.');
      }
      response.status(200).json({ event: toEvent(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/events/:id/bookings', async (request, response, next) => {
    let client;
    let transactionStarted = false;

    try {
      const eventId = parseOrThrow(idSchema, request.params.id);
      const booking = parseOrThrow(createBookingSchema, request.body);
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;

      const customer = await client.query(
        'SELECT id FROM customers WHERE id = $1 FOR KEY SHARE',
        [booking.customer_id],
      );
      if (customer.rowCount === 0) {
        throw new ApiError(400, 'unknown_customer', 'Customer not found.');
      }

      const event = await client.query(
        `UPDATE events
         SET seats_remaining = seats_remaining - $2,
             status = CASE
               WHEN seats_remaining - $2 = 0 THEN 'sold_out'
               ELSE status
             END
         WHERE id = $1
           AND status = 'on_sale'
           AND seats_remaining >= $2
         RETURNING id`,
        [eventId, booking.quantity],
      );

      if (event.rowCount === 0) {
        const currentEvent = await client.query(
          'SELECT status FROM events WHERE id = $1',
          [eventId],
        );
        if (currentEvent.rowCount === 0) {
          throw new ApiError(404, 'not_found', 'Event not found.');
        }
        if (currentEvent.rows[0].status === 'cancelled') {
          throw new ApiError(409, 'event_cancelled', 'Event is cancelled.');
        }
        throw new ApiError(409, 'not_enough_seats', 'Not enough seats remain.');
      }

      const result = await client.query(
        `INSERT INTO bookings (event_id, customer_id, quantity)
         VALUES ($1, $2, $3)
         RETURNING id, event_id, customer_id, quantity, status, booked_at`,
        [eventId, booking.customer_id, booking.quantity],
      );

      await client.query('COMMIT');
      transactionStarted = false;
      const savedBooking = toBooking(result.rows[0]);
      response
        .status(201)
        .location(`/bookings/${savedBooking.id}`)
        .json({ booking: savedBooking });
    } catch (error) {
      if (client && transactionStarted) {
        await client.query('ROLLBACK');
      }
      next(error);
    } finally {
      client?.release();
    }
  });

  app.post('/bookings/:id/cancel', async (request, response, next) => {
    let client;
    let transactionStarted = false;

    try {
      const bookingId = parseOrThrow(idSchema, request.params.id);
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;

      const result = await client.query(
        `UPDATE bookings
         SET status = 'cancelled'
         WHERE id = $1 AND status = 'confirmed'
         RETURNING event_id, quantity`,
        [bookingId],
      );

      if (result.rowCount === 0) {
        const booking = await client.query(
          'SELECT status FROM bookings WHERE id = $1',
          [bookingId],
        );
        if (booking.rowCount === 0) {
          throw new ApiError(404, 'not_found', 'Booking not found.');
        }
        throw new ApiError(409, 'already_cancelled', 'Booking is already cancelled.');
      }

      const { event_id: eventId, quantity } = result.rows[0];
      await client.query(
        `UPDATE events
         SET seats_remaining = seats_remaining + $2,
             status = CASE
               WHEN status = 'cancelled' THEN status
               ELSE 'on_sale'
             END
         WHERE id = $1`,
        [eventId, quantity],
      );

      await client.query('COMMIT');
      transactionStarted = false;
      response.status(204).end();
    } catch (error) {
      if (client && transactionStarted) {
        await client.query('ROLLBACK');
      }
      next(error);
    } finally {
      client?.release();
    }
  });

  app.get('/bookings/:id', async (request, response, next) => {
    try {
      const id = parseOrThrow(idSchema, request.params.id);
      const result = await pool.query(
        `SELECT id, event_id, customer_id, quantity, status, booked_at
         FROM bookings
         WHERE id = $1`,
        [id],
      );
      if (result.rowCount === 0) {
        throw new ApiError(404, 'not_found', 'Booking not found.');
      }
      response.status(200).json({ booking: toBooking(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/events/:id/bookings', async (request, response, next) => {
    try {
      const eventId = parseOrThrow(idSchema, request.params.id);
      const { after, limit } = parseOrThrow(paginationSchema, request.query);
      const event = await pool.query(
        'SELECT id FROM events WHERE id = $1',
        [eventId],
      );
      if (event.rowCount === 0) {
        throw new ApiError(404, 'not_found', 'Event not found.');
      }

      const result = await pool.query(
        `SELECT id, event_id, customer_id, quantity, status, booked_at
         FROM bookings
         WHERE event_id = $1 AND id > $2
         ORDER BY id
         LIMIT $3`,
        [eventId, after, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      response.status(200).json({
        items: rows.map(toBooking),
        next_cursor: hasMore ? rows.at(-1).id : null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: 'not_found', message: 'Route not found.' },
    });
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      response.status(400).json({
        error: { code: 'bad_request', message: 'Request body must be valid JSON.' },
      });
      return;
    }
    if (error?.type === 'entity.too.large') {
      response.status(413).json({
        error: { code: 'payload_too_large', message: 'Request body is too large.' },
      });
      return;
    }
    console.error(error);
    response.status(500).json({
      error: { code: 'internal_error', message: 'An unexpected error occurred.' },
    });
  });

  return app;
}
