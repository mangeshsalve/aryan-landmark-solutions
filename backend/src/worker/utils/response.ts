// Reproduces the existing NestJS backend's response envelope exactly —
// see src/common/filters/all-exceptions.filter.ts and every controller's
// `{ success: true, data }` return shape (docs/api/api-conventions.md).
// Not a new format: the existing API is the authority (Step 5).

export function ok<T>(data: T) {
  return { success: true as const, data };
}

export function okPaginated<T>(
  data: T[],
  pagination: { page: number; pageSize: number; total: number; totalPages: number },
) {
  return { success: true as const, data, pagination };
}

/**
 * Mirrors src/common/exceptions/app.exception.ts's AppException base
 * class exactly: a documented `code` (see docs/api/api-conventions.md)
 * plus an HTTP status, carried separately from the generic Error message
 * so the error handler can build the exact same
 * `{ success: false, error: { code, message }, requestId }` shape.
 * Business-specific subclasses (InvalidCredentialsException,
 * CustomerNotFoundException, etc.) are NOT ported in Phase 2 — only the
 * three that this phase's own infrastructure (JWT/auth middleware)
 * actually throws are defined below, matching the real backend's
 * existing classes field-for-field.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Matches AuthTokenInvalidException exactly (code, default message, 401). */
export class AuthTokenInvalidError extends AppError {
  constructor(message = 'Authentication token is missing or invalid.') {
    super('AUTH_TOKEN_INVALID', message, 401);
  }
}

/** Matches MasterAccessRequiredException exactly (code, message, 401). */
export class MasterAccessRequiredError extends AppError {
  constructor() {
    super(
      'AUTH_MASTER_ACCESS_REQUIRED',
      'A valid master-scoped token is required for this resource.',
      401,
    );
  }
}

/** Matches ForbiddenRoleException's default (code, message, 403). */
export class ForbiddenRoleError extends AppError {
  constructor(message = 'You do not have permission to access this resource.') {
    super('FORBIDDEN', message, 403);
  }
}

// --- Phase 3 additions — matches app.exception.ts field-for-field ---

/** Matches InvalidCredentialsException exactly (code, message, 401). */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Invalid credentials.', 401);
  }
}

/**
 * Matches the shape produced by the NestJS global ValidationPipe +
 * AllExceptionsFilter for a request-body validation failure: code
 * VALIDATION_ERROR, status 400 (see mapStatusToCode's BAD_REQUEST case).
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, 400);
  }
}

/**
 * Matches ApplicationUserDuplicateException exactly — code CONFLICT
 * (NOT a bespoke "APPLICATION_USER_DUPLICATE" code), status 409, same
 * default message.
 */
export class ApplicationUserDuplicateError extends AppError {
  constructor(message = 'An application user with this identity already exists.') {
    super('CONFLICT', message, 409);
  }
}

/** Matches UserNotFoundException exactly (code, message, 404). */
export class UserNotFoundError extends AppError {
  constructor(message = 'Referenced user not found.') {
    super('USER_NOT_FOUND', message, 404);
  }
}

// --- Phase 4 additions — matches app.exception.ts field-for-field ---

