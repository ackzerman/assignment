/**
 * Strict numeric validation tests (Master Phase 1).
 *
 * The validator must NOT rely on permissive parsing such as
 * parseFloat("5abc") being accepted as 5. Malformed numerics are rejected.
 */

const { validateParcelInput } = require('../../src/domain/validation');

describe('Strict numeric validation', () => {
  const base = { weight: 2, value: 100, destinationCountry: 'DE' };

  it.each([
    ['5abc'],
    ['12kg'],
    ['--5'],
    [''],
    ['   '],
    ['Infinity'],
    ['NaN'],
    ['0x10'],
    ['1,000'],
  ])('rejects malformed weight %p', (weight) => {
    const res = validateParcelInput({ ...base, weight });
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.field === 'weight')).toBe(true);
  });

  it.each([
    ['100abc'],
    ['€100'],
    ['Infinity'],
    [''],
  ])('rejects malformed value %p', (value) => {
    const res = validateParcelInput({ ...base, value });
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => e.field === 'value')).toBe(true);
  });

  it.each([
    [' 2.5 ', 2.5],
    ['100', 100],
    ['1e3', 1000],
  ])('accepts strict numeric string %p', (weight, expected) => {
    const res = validateParcelInput({ ...base, weight });
    expect(res.success).toBe(true);
    expect(res.parcel.weight).toBe(expected);
  });
});
