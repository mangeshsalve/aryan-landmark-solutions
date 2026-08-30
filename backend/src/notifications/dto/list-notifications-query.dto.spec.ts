import { plainToInstance } from 'class-transformer';
import { ListNotificationsQueryDto } from './list-notifications-query.dto';

/**
 * Regression test for a real bug caught during manual verification: the
 * global ValidationPipe uses transformOptions: { enableImplicitConversion:
 * true } (main.ts), which applies its own implicit Boolean coercion from
 * the reflected design:type BEFORE handing the value to a @Transform
 * callback — so a naive `@Transform(({ value }) => value === 'false' ?
 * false : ...)` never actually sees the string "false"; it receives the
 * already-wrongly-coerced `true` and passes it straight through. Every
 * case here is run with that exact option, matching the real pipe
 * config, not a simplified plainToInstance call.
 */
describe('ListNotificationsQueryDto isRead query-param coercion', () => {
  function transform(query: Record<string, unknown>) {
    return plainToInstance(ListNotificationsQueryDto, query, { enableImplicitConversion: true });
  }

  it('"false" becomes boolean false, not true', () => {
    const dto = transform({ isRead: 'false' });
    expect(dto.isRead).toBe(false);
  });

  it('"true" becomes boolean true', () => {
    const dto = transform({ isRead: 'true' });
    expect(dto.isRead).toBe(true);
  });

  it('an absent isRead stays undefined (no filter applied)', () => {
    const dto = transform({});
    expect(dto.isRead).toBeUndefined();
  });
});
