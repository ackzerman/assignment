/**
 * Country validation tests (§16): the documented full ISO 3166-1 alpha-2 set
 * must actually be accepted, plus the null-parcel input guard.
 */

const { validateParcelInput, getValidCountryCodes } = require('../../src/domain/validation');

describe('Country validation (full ISO 3166-1 alpha-2)', () => {
  it('supports 249 codes', () => {
    expect(getValidCountryCodes()).toHaveLength(249);
  });

  it.each([['NG'], ['KE'], ['AF'], ['ZW'], ['IS'], ['BR'], ['JP'], ['DE']])(
    'accepts %p',
    (code) => {
      const res = validateParcelInput({ weight: 2, value: 10, destinationCountry: code });
      expect(res.success).toBe(true);
      expect(res.parcel.destinationCountry).toBe(code);
    },
  );

  it.each([['XX'], ['USA'], ['ZZ'], ['D'], ['12']])('rejects %p', (code) => {
    const res = validateParcelInput({ weight: 2, value: 10, destinationCountry: code });
    expect(res.success).toBe(false);
  });

  it('normalizes lowercase codes', () => {
    const res = validateParcelInput({ weight: 2, value: 10, destinationCountry: 'ng' });
    expect(res.success).toBe(true);
    expect(res.parcel.destinationCountry).toBe('NG');
  });
});

describe('Non-object parcel input', () => {
  it.each([[null], [undefined], ['nope'], [42], [[{ weight: 2 }]]])(
    'returns validation errors instead of throwing for %p',
    (input) => {
      const res = validateParcelInput(input);
      expect(res.success).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    },
  );
});
