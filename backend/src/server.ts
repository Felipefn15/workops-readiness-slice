import { buildApp } from './app.js';
import { DATABASE_URL, PORT } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const db = createPool(DATABASE_URL);
await migrate(db);
const app = buildApp(db, { logger: true });
await app.listen({ port: PORT, host: '0.0.0.0' });
