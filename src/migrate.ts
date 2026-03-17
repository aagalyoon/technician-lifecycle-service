import fs from 'fs';
import path from 'path';
import { getPool, closePool } from './models/database';
import { logger } from './config/logger';

async function migrate() {
  const pool = getPool();
  // When compiled, __dirname is dist/src. Migrations live at project root /app/migrations.
  const migrationsDir = path.resolve(__dirname, '..', '..', 'migrations');

  // Create migrations tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );

    if (rows.length > 0) {
      logger.info({ file }, 'Migration already applied, skipping');
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info({ file }, 'Applying migration');

    await pool.query(sql);
    await pool.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [file]
    );

    logger.info({ file }, 'Migration applied successfully');
  }

  await closePool();
  logger.info('All migrations complete');
}

migrate().catch((err) => {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
});
