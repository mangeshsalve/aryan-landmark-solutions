import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';

/**
 * R2 credentials aren't available yet. Every storage operation checks
 * isConfigured() first and throws this rather than attempting a real
 * Cloudflare call or silently falling back to another provider. 503
 * (not 500) — this is an operational/configuration state, not a code
 * defect, and is expected to resolve once real credentials are supplied.
 */
export class StorageNotConfiguredException extends AppException {
  constructor() {
    super(
      'STORAGE_UPLOAD_FAILED',
      'Cloudflare R2 is not configured. Set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_BUCKET.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
