/**
 * Phase 40B — the single area-unit-to-square-feet conversion table for
 * the matching engine. SQ_FT is the canonical comparison unit (per the
 * approved Phase 40A design); every other unit converts to it via a
 * fixed multiplier.
 *
 * Values are exactly as approved in the Phase 40B implementation spec —
 * not invented here:
 *   1 SQ_YD    = 9 SQ_FT          (exact, mathematically fixed)
 *   1 SQ_M     = 10.7639 SQ_FT    (exact, international standard)
 *   1 ACRE     = 43,560 SQ_FT     (exact, mathematically fixed)
 *   1 HECTARE  = 107,639 SQ_FT    (exact, = 10,000 sq m)
 *   1 GUNTHA   = 1,089 SQ_FT      (approved business constant — regional
 *                                  Indian land-measurement unit, 1/40
 *                                  acre by the standard land-revenue
 *                                  definition; not a universal physical
 *                                  constant like the others, but
 *                                  explicitly approved for this project)
 *
 * This is the ONLY place this conversion table is defined — every caller
 * (routes/inquiries.ts's matching engine) imports from here rather than
 * hardcoding its own copy, per the explicit "do not create duplicate
 * conversion implementations" instruction.
 */

export type AreaUnit = 'SQ_FT' | 'SQ_YD' | 'SQ_M' | 'ACRE' | 'GUNTHA' | 'HECTARE';

const SQUARE_FEET_PER_UNIT: Record<AreaUnit, number> = {
  SQ_FT: 1,
  SQ_YD: 9,
  SQ_M: 10.7639,
  ACRE: 43_560,
  GUNTHA: 1_089,
  HECTARE: 107_639,
};

/** Converts an area value in the given unit to its canonical square-feet equivalent. */
export function toSquareFeet(value: number, unit: AreaUnit): number {
  return value * SQUARE_FEET_PER_UNIT[unit];
}
