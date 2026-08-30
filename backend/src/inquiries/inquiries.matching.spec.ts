import { Test, TestingModule } from '@nestjs/testing';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import {
  InquiryMatchingInvalidException,
  InquiryNotFoundException,
  PropertyNotFoundException,
} from '../common/exceptions/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { InquiriesService } from './inquiries.service';

describe('InquiriesService.findMatches (this phase — unified location + new algorithm)', () => {
  let service: InquiriesService;
  let prisma: {
    inquiry: { findUnique: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      inquiry: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InquiriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: AttachmentsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();

    service = module.get(InquiriesService);
  });

  it('rejects a nonexistent source inquiry', async () => {
    prisma.inquiry.findUnique.mockResolvedValue(null);
    await expect(service.findMatches('missing')).rejects.toBeInstanceOf(InquiryNotFoundException);
  });

  it('rejects a lightweight inquiry (type=null) — neither BUYER nor SELLER', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({ id: 'inq-1', type: null, property: null });
    await expect(service.findMatches('inq-1')).rejects.toBeInstanceOf(
      InquiryMatchingInvalidException,
    );
  });

  it('rejects a SELLER source with no propertyId — a 400, not an empty result', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({
      id: 'inq-1',
      type: 'SELLER',
      propertyId: null,
      property: null,
    });
    await expect(service.findMatches('inq-1')).rejects.toBeInstanceOf(
      InquiryMatchingInvalidException,
    );
    expect(prisma.inquiry.findMany).not.toHaveBeenCalled();
  });

  it('a SELLER source whose propertyId is set but the property row is missing throws PropertyNotFoundException', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({
      id: 'inq-1',
      type: 'SELLER',
      propertyId: 'prop-1',
      property: null,
    });
    await expect(service.findMatches('inq-1')).rejects.toBeInstanceOf(PropertyNotFoundException);
  });

  it('a BUYER source with no pincode returns an empty array, not an error', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({
      id: 'inq-1',
      type: 'BUYER',
      pincode: null,
      city: 'Pune',
      locality: null,
      maxBudget: 5000000,
      property: null,
    });

    const result = await service.findMatches('inq-1');

    expect(result).toEqual([]);
    expect(prisma.inquiry.findMany).not.toHaveBeenCalled();
  });

  it('a SELLER source whose property has no pincode returns an empty array, not an error', async () => {
    prisma.inquiry.findUnique.mockResolvedValue({
      id: 'inq-1',
      type: 'SELLER',
      propertyId: 'prop-1',
      pincode: null,
      city: 'Pune',
      locality: null,
      maxBudget: null,
      property: { price: 5000000 },
    });

    const result = await service.findMatches('inq-1');

    expect(result).toEqual([]);
  });

  describe('SELLER source -> BUYER candidates', () => {
    const sellerSource = {
      id: 'seller-1',
      type: 'SELLER' as const,
      propertyId: 'prop-1',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
      maxBudget: null,
      property: { price: 5000000 },
    };

    beforeEach(() => {
      prisma.inquiry.findUnique.mockResolvedValue(sellerSource);
    });

    it('queries candidates filtered by type=BUYER and the exact source pincode (the mandatory gate, pushed to the DB)', async () => {
      await service.findMatches('seller-1');

      expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: 'seller-1' },
            type: 'BUYER',
            pincode: '411001',
          }),
        }),
      );
    });

    it('perfect match (city + locality + budget) scores 100', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: '9999999999' },
          propertyId: null,
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
          locality: 'Bhosari',
          maxBudget: 6000000,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        inquiryId: 'buyer-1',
        inquiryType: 'BUYER',
        matchingScore: 100,
      });
    });

    it('pincode + city only (no budget) scores 80', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'Pune',
          state: null,
          pincode: '411001',
          locality: null,
          maxBudget: 1000, // too low
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result[0].matchingScore).toBe(80);
    });

    it('pincode + budget only (city/locality mismatch) scores 50 — below threshold, excluded', async () => {
      // Under the new weights (pincode=30 gate + location=50 + budget=20),
      // the achievable score set is exactly {30, 50, 80, 100} — 70 is not
      // reachable by any combination (unlike the old city-gated design,
      // where city(50)+budget(20)=70 was a real boundary case). Budget
      // alone, without a location match, is structurally never enough.
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'Nagpur', // does not match source city
          state: null,
          pincode: '411001',
          locality: null,
          maxBudget: 6000000,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result).toEqual([]);
    });

    it('pincode + location only (no budget) scores exactly 80 — the practical minimum passing score, included', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'Pune',
          state: null,
          pincode: '411001',
          locality: null,
          maxBudget: 1, // far too low, budget never credited
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result[0].matchingScore).toBe(80);
    });

    it('pincode only (no city/locality/budget match) scores 30 — below threshold, excluded', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'Nagpur',
          state: null,
          pincode: '411001',
          locality: null,
          maxBudget: 1,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result).toEqual([]);
    });

    it('a locality-only match (city mismatched) still reaches the threshold via MAX, same as a city match', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'SomeOtherCity',
          state: null,
          pincode: '411001',
          locality: 'Near Bhosari area',
          maxBudget: 1,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result[0].matchingScore).toBe(80); // 30 pincode + 50 locality
    });

    it('never returns the source inquiry itself (self-match guard)', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'seller-1', // same id as the source, defense-in-depth check
          customerId: 'cust-1',
          customer: { name: 'Self', mobile: null },
          propertyId: null,
          city: 'Pune',
          state: null,
          pincode: '411001',
          locality: null,
          maxBudget: 6000000,
        },
      ]);

      await service.findMatches('seller-1');

      // The guard is expressed in the query itself — assert it's present.
      expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: 'seller-1' } }) }),
      );
    });

    it('skips a candidate missing customer data (defensive guard — cannot happen via the real API)', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: null,
          customer: null,
          propertyId: null,
          city: 'Pune',
          pincode: '411001',
          locality: null,
          maxBudget: 6000000,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result).toEqual([]);
    });

    it('a null property price means budget never contributes, regardless of the candidate budget', async () => {
      prisma.inquiry.findUnique.mockResolvedValue({ ...sellerSource, property: { price: null } });
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'buyer-1',
          customerId: 'cust-1',
          customer: { name: 'Buyer One', mobile: null },
          propertyId: null,
          city: 'Pune',
          pincode: '411001',
          locality: null,
          maxBudget: 999999999,
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result[0].matchingScore).toBe(80); // pincode + city only, budget stays 0
    });

    it('results are sorted by matchingScore descending', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'low',
          customerId: 'c1',
          customer: { name: 'Low', mobile: null },
          propertyId: null,
          city: 'Pune',
          pincode: '411001',
          locality: null,
          maxBudget: 1, // pincode + location, budget too low = 80
        },
        {
          id: 'high',
          customerId: 'c2',
          customer: { name: 'High', mobile: null },
          propertyId: null,
          city: 'Pune',
          pincode: '411001',
          locality: 'Bhosari',
          maxBudget: 6000000, // pincode + location(MAX) + budget = 100
        },
      ]);

      const result = await service.findMatches('seller-1');

      expect(result.map((m) => m.inquiryId)).toEqual(['high', 'low']);
    });

    // Budget boundary regression (this phase) — through the current
    // unified findOppositeMatches, not a bypassed/old helper. The
    // comparison operator itself is unchanged from before this phase;
    // these tests exist to guard it going forward. City is deliberately
    // kept matching in every case (guarantees the 30 pincode + 50
    // location = 80 baseline), so budget's exact contribution is
    // observable as a clean 80-vs-100 score difference rather than an
    // included/excluded difference alone (pincode+budget without
    // location only ever totals 50, which never clears the threshold
    // either way, so presence/absence in the results wouldn't
    // distinguish "budget matched" from "budget didn't").
    describe('budget boundary (this phase — regression, SELLER source price=5000000)', () => {
      const candidateBase = {
        id: 'buyer-boundary',
        customerId: 'cust-boundary',
        customer: { name: 'Boundary Buyer', mobile: null },
        propertyId: null,
        city: 'Pune', // matches source city -> location=50 guaranteed
        pincode: '411001',
        locality: null,
      };

      it('price == maxBudget: budget matches (inclusive <=), score 100', async () => {
        prisma.inquiry.findMany.mockResolvedValue([{ ...candidateBase, maxBudget: 5000000 }]);

        const result = await service.findMatches('seller-1');

        expect(result[0].matchingScore).toBe(100);
      });

      it('maxBudget == price - 1: budget does NOT match, score stays at 80', async () => {
        prisma.inquiry.findMany.mockResolvedValue([{ ...candidateBase, maxBudget: 4999999 }]);

        const result = await service.findMatches('seller-1');

        expect(result[0].matchingScore).toBe(80);
      });

      it('maxBudget == price + 1: budget matches, score 100', async () => {
        prisma.inquiry.findMany.mockResolvedValue([{ ...candidateBase, maxBudget: 5000001 }]);

        const result = await service.findMatches('seller-1');

        expect(result[0].matchingScore).toBe(100);
      });
    });
  });

  describe('BUYER source -> SELLER candidates', () => {
    const buyerSource = {
      id: 'buyer-src',
      type: 'BUYER' as const,
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
      maxBudget: 6000000,
      property: null,
    };

    beforeEach(() => {
      prisma.inquiry.findUnique.mockResolvedValue(buyerSource);
    });

    it('queries candidates filtered by type=SELLER and the exact source pincode, including the property relation (for price)', async () => {
      await service.findMatches('buyer-src');

      expect(prisma.inquiry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: 'SELLER', pincode: '411001' }),
          include: expect.objectContaining({ customer: true, property: true }),
        }),
      );
    });

    it('perfect match scores 100 and the result represents an inquiry, with propertyId populated', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'seller-1',
          customerId: 'cust-1',
          customer: { name: 'Seller One', mobile: '8888888888' },
          propertyId: 'prop-9',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
          locality: 'Bhosari',
          maxBudget: null,
          property: { price: 5000000 },
        },
      ]);

      const result = await service.findMatches('buyer-src');

      expect(result[0]).toMatchObject({
        inquiryId: 'seller-1',
        inquiryType: 'SELLER',
        propertyId: 'prop-9',
        matchingScore: 100,
      });
    });

    it('skips a SELLER candidate missing its property (defensive guard)', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'seller-1',
          customerId: 'cust-1',
          customer: { name: 'Seller One', mobile: null },
          propertyId: 'prop-9',
          city: 'Pune',
          pincode: '411001',
          locality: null,
          maxBudget: null,
          property: null,
        },
      ]);

      const result = await service.findMatches('buyer-src');

      expect(result).toEqual([]);
    });

    it('city/state/pincode/locality are populated on a SELLER-type match too (no more null-for-SELLER)', async () => {
      prisma.inquiry.findMany.mockResolvedValue([
        {
          id: 'seller-1',
          customerId: 'cust-1',
          customer: { name: 'Seller One', mobile: null },
          propertyId: 'prop-9',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
          locality: 'Bhosari',
          maxBudget: null,
          property: { price: 5000000 },
        },
      ]);

      const result = await service.findMatches('buyer-src');

      expect(result[0].city).toBe('Pune');
      expect(result[0].state).toBe('Maharashtra');
      expect(result[0].locality).toBe('Bhosari');
      // maxBudget is still buyer-only — genuinely null on the raw SELLER row.
      expect(result[0].maxBudget).toBeNull();
    });

    // Budget boundary regression (this phase), mirrored for this
    // direction — source is BUYER (maxBudget=6000000), candidate is
    // SELLER whose property.price is varied at the boundary. Same
    // reasoning as the SELLER-source block above: city kept matching so
    // the 80-vs-100 score difference isolates budget's contribution.
    describe('budget boundary (this phase — regression, BUYER source maxBudget=6000000)', () => {
      const candidateBase = {
        id: 'seller-boundary',
        customerId: 'cust-boundary',
        customer: { name: 'Boundary Seller', mobile: null },
        propertyId: 'prop-boundary',
        city: 'Pune', // matches source city -> location=50 guaranteed
        pincode: '411001',
        locality: null,
      };

      it('price == maxBudget: budget matches (inclusive <=), score 100', async () => {
        prisma.inquiry.findMany.mockResolvedValue([
          { ...candidateBase, property: { price: 6000000 } },
        ]);

        const result = await service.findMatches('buyer-src');

        expect(result[0].matchingScore).toBe(100);
      });

      it('maxBudget == price - 1 (price is 1 more than the buyer will pay): budget does NOT match, score stays at 80', async () => {
        prisma.inquiry.findMany.mockResolvedValue([
          { ...candidateBase, property: { price: 6000001 } },
        ]);

        const result = await service.findMatches('buyer-src');

        expect(result[0].matchingScore).toBe(80);
      });

      it('maxBudget == price + 1 (price is 1 less than the buyer will pay): budget matches, score 100', async () => {
        prisma.inquiry.findMany.mockResolvedValue([
          { ...candidateBase, property: { price: 5999999 } },
        ]);

        const result = await service.findMatches('buyer-src');

        expect(result[0].matchingScore).toBe(100);
      });
    });
  });
});
