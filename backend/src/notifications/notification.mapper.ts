/**
 * Matches components.schemas.Notification in docs/api/openapi.yaml
 * exactly — an explicit allow-list. `userId` (the recipient) is
 * deliberately not exposed: every read is already scoped to the
 * authenticated caller's own notifications, so echoing it back is
 * redundant, not a security concern either way.
 */
export interface PublicNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export function toPublicNotification(row: NotificationRow): PublicNotification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    entityType: row.entityType,
    entityId: row.entityId,
    isRead: row.isRead,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
