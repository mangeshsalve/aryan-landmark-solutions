import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePropertyDto } from './create-property.dto';

async function errorsFor(input: Record<string, unknown>) {
  const dto = plainToInstance(CreatePropertyDto, input);
  return validate(dto);
}

describe('CreatePropertyDto validation (critical rules)', () => {
  it('accepts a minimal valid payload', async () => {
    const errors = await errorsFor({ propertyType: 'Flat', category: 'RESIDENTIAL' });
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid category', async () => {
    const errors = await errorsFor({ propertyType: 'Flat', category: 'NOT_A_CATEGORY' });
    expect(errors.some((e) => e.property === 'category')).toBe(true);
  });

  it('rejects negative area', async () => {
    const errors = await errorsFor({ propertyType: 'Flat', category: 'RESIDENTIAL', area: -5 });
    expect(errors.some((e) => e.property === 'area')).toBe(true);
  });

  it('accepts each controlled areaUnit value', async () => {
    for (const areaUnit of ['SQ_FT', 'SQ_YD', 'SQ_M', 'ACRE', 'GUNTHA', 'HECTARE']) {
      const errors = await errorsFor({ propertyType: 'Flat', category: 'RESIDENTIAL', areaUnit });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an areaUnit outside the controlled list (e.g. old free-text)', async () => {
    const errors = await errorsFor({
      propertyType: 'Flat',
      category: 'RESIDENTIAL',
      areaUnit: 'SQ.FT',
    });
    expect(errors.some((e) => e.property === 'areaUnit')).toBe(true);
  });

  it('rejects negative price', async () => {
    const errors = await errorsFor({ propertyType: 'Flat', category: 'RESIDENTIAL', price: -100 });
    expect(errors.some((e) => e.property === 'price')).toBe(true);
  });

  it('rejects out-of-range latitude', async () => {
    const errors = await errorsFor({
      propertyType: 'Flat',
      category: 'RESIDENTIAL',
      latitude: 95,
    });
    expect(errors.some((e) => e.property === 'latitude')).toBe(true);
  });

  it('rejects out-of-range longitude', async () => {
    const errors = await errorsFor({
      propertyType: 'Flat',
      category: 'RESIDENTIAL',
      longitude: -200,
    });
    expect(errors.some((e) => e.property === 'longitude')).toBe(true);
  });

  it('rejects an invalid mapUrl', async () => {
    const errors = await errorsFor({
      propertyType: 'Flat',
      category: 'RESIDENTIAL',
      mapUrl: 'not-a-url',
    });
    expect(errors.some((e) => e.property === 'mapUrl')).toBe(true);
  });

  it('rejects an empty propertyType', async () => {
    const errors = await errorsFor({ propertyType: '', category: 'RESIDENTIAL' });
    expect(errors.some((e) => e.property === 'propertyType')).toBe(true);
  });
});
