'use strict';

/**
 * Phase 10 — adds a small set of supplementary rows to the local
 * PostgreSQL database so every category the phase asks for is actually
 * represented, WITHOUT deleting or modifying any existing row. The local
 * DB already had substantial real UAT test data (9 users, 4 properties,
 * 3 inquiries, 7 attachments, 5 assignment-history rows, 2 follow-ups,
 * 137 audit logs) when this phase started — inspected first via
 * read-only Prisma queries, not assumed — but it was missing: an
 * INACTIVE user, a public (isPublic=true) property, an unassigned
 * inquiry, a reminder-enabled/COMPLETED follow-up, any notifications at
 * all, and a primary (is_primary=true) photo. This script adds exactly
 * those, each gated behind a marker value so re-running it is a no-op
 * (idempotent) rather than creating duplicates.
 *
 * Requires ALLOW_DATA_MIGRATION=true and a localhost DATABASE_URL (see
 * lib/safety.js) — this genuinely writes to the local Postgres.
 */
const { PrismaClient } = require('@prisma/client');
const { assertMigrationAllowed } = require('./lib/safety');

const prisma = new PrismaClient();

const MARKERS = {
  inactiveUserEmail: 'phase10-inactive-emp@test.local',
  publicPropertyCode: 'PROP-P10PUBLIC',
  unassignedInquiryRef: 'PHASE10-UNASSIGNED',
  reminderFollowUpNotes: 'PHASE10-REMINDER-TEST',
  notificationTitleRead: 'Phase10 Test Notification (read)',
  notificationTitleUnread: 'Phase10 Test Notification (unread)',
};

async function ensureInactiveUser() {
  const existing = await prisma.user.findUnique({ where: { email: MARKERS.inactiveUserEmail } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      userType: 'APPLICATION_USER',
      role: 'EMPLOYEE',
      userId: 'EMP-P10INACT',
      name: 'Phase10 Inactive Employee',
      email: MARKERS.inactiveUserEmail,
      mobile: '9000000010',
      passwordHash: '$2b$12$Ct1u8w8m1QwF4o4nQnQhKO8yQnQnQhKO8yQnQnQhKO8yQnQnQhKO8', // placeholder, never logged in with
      status: 'INACTIVE',
    },
  });
}

async function ensurePublicProperty(adminUserId) {
  const existing = await prisma.property.findUnique({ where: { propertyCode: MARKERS.publicPropertyCode } });
  if (existing) return existing;
  return prisma.property.create({
    data: {
      propertyCode: MARKERS.publicPropertyCode,
      propertyType: 'Flat',
      category: 'COMMERCIAL',
      area: 850.5,
      areaUnit: 'SQ_FT',
      price: 6543210.99,
      priceUnit: 'INR',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411045',
      locality: 'Kalyani Nagar',
      latitude: 18.548,
      longitude: 73.9,
      status: 'AVAILABLE',
      isPublic: true,
      createdByUserId: adminUserId,
      updatedByUserId: adminUserId,
    },
  });
}

async function ensurePrimaryPhoto(propertyId, uploadedByUserId) {
  const existing = await prisma.attachment.findFirst({
    where: { propertyId, attachmentType: 'PHOTO', isPrimary: true },
  });
  if (existing) return existing;
  return prisma.attachment.create({
    data: {
      propertyId,
      attachmentType: 'PHOTO',
      fileName: 'phase10-primary.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: 123456n,
      r2Bucket: 'phase10-test-bucket',
      r2ObjectKey: `properties/${propertyId}/photos/phase10-primary.jpg`,
      fileUrl: 'https://cdn.test/phase10-primary.jpg',
      isPrimary: true,
      displayOrder: 0,
      uploadedByUserId,
    },
  });
}

async function ensureUnassignedInquiry(customerId, adminUserId) {
  const existing = await prisma.inquiry.findFirst({ where: { externalReference: MARKERS.unassignedInquiryRef } });
  if (existing) return existing;
  return prisma.inquiry.create({
    data: {
      inquiryNumber: `INQ-P10-${Date.now().toString(36).toUpperCase()}`,
      customerId,
      type: 'BUYER',
      priority: 'LOW',
      externalReference: MARKERS.unassignedInquiryRef,
      city: 'Nashik',
      pincode: '422001',
      maxBudget: 4500000,
      createdByUserId: adminUserId,
      updatedByUserId: adminUserId,
      // assignedToUserId intentionally omitted — this is the "unassigned" case.
    },
  });
}

