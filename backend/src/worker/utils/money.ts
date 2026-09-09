/**
 * Single reusable rupees<->minor-units (paise) conversion strategy — see
 * migrations/0001_initial_schema.sql's "DECIMAL FIELD DECISIONS" comment
 * for why properties.price is stored as an exact INTEGER of minor units
 * rather than REAL. The external API contract is unchanged: routes accept
 * and return `price` in rupees; only the D1 storage layer uses minor
 * units, exactly mirroring how the Prisma-based backend converts
 * Decimal<->Number at its mapper boundary today (property.mapper.ts's
 * toNullableNumber).
 *
 * Math.round(rupees * 100) is the standard, well-defined way to convert a
 * JS double to the nearest paisa — it correctly absorbs IEEE-754
 * representation noise (e.g. 123.45 * 100 can land on
 * 12344.999999999998 before rounding) and reproduces the same rounding a
 * NUMERIC(18,2)/Decimal(18,2) column would apply at insert time. Every
 * route handler that touches properties.price must go through these two
 * functions rather than inlining `* 100` / `/ 100` — this is the one
 * place that logic lives.
 */
export function rupeesToMinorUnits(rupees: number | null | undefined): number | null {
  if (rupees === null || rupees === undefined) return null;
  return Math.round(rupees * 100);
}

export function minorUnitsToRupees(minorUnits: number | null | undefined): number | null {
  if (minorUnits === null || minorUnits === undefined) return null;
  return minorUnits / 100;
}
