import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: '../shared/src/server/db/schema.ts',
  out: './src/database/migrations',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ?? 'postgresql://polyrouter:polyrouter@localhost:5432/polyrouter',
  },
});
