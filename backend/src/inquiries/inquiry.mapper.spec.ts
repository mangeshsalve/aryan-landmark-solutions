import { toPublicInquiry } from './inquiry.mapper';

const baseRow = {
  id: 'inq-1',
  inquiryNumber: 'INQ-001',
  customerId: null as string | null,
  propertyId: null,
  type: null,
  priority: 'MEDIUM',
  status: 'NEW',
  externalReference: null,
  handledByUserId: null,
  assignedToUserId: null,
  remarks: null,
  isPublic: false,
  city: null,
  state: null,
  pincode: null,
  locality: null,
  maxBudget: null,
  submittedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('toPublicInquiry customerName (this phase)', () => {
  it('returns the linked customer name when a customer relation is provided', () => {
    const result = toPublicInquiry({
      ...baseRow,
      customerId: 'cust-1',
      customer: { name: 'Mangesh Salve' },
    });

    expect(result.customerId).toBe('cust-1');
    expect(result.customerName).toBe('Mangesh Salve');
  });

  it('returns null when the inquiry has no linked customer (lightweight inquiry)', () => {
    const result = toPublicInquiry({
      ...baseRow,
      customerId: null,
      customer: null,
    });

    expect(result.customerId).toBeNull();
    expect(result.customerName).toBeNull();
  });

  it('returns null when the customer relation was not fetched at all (field simply absent)', () => {
    const result = toPublicInquiry({ ...baseRow, customerId: 'cust-1' });

    expect(result.customerName).toBeNull();
  });

  it('does not alter any other existing field', () => {
    const result = toPublicInquiry({
      ...baseRow,
      customerId: 'cust-1',
      propertyId: 'prop-1',
      status: 'IN_PROGRESS',
      customer: { name: 'Mangesh Salve' },
    });

    expect(result.id).toBe('inq-1');
    expect(result.inquiryNumber).toBe('INQ-001');
    expect(result.propertyId).toBe('prop-1');
    expect(result.status).toBe('IN_PROGRESS');
  });
});

describe('toPublicInquiry unified location fields (this phase)', () => {
  it('maps city/state/pincode/locality straight through for a BUYER row', () => {
    const result = toPublicInquiry({
      ...baseRow,
      type: 'BUYER',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
    });

    expect(result.city).toBe('Pune');
    expect(result.state).toBe('Maharashtra');
    expect(result.pincode).toBe('411001');
    expect(result.locality).toBe('Bhosari');
  });

  it('maps city/state/pincode/locality straight through for a SELLER row too (no more null-for-SELLER special-casing)', () => {
    const result = toPublicInquiry({
      ...baseRow,
      type: 'SELLER',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411001',
      locality: 'Bhosari',
    });

    expect(result.city).toBe('Pune');
    expect(result.locality).toBe('Bhosari');
  });

  it('all four fields default to null when absent', () => {
    const result = toPublicInquiry({ ...baseRow });

    expect(result.city).toBeNull();
    expect(result.state).toBeNull();
    expect(result.pincode).toBeNull();
    expect(result.locality).toBeNull();
  });
});
