import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService location sync (this phase — Property→Inquiry, Option A)', () => {
  let service: InquiriesService;
  let prisma: {
    inquiry: { findUnique: jest.Mock; findMany: jest.Mock; $transaction: jest.Mock };
    property: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    attachment: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    inquiry: { create: jest.Mock; update: jest.Mock };
    inquiryAssignment: { create: jest.Mock };
  };

  const actor = { userId: 'admin-1', role: 'ADMIN' as const };

  const propertyRow = {
    id: 'prop-1',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411001',
    locality: 'Bhosari',
  };

  beforeEach(async () => {
    tx = {
      inquiry: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'new-inq', inquiryNumber: 'INQ-1', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'inq-1', inquiryNumber: 'INQ-1', ...data }),
          ),
      },
      inquiryAssignment: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      inquiry: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        $transaction: jest.fn(),
      },
      property: { findUnique: jest.fn().mockResolvedValue(propertyRow) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: AttachmentsService, useValue: { list: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get(InquiriesService);
  });

  describe('create()', () => {
    it('SELLER + propertyId: location is synced from the property, overriding any client-supplied values', async () => {
      await service.create(
        {
          type: 'SELLER',
          propertyId: 'prop-1',
          city: 'ClientTypedWrongCity',
          pincode: '999999',
        } as never,
        actor,
      );

      expect(tx.inquiry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            city: 'Pune',
            state: 'Maharashtra',
            pincode: '411001',
            locality: 'Bhosari',
          }),
        }),
      );
    });

    it('BUYER: client-supplied location is used directly, normalized (trimmed)', async () => {
      await service.create(
        {
          type: 'BUYER',
          city: '  Pune  ',
          state: 'Maharashtra',
          pincode: '411001',
          locality: 'Bhosari',
        } as never,
        actor,
      );

      expect(tx.inquiry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ city: 'Pune', pincode: '411001' }),
        }),
      );
    });

    it('SELLER with no propertyId yet (lightweight): client-supplied location is honored directly', async () => {
      await service.create(
        { type: 'SELLER', city: 'ManuallyEntered', pincode: '411099' } as never,
        actor,
      );

      expect(tx.inquiry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ city: 'ManuallyEntered', pincode: '411099' }),
        }),
      );
      expect(prisma.property.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    const existingSellerWithProperty = {
      id: 'inq-1',
      inquiryNumber: 'INQ-1',
      customerId: null,
      propertyId: 'prop-1',
      type: 'SELLER',
      assignedToUserId: null,
      city: 'OldCity',
      state: 'OldState',
      pincode: '000000',
      locality: 'OldLocality',
    };

    it('re-syncs location when a NEW property is linked in this request', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(existingSellerWithProperty);
      const newProperty = {
        id: 'prop-2',
        city: 'Nagpur',
        state: 'MH',
        pincode: '440001',
        locality: 'Sitabuldi',
      };
      prisma.property.findUnique.mockResolvedValue(newProperty);

      await service.update('inq-1', { propertyId: 'prop-2' } as never, actor);

      expect(tx.inquiry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            city: 'Nagpur',
            state: 'MH',
            pincode: '440001',
            locality: 'Sitabuldi',
          }),
        }),
      );
    });

    it('leaves location completely untouched (and ignores client-supplied values) when propertyId is NOT changing', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(existingSellerWithProperty);

      await service.update(
        'inq-1',
        { remarks: 'just a remark', city: 'AttemptedOverride', pincode: '111111' } as never,
        actor,
      );

      expect(prisma.property.findUnique).not.toHaveBeenCalled();
      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBeUndefined();
      expect(call.data.state).toBeUndefined();
      expect(call.data.pincode).toBeUndefined();
      expect(call.data.locality).toBeUndefined();
    });

    it('SELLER -> SELLER (type explicitly re-sent, not just omitted) with unchanged propertyId does NOT re-sync — this fix only affects an actual transition INTO SELLER', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(existingSellerWithProperty); // already type: 'SELLER'

      await service.update('inq-1', { type: 'SELLER', remarks: 'still a seller' } as never, actor);

      expect(prisma.property.findUnique).not.toHaveBeenCalled();
      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBeUndefined();
      expect(call.data.state).toBeUndefined();
      expect(call.data.pincode).toBeUndefined();
      expect(call.data.locality).toBeUndefined();
    });

    it('SELLER property relinking (existing SELLER, type also explicitly re-sent) still re-syncs from the newly-linked property — unchanged by this fix', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(existingSellerWithProperty); // already type: 'SELLER'
      const newProperty = {
        id: 'prop-2',
        city: 'Nagpur',
        state: 'MH',
        pincode: '440001',
        locality: 'Sitabuldi',
      };
      prisma.property.findUnique.mockResolvedValue(newProperty);

      await service.update('inq-1', { type: 'SELLER', propertyId: 'prop-2' } as never, actor);

      expect(prisma.property.findUnique).toHaveBeenCalledWith({ where: { id: 'prop-2' } });
      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBe('Nagpur');
      expect(call.data.state).toBe('MH');
      expect(call.data.pincode).toBe('440001');
      expect(call.data.locality).toBe('Sitabuldi');
    });

    it('BUYER: client-supplied location fields are honored directly, partial-update semantics preserved', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({
        id: 'inq-2',
        inquiryNumber: 'INQ-2',
        customerId: null,
        propertyId: null,
        type: 'BUYER',
        assignedToUserId: null,
        city: 'OldCity',
        state: null,
        pincode: '000000',
        locality: null,
      });

      await service.update('inq-2', { city: 'NewCity' } as never, actor);

      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBe('NewCity');
      // state/pincode/locality were omitted from the request — untouched.
      expect(call.data.state).toBeUndefined();
      expect(call.data.pincode).toBeUndefined();
      expect(call.data.locality).toBeUndefined();
    });

    it('SELLER -> BUYER (explicitly out of scope for this fix) still preserves existing location untouched, propertyId or not', async () => {
      prisma.inquiry.findUnique.mockResolvedValue(existingSellerWithProperty); // type: 'SELLER', propertyId: 'prop-1'

      await service.update('inq-1', { type: 'BUYER' } as never, actor);

      expect(prisma.property.findUnique).not.toHaveBeenCalled();
      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBeUndefined();
      expect(call.data.state).toBeUndefined();
      expect(call.data.pincode).toBeUndefined();
      expect(call.data.locality).toBeUndefined();
    });

    it('bug fix (this phase): type switching to SELLER with an already-linked propertyId (not changing in this request) DOES re-sync from that property, replacing the old BUYER location', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({
        id: 'inq-3',
        inquiryNumber: 'INQ-3',
        customerId: null,
        propertyId: 'prop-1',
        type: 'BUYER', // was BUYER, with a property already linked from earlier
        assignedToUserId: null,
        city: 'PreExisting',
        state: null,
        pincode: '411001',
        locality: null,
      });
      // propertyRow (the default prisma.property.findUnique mock) is
      // city: 'Pune', state: 'Maharashtra', pincode: '411001',
      // locality: 'Bhosari' — deliberately different from the
      // pre-existing BUYER-era 'PreExisting' city, so a passing
      // assertion here can only mean the sync actually ran.

      await service.update('inq-3', { type: 'SELLER' } as never, actor);

      expect(prisma.property.findUnique).toHaveBeenCalledWith({ where: { id: 'prop-1' } });
      const call = tx.inquiry.update.mock.calls[0][0];
      expect(call.data.city).toBe('Pune');
      expect(call.data.state).toBe('Maharashtra');
      expect(call.data.pincode).toBe('411001');
      expect(call.data.locality).toBe('Bhosari');
    });
  });
});
