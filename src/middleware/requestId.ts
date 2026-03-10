import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from '../lib/logger';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  res.setHeader('X-Request-ID', requestId);
  res.locals.requestId = requestId;
  res.locals.log = createChildLogger({ requestId });
  next();
}
