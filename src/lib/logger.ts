import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

const logger = pino({
  name: 'x402-facilitator',
  level: isTest ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  redact: ['req.headers.authorization'],
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export default logger;
