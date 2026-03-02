import { Pool } from 'pg';
import { runMigrations } from './migrations';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool);
    // eslint-disable-next-line no-console
    console.log('Migrations applied successfully');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
