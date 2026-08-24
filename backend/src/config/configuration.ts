export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  logLevel: string;
  r2: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    publicBaseUrl?: string;
  };
  attachmentMaxFileSizeBytes: number;
}

export default (): { app: AppConfig } => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    databaseUrl: process.env.DATABASE_URL ?? '',
    corsOrigins: (process.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    // All optional — the app must start cleanly with none of these set.
    // See src/storage/cloudflare-r2-storage.service.ts for how an
    // unconfigured state is handled at the point of use.
    r2: {
      accountId: process.env.CLOUDFLARE_R2_ACCOUNT_ID || undefined,
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || undefined,
      bucket: process.env.CLOUDFLARE_R2_BUCKET || undefined,
      publicBaseUrl: process.env.CLOUDFLARE_R2_PUBLIC_BASE_URL || undefined,
    },
    // 25 MB default — not specified anywhere in the authoritative
    // documents; kept configurable rather than hard-coded. See Phase 5
    // report for this flagged decision.
    attachmentMaxFileSizeBytes: parseInt(
      process.env.ATTACHMENT_MAX_FILE_SIZE_BYTES ?? '26214400',
      10,
    ),
  },
});
