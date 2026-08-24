import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { ObjectVerificationResult, StorageService, UploadAuthorization } from './storage.service';
import { StorageNotConfiguredException } from './storage-not-configured.exception';

const UPLOAD_URL_EXPIRES_IN_SECONDS = 900; // 15 minutes — short-lived per spec

/**
 * Cloudflare R2 is S3-compatible, so the AWS SDK v3 S3 client works
 * against it directly by pointing `endpoint` at R2's account-scoped URL.
 *
 * Critically: the S3Client is constructed lazily, only inside a method
 * that has already passed the isConfigured() check — never in the
 * constructor, and never as a side effect of this service (or the module
 * it belongs to) being instantiated. That means the application starts
 * cleanly with no R2 credentials at all, and no Cloudflare API call is
 * ever made until a real R2-dependent request arrives with real
 * credentials configured.
 */
@Injectable()
export class CloudflareR2StorageService extends StorageService {
  private readonly accountId?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  private readonly bucket?: string;
  private readonly publicBaseUrl?: string;

  constructor(private readonly configService: ConfigService) {
    super();
    const app = this.configService.get<AppConfig>('app');
    this.accountId = app?.r2?.accountId;
    this.accessKeyId = app?.r2?.accessKeyId;
    this.secretAccessKey = app?.r2?.secretAccessKey;
    this.bucket = app?.r2?.bucket;
    this.publicBaseUrl = app?.r2?.publicBaseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.accountId && this.accessKeyId && this.secretAccessKey && this.bucket);
  }

  getBucketName(): string | undefined {
    return this.bucket;
  }

  getPublicUrl(objectKey: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${objectKey}`;
  }

  async createUploadAuthorization(params: {
    objectKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<UploadAuthorization> {
    if (!this.isConfigured()) {
      throw new StorageNotConfiguredException();
    }

    const client = this.buildClient();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
    });

    return {
      uploadUrl,
      r2ObjectKey: params.objectKey,
      expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
    };
  }

  async verifyObject(params: {
    objectKey: string;
    expectedSizeBytes?: number;
  }): Promise<ObjectVerificationResult> {
    if (!this.isConfigured()) {
      throw new StorageNotConfiguredException();
    }

    const client = this.buildClient();
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: params.objectKey }),
      );
      return { exists: true, sizeBytes: head.ContentLength };
    } catch {
      return { exists: false };
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (!this.isConfigured()) {
      throw new StorageNotConfiguredException();
    }

    const client = this.buildClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  private buildClient(): S3Client {
    return new S3Client({
      region: 'auto',
      endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.accessKeyId!,
        secretAccessKey: this.secretAccessKey!,
      },
    });
  }
}
