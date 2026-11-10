import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: config.DATABASE_URL });
const schemaUrl = new URL('../db/schema.sql', import.meta.url);
const seedUrl = new URL('../db/seed.sql', import.meta.url);

try {
  const schema = await readFile(fileURLToPath(schemaUrl), 'utf8');
  const seed = await readFile(fileURLToPath(seedUrl), 'utf8');

  await pool.query(schema);
  await pool.query(seed);
  console.log('Database schema and sample customers are ready.');
} catch (error) {
  console.error('Database setup failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
