import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
  ),
});

const result = configSchema.safeParse(process.env);
if (!result.success) {
  throw new Error('Invalid configuration: set a valid PORT and PostgreSQL DATABASE_URL.');
}

export const config = result.data;
