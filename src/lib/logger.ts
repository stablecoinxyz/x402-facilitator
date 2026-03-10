import pino from 'pino';

const logger = pino({
  name: 'x402-facilitator',
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization'],
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export default logger;
