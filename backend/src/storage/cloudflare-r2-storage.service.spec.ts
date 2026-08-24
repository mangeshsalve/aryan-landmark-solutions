import { ConfigService } from '@nestjs/config';
import { CloudflareR2StorageService } from './cloudflare-r2-storage.service';
import { StorageNotConfiguredException } from './storage-not-configured.exception';

describe('CloudflareR2StorageService (unconfigured state)', () => {
  function build(r2: Record<string, string | undefined>) {
    const configService = { get: () => ({ r2 }) } as unknown as ConfigService;
    return new CloudflareR2StorageService(configService);
  }

  it('reports not configured when no R2 env vars are set', () => {
    const service = build({});
    expect(service.isConfigured()).toBe(false);
  });

  it('reports not configured when only some R2 env vars are set', () => {
    const service = build({ accountId: 'acc', accessKeyId: 'key' });
    expect(service.isConfigured()).toBe(false);
  });

  it('reports configured only when all four required values are present', () => {
    const service = build({
      accountId: 'acc',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'bucket',
    });
    expect(service.isConfigured()).toBe(true);
  });

  it('throws StorageNotConfiguredException from every operation when unconfigured, without making any network call', async () => {
    const service = build({});

    await expect(
      service.createUploadAuthorization({
        objectKey: 'x',
        contentType: 'image/jpeg',
        contentLength: 1,
      }),
    ).rejects.toBeInstanceOf(StorageNotConfiguredException);

    await expect(service.verifyObject({ objectKey: 'x' })).rejects.toBeInstanceOf(
      StorageNotConfiguredException,
    );

    await expect(service.deleteObject('x')).rejects.toBeInstanceOf(StorageNotConfiguredException);
  });

  it('getPublicUrl returns undefined when no public base URL is configured', () => {
    const service = build({});
    expect(service.getPublicUrl('some/key.jpg')).toBeUndefined();
  });
});
