import { Request } from 'express';
import { AnyJwtPayload } from './jwt-payload.interface';

export interface AuthenticatedRequest extends Request {
  user: AnyJwtPayload;
}
