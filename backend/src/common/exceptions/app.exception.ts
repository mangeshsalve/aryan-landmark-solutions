import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Carries one of the documented error codes from
 * docs/api/api-conventions.md so the global exception filter can emit the
 * exact `error.code` the API contract promises, instead of falling back
 * to a generic per-status-code mapping.
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus,
  ) {
    super({ code, message }, status);
  }
}

export class InvalidCredentialsException extends AppException {
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Invalid credentials.', HttpStatus.UNAUTHORIZED);
  }
}

export class AuthTokenInvalidException extends AppException {
  constructor(message = 'Authentication token is missing or invalid.') {
    super('AUTH_TOKEN_INVALID', message, HttpStatus.UNAUTHORIZED);
  }
}

export class MasterAccessRequiredException extends AppException {
  constructor() {
    super(
      'AUTH_MASTER_ACCESS_REQUIRED',
      'A valid master-scoped token is required for this resource.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class ForbiddenRoleException extends AppException {
  constructor() {
    super('FORBIDDEN', 'You do not have permission to access this resource.', HttpStatus.FORBIDDEN);
  }
}

export class CustomerNotFoundException extends AppException {
  constructor() {
    super('CUSTOMER_NOT_FOUND', 'Customer not found.', HttpStatus.NOT_FOUND);
  }
}

export class CustomerDuplicateException extends AppException {
  constructor(message = 'A customer with this mobile or email already exists.') {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export class PropertyNotFoundException extends AppException {
  constructor() {
    super('PROPERTY_NOT_FOUND', 'Property not found.', HttpStatus.NOT_FOUND);
  }
}

export class PropertyDuplicateException extends AppException {
  constructor(message = 'A property with this property code already exists.') {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export class AttachmentNotFoundException extends AppException {
  constructor() {
    super('ATTACHMENT_NOT_FOUND', 'Attachment not found.', HttpStatus.NOT_FOUND);
  }
}

export class FileTypeNotAllowedException extends AppException {
  constructor(message = 'This file type is not allowed for the given attachment type.') {
    super('FILE_TYPE_NOT_ALLOWED', message, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  }
}

export class FileSizeLimitExceededException extends AppException {
  constructor(message = 'File size exceeds the configured limit.') {
    super('FILE_SIZE_LIMIT_EXCEEDED', message, HttpStatus.PAYLOAD_TOO_LARGE);
  }
}

export class StorageFinalizationFailedException extends AppException {
  constructor(message = 'The uploaded object could not be verified in storage.') {
    super('STORAGE_FINALIZATION_FAILED', message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class AttachmentRelationshipInvalidException extends AppException {
  constructor(message: string) {
    super('VALIDATION_ERROR', message, HttpStatus.BAD_REQUEST);
  }
}
