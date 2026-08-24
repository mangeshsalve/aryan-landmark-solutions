import { ValidationPipe } from '@nestjs/common';
import { CreateInquiryDto } from './create-inquiry.dto';
import { UpdateInquiryDto } from './update-inquiry.dto';

/**
 * Confirms submittedAt can never be supplied by a client — it's
 * controlled exclusively by InquiriesService.submit(). Exercises the
 * same ValidationPipe options configured globally in main.ts
 * (whitelist + forbidNonWhitelisted), not just bare class-validator.
 */
describe('submittedAt is rejected on create/update requests', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });

  it('rejects submittedAt on CreateInquiryRequest', async () => {
    await expect(
      pipe.transform(
        {
          customerId: '11111111-1111-1111-1111-111111111111',
          propertyId: '22222222-2222-2222-2222-222222222222',
          submittedAt: '2026-01-01T00:00:00Z',
        },
        { type: 'body', metatype: CreateInquiryDto },
      ),
    ).rejects.toThrow();
  });

  it('rejects submittedAt on UpdateInquiryRequest', async () => {
    await expect(
      pipe.transform(
        { submittedAt: '2026-01-01T00:00:00Z' },
        { type: 'body', metatype: UpdateInquiryDto },
      ),
    ).rejects.toThrow();
  });
});
