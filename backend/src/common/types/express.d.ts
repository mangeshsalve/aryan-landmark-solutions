// pino-http (used by nestjs-pino) assigns `req.id` at runtime via genReqId.
// This augmentation makes that explicit for our own code/type-checking,
// independent of whichever version of pino-http's own types are resolved.
import 'express';

declare module 'express' {
  interface Request {
    id?: string | number;
  }
}