async function ensureReminderFollowUp(inquiryId, adminUserId) {
  const existing = await prisma.followUp.findFirst({ where: { notes: MARKERS.reminderFollowUpNotes } });
  if (existing) return existing;
  return prisma.followUp.create({
    data: {
      inquiryId,
      scheduledAt: new Date('2026-09-10T09:30:00.000Z'),
      status: 'COMPLETED',
      notes: MARKERS.reminderFollowUpNotes,
      reminderEnabled: true,
      createdByUserId: adminUserId,
      updatedByUserId: adminUserId,
    },
  });
}

async function ensureNotifications(userId, inquiryId) {
  const existingRead = await prisma.notification.findFirst({ where: { title: MARKERS.notificationTitleRead } });
  if (!existingRead) {
    await prisma.notification.create({
      data: {
        userId,
        type: 'INQUIRY_ASSIGNED',
        title: MARKERS.notificationTitleRead,
        message: 'Phase 10 read-notification test row.',
        entityType: 'INQUIRY',
        entityId: inquiryId,
        isRead: true,
        readAt: new Date(),
      },
    });
  }
  const existingUnread = await prisma.notification.findFirst({ where: { title: MARKERS.notificationTitleUnread } });
  if (!existingUnread) {
    await prisma.notification.create({
      data: {
        userId,
        type: 'INQUIRY_ASSIGNED',
        title: MARKERS.notificationTitleUnread,
        message: 'Phase 10 unread-notification test row.',
        entityType: 'INQUIRY',
        entityId: inquiryId,
        isRead: false,
      },
    });
  }
}

/** One audit log with an array value nested inside JSON, to stress-test JSON round-trip beyond plain objects. */
async function ensureArrayJsonAuditLog(userId, entityId) {
  const existing = await prisma.auditLog.findFirst({ where: { action: 'PHASE10_JSON_ARRAY_TEST' } });
  if (existing) return existing;
  return prisma.auditLog.create({
    data: {
      userId,
      entityType: 'INQUIRY',
      entityId,
      action: 'PHASE10_JSON_ARRAY_TEST',
      oldValues: { tags: ['a', 'b', 'c'], nested: { count: 3, active: true } },
      newValues: { tags: ['a', 'b', 'c', 'd'], nested: { count: 4, active: false }, note: null },
    },
  });
}

async function main() {
  assertMigrationAllowed('seed-test-data.js');

  const admin = await prisma.user.findFirst({ where: { userType: 'APPLICATION_USER', role: 'ADMIN' } });
  const customer = await prisma.user.findFirst({ where: { userType: 'CUSTOMER' } });
  const employee = await prisma.user.findFirst({ where: { userType: 'APPLICATION_USER', role: 'EMPLOYEE' } });
  if (!admin || !customer || !employee) {
    throw new Error('Expected at least one ADMIN, one EMPLOYEE, and one CUSTOMER to already exist — none found.');
  }

  const inactiveUser = await ensureInactiveUser();
  const publicProperty = await ensurePublicProperty(admin.id);
  await ensurePrimaryPhoto(publicProperty.id, admin.id);
  const unassignedInquiry = await ensureUnassignedInquiry(customer.id, admin.id);
  await ensureReminderFollowUp(unassignedInquiry.id, admin.id);
  await ensureNotifications(employee.id, unassignedInquiry.id);
  await ensureArrayJsonAuditLog(admin.id, unassignedInquiry.id);

  console.log('[seed-test-data] Done. Supplementary rows ensured:');
  console.log('  inactive user id:', inactiveUser.id);
  console.log('  public property id:', publicProperty.id);
  console.log('  unassigned inquiry id:', unassignedInquiry.id);
}

main()
  .catch((err) => {
    console.error('[seed-test-data] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
