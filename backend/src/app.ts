import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { authHook } from './auth.js';
import { HttpError } from './errors.js';
import { submissionRoutes } from './routes/submissions.js';
import { reviewRoutes } from './routes/reviews.js';
import { assignmentRoutes } from './routes/assignments.js';
import { readinessRoutes } from './routes/readiness.js';
import { scheduleRoutes } from './routes/schedule.js';

export function buildApp(db: Db, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorateRequest('actor', null);
  app.addHook('preHandler', authHook(db));

  // One error shape everywhere: { error: { code, message, details? } }
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'invalid_input', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    // Database backstops (see 002_integrity_triggers.sql) — reached only if app-level checks were bypassed or raced.
    switch (err?.code) {
      case 'WK007': return reply.status(403).send({ error: { code: 'reviewer_not_independent', message: 'Reviewer must differ from whoever submitted or captured this version (R7)' } });
      case 'WK010': return reply.status(409).send({ error: { code: 'capacity_exceeded', message: 'Appointment is full (R10)' } });
      case '23505': return reply.status(409).send({ error: { code: 'conflict', message: 'Conflicting write', details: err.constraint } });
      case '23503': case '23514': return reply.status(400).send({ error: { code: 'invalid_input', message: 'Violates a data constraint', details: err.constraint } });
    }
    if (err?.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'invalid_input', message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } }));

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));
  app.register(async (i) => submissionRoutes(i, db));
  app.register(async (i) => reviewRoutes(i, db));
  app.register(async (i) => assignmentRoutes(i, db));
  app.register(async (i) => readinessRoutes(i, db));
  app.register(async (i) => scheduleRoutes(i, db));
  return app;
}