/** Matches CustomerNotFoundException exactly (code, message, 404). */
export class CustomerNotFoundError extends AppError {
  constructor() {
    super('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
  }
}

/** Matches CustomerDuplicateException exactly (code CONFLICT, 409). */
export class CustomerDuplicateError extends AppError {
  constructor(message = 'A customer with this mobile or email already exists.') {
    super('CONFLICT', message, 409);
  }
}

/** Matches CustomerHasInquiriesException exactly (code CONFLICT, 409). */
export class CustomerHasInquiriesError extends AppError {
  constructor() {
    super(
      'CONFLICT',
      'This customer cannot be deleted because one or more inquiries reference them.',
      409,
    );
  }
}

/** Matches PropertyNotFoundException exactly (code, message, 404). */
export class PropertyNotFoundError extends AppError {
  constructor() {
    super('PROPERTY_NOT_FOUND', 'Property not found.', 404);
  }
}

/** Matches PropertyDuplicateException exactly (code CONFLICT, 409). */
export class PropertyDuplicateError extends AppError {
  constructor(message = 'A property with this property code already exists.') {
    super('CONFLICT', message, 409);
  }
}

/** Matches AttachmentNotFoundException exactly (code, message, 404). */
export class AttachmentNotFoundError extends AppError {
  constructor() {
    super('ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
  }
}

/** Matches FileTypeNotAllowedException exactly (code, message, 415). */
export class FileTypeNotAllowedError extends AppError {
  constructor(message = 'This file type is not allowed for the given attachment type.') {
    super('FILE_TYPE_NOT_ALLOWED', message, 415);
  }
}

/** Matches FileSizeLimitExceededException exactly (code, message, 413). */
export class FileSizeLimitExceededError extends AppError {
  constructor(message = 'File size exceeds the configured limit.') {
    super('FILE_SIZE_LIMIT_EXCEEDED', message, 413);
  }
}

/** Matches StorageFinalizationFailedException exactly (code, message, 422). */
export class StorageFinalizationFailedError extends AppError {
  constructor(message = 'The uploaded object could not be verified in storage.') {
    super('STORAGE_FINALIZATION_FAILED', message, 422);
  }
}

/**
 * Matches StorageNotConfiguredException exactly — same code
 * (STORAGE_UPLOAD_FAILED, reused for every R2-dependent operation
 * including delete, per the Phase 5 flagged decision that no dedicated
 * delete-specific code exists) and 503 status.
 */
export class StorageNotConfiguredError extends AppError {
  constructor() {
    super(
      'STORAGE_UPLOAD_FAILED',
      'Cloudflare R2 is not configured. Set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_BUCKET.',
      503,
    );
  }
}

// --- Phase 5 additions — matches app.exception.ts field-for-field ---

/** Matches InquiryNotFoundException exactly (code, message, 404). */
export class InquiryNotFoundError extends AppError {
  constructor() {
    super('INQUIRY_NOT_FOUND', 'Inquiry not found.', 404);
  }
}

/** Matches InquiryAssignmentInvalidException exactly (code, 400, message required — no default). */
export class InquiryAssignmentInvalidError extends AppError {
  constructor(message: string) {
    super('INQUIRY_ASSIGNMENT_INVALID', message, 400);
  }
}

/** Matches InquiryRecordingRequiredException exactly (code, message, 422). */
export class InquiryRecordingRequiredError extends AppError {
  constructor(
    message = 'At least one RECORDING attachment is required for an inquiry created by an ADMIN.',
  ) {
    super('INQUIRY_RECORDING_REQUIRED', message, 422);
  }
}

/** Matches InquiryAlreadySubmittedException exactly (code CONFLICT, message, 409). */
export class InquiryAlreadySubmittedError extends AppError {
  constructor(message = 'This inquiry has already been submitted.') {
    super('CONFLICT', message, 409);
  }
}

/** Matches FollowUpNotFoundException exactly (code, message, 404). */
export class FollowUpNotFoundError extends AppError {
  constructor() {
    super('FOLLOW_UP_NOT_FOUND', 'Follow-up not found.', 404);
  }
}

// --- Phase 6 additions — matches app.exception.ts field-for-field ---

/** Matches NotificationNotFoundException exactly (code, message, 404). */
export class NotificationNotFoundError extends AppError {
  constructor() {
    super('NOTIFICATION_NOT_FOUND', 'Notification not found.', 404);
  }
}

// --- Phase 36 addition — no NestJS equivalent to port (the legacy
// NestJS app's @nestjs/throttler is a separate, unrelated codepath) ---

/**
 * Thrown by routes/auth.ts when a Cloudflare Rate Limiting binding
 * rejects a login attempt (see the two `ratelimits` bindings in
 * wrangler.production.jsonc). Message is deliberately generic — it must
 * never reveal which email/account was targeted, nor any internal
 * limiter detail (current count, reset time, which of the two limiters
 * tripped) — same "don't leak which part of the attempt failed"
 * principle as InvalidCredentialsError.
 */
export class RateLimitedError extends AppError {
  // Phase 45F: optional message so non-login rate limiters (e.g. the
  // public inquiry endpoints) can surface context-appropriate text
  // instead of this login-specific default. Existing login callers pass
  // no argument and are unaffected.
  constructor(message = 'Too many login attempts. Please try again later.') {
    super('RATE_LIMITED', message, 429);
  }
}
