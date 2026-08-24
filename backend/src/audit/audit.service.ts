import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecordInput {
  userId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Minimal, shared write path to the audit_logs table (see
 * prisma/schema.prisma). Did not exist before Phase 3 — introduced here
 * because Customer Master Data is the first module requiring audit
 * events (CUSTOMER_CREATED / CUSTOMER_UPDATED). Kept deliberately small:
 * one method, no query/reporting surface — that's out of scope for this
 * phase (see greenfield-implementation-plan.md's "Audit & Reporting"
 * phase for when reporting on this data is actually built).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        action: input.action,
        oldValues: input.oldValues ?? undefined,
        newValues: input.newValues ?? undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }
}
