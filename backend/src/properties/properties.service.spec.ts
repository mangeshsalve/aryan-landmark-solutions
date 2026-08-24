import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import {
  ForbiddenRoleException,
  PropertyDuplicateException,
  PropertyNotFoundException,
} from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { PropertiesService } from './properties.service';

describe('PropertiesService (critical paths)', () => {
  let service: PropertiesService;
  let prisma: {
    property: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    attachment: { findMany: jest.Mock };
  };
  let audit: { record: jest.Mock };

  const adminActor = { userId: 'admin-uuid-1', role: 'ADMIN' as const };
  const employeeActor = { userId: 'employee-uuid-1', role: 'EMPLOYEE' as const };

  const baseRow = {
    id: 'prop-1',
    propertyCode: 'PROP-AAAA1111',
    propertyType: 'Flat',
    category: 'RESIDENTIAL',
    area: null,
    areaUnit: null,
    price: null,
    priceUnit: null,
    gatNoDetails: null,
    description: null,
    address: null,
    locality: null,
    city: null,
    state: null,
    pincode: null,
    latitude: null,
    longitude: null,
    mapUrl: null,
    status: 'AVAILABLE',
    isPublic: false,
  };

  beforeEach(async () => {
    prisma = {
      property: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      attachment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PropertiesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(PropertiesService);
  });

  // ADMIN can create property (authorization itself is enforced by
  // guards, exercised at the controller level — see auth guard specs
  // from Phase 2; this confirms the service-level creation path works
  // for an ADMIN actor)
  it('creates a property with createdBy/updatedBy from an ADMIN actor', async () => {
    prisma.property.findUnique.mockResolvedValue(null); // no code collision
    prisma.property.create.mockResolvedValue(baseRow);

    await service.create({ propertyType: 'Flat', category: 'RESIDENTIAL' }, adminActor);

    expect(prisma.property.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdByUserId: 'admin-uuid-1',
        updatedByUserId: 'admin-uuid-1',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PROPERTY_CREATED' }),
    );
  });

  // EMPLOYEE can create property
  it('creates a property from an EMPLOYEE actor identically', async () => {
    prisma.property.findUnique.mockResolvedValue(null);
    prisma.property.create.mockResolvedValue(baseRow);

    await service.create({ propertyType: 'Flat', category: 'RESIDENTIAL' }, employeeActor);

    expect(prisma.property.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdByUserId: 'employee-uuid-1' }),
    });
  });

  // A property can be retrieved
  it('retrieves an existing property by id', async () => {
    prisma.property.findUnique.mockResolvedValue(baseRow);
    const result = await service.getById('prop-1');
    expect(result.id).toBe('prop-1');
    expect(result.propertyCode).toBe('PROP-AAAA1111');
  });

  it('throws PropertyNotFoundException for an unknown id', async () => {
    prisma.property.findUnique.mockResolvedValue(null);
    await expect(service.getById('unknown')).rejects.toBeInstanceOf(PropertyNotFoundException);
  });

  // A property can be updated
  it('updates a property and records PROPERTY_UPDATED', async () => {
    prisma.property.findUnique.mockResolvedValueOnce(baseRow); // existing lookup
    prisma.property.update.mockResolvedValue({ ...baseRow, propertyType: 'Bungalow' });

    const result = await service.update('prop-1', { propertyType: 'Bungalow' }, adminActor);

    expect(result.propertyType).toBe('Bungalow');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PROPERTY_UPDATED', entityId: 'prop-1' }),
    );
  });

  it('rejects updating to a propertyCode that already belongs to another property', async () => {
    prisma.property.findUnique
      .mockResolvedValueOnce(baseRow) // existing lookup
      .mockResolvedValueOnce({ ...baseRow, id: 'other-prop' }); // conflict lookup

    await expect(
      service.update('prop-1', { propertyCode: 'PROP-TAKEN01' }, adminActor),
    ).rejects.toBeInstanceOf(PropertyDuplicateException);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });

  // Category/status enum enforcement happens at the DTO layer
  // (class-validator @IsIn), not the service — covered structurally by
  // TypeScript + class-validator rather than duplicated here.

  it('generates a propertyCode when none is supplied and none collide', async () => {
    prisma.property.findUnique.mockResolvedValue(null);
    prisma.property.create.mockImplementation(({ data }: { data: { propertyCode: string } }) =>
      Promise.resolve({ ...baseRow, propertyCode: data.propertyCode }),
    );

    const result = await service.create(
      { propertyType: 'Plot', category: 'AGRICULTURAL' },
      adminActor,
    );

    expect(result.propertyCode).toMatch(/^PROP-[0-9A-F]{8}$/);
  });

  it('scopes list() filters (status, category, city) into the where clause', async () => {
    prisma.property.findMany.mockResolvedValue([]);
    prisma.property.count.mockResolvedValue(0);

    await service.list({
      page: 1,
      pageSize: 20,
      status: 'AVAILABLE',
      category: 'COMMERCIAL',
      city: 'Pune',
    });

    expect(prisma.property.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'AVAILABLE',
          category: 'COMMERCIAL',
          city: { equals: 'Pune', mode: 'insensitive' },
        }),
      }),
    );
  });

  // Phase 8.1: GET /public/properties requires BOTH isPublic=true AND
  // status=AVAILABLE — isPublic alone is not sufficient.
  it('listPublic() requires isPublic=true AND status=AVAILABLE in the where clause', async () => {
    prisma.property.findMany.mockResolvedValue([]);
    prisma.property.count.mockResolvedValue(0);

    await service.listPublic({ page: 1, pageSize: 20, category: 'RESIDENTIAL' });

    expect(prisma.property.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isPublic: true, status: 'AVAILABLE', category: 'RESIDENTIAL' },
      }),
    );
  });

  it('listPublic() includes only PHOTO attachments as photos, never DOCUMENT/RECORDING', async () => {
    prisma.property.findMany.mockResolvedValue([{ ...baseRow, isPublic: true }]);
    prisma.property.count.mockResolvedValue(1);
    prisma.attachment.findMany.mockResolvedValue([
      {
        id: 'photo-1',
        propertyId: 'prop-1',
        fileUrl: 'https://cdn/photo1.jpg',
        isPrimary: true,
        displayOrder: 0,
      },
    ]);

    const result = await service.listPublic({ page: 1, pageSize: 20 });

    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ attachmentType: 'PHOTO' }),
      }),
    );
    expect(result.data[0].photos).toEqual([
      { id: 'photo-1', fileUrl: 'https://cdn/photo1.jpg', isPrimary: true, displayOrder: 0 },
    ]);
    // No r2Bucket/r2ObjectKey/uploadedBy on the exposed photo shape.
    expect(result.data[0].photos[0]).not.toHaveProperty('r2ObjectKey');
    expect(result.data[0].photos[0]).not.toHaveProperty('uploadedBy');
  });

  // Phase 8.1: isPublic is ADMIN-only.
  it('allows an ADMIN to set isPublic', async () => {
    prisma.property.findUnique.mockResolvedValueOnce(baseRow);
    prisma.property.update.mockResolvedValue({ ...baseRow, isPublic: true });

    const result = await service.update('prop-1', { isPublic: true }, adminActor);

    expect(result.isPublic).toBe(true);
  });

  it('rejects an EMPLOYEE trying to set isPublic', async () => {
    prisma.property.findUnique.mockResolvedValueOnce(baseRow);

    await expect(
      service.update('prop-1', { isPublic: true }, employeeActor),
    ).rejects.toBeInstanceOf(ForbiddenRoleException);
    expect(prisma.property.update).not.toHaveBeenCalled();
  });
});
