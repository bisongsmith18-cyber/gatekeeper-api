import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

try {
  const app = await createApp(pool);
  const server = app.listen(config.PORT, () => {
    console.log(`Gatekeeper API listening on port ${config.PORT}.`);
  });

  async function shutdown() {
    server.close(async (error) => {
      if (error) {
        console.error('HTTP server shutdown failed:', error);
        process.exitCode = 1;
      }
      await pool.end();
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Gatekeeper API failed to start:', error);
  await pool.end();
  process.exitCode = 1;
}
