export interface UploadAuthorization {
  uploadUrl: string;
  r2ObjectKey: string;
  expiresIn: number;
}

export interface ObjectVerificationResult {
  exists: boolean;
  sizeBytes?: number;
}

/**
 * Storage abstraction — attachment business logic (AttachmentsService)
 * depends on this, never on the Cloudflare/AWS SDK directly. Swapping the
 * concrete implementation (or adding a second provider later) doesn't
 * touch anything outside src/storage/.
 */
export abstract class StorageService {
  abstract isConfigured(): boolean;

  abstract createUploadAuthorization(params: {
    objectKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<UploadAuthorization>;

  abstract verifyObject(params: {
    objectKey: string;
    expectedSizeBytes?: number;
  }): Promise<ObjectVerificationResult>;

  abstract deleteObject(objectKey: string): Promise<void>;

  abstract getBucketName(): string | undefined;

  abstract getPublicUrl(objectKey: string): string | undefined;
}
