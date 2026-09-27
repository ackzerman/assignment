import { describe, it, expect } from 'vitest';
import { countryName } from './countries.js';

describe('countryName (Intl CLDR labels)', () => {
  it('labels common codes in English', () => {
    expect(countryName('DE')).toBe('Germany');
    expect(countryName('FR')).toBe('France');
    expect(countryName('US')).toBe('United States');
  });

  it('labels codes outside any hand-maintained subset', () => {
    expect(countryName('AF')).toBe('Afghanistan');
    expect(countryName('ZW')).toBe('Zimbabwe');
    expect(countryName('AX')).toBe('Åland Islands');
  });

  it('normalizes lowercase input', () => {
    expect(countryName('de')).toBe('Germany');
  });

  it('falls back to the raw code for unknown values', () => {
    expect(countryName('XX')).toBe('XX');
    expect(countryName('')).toBe('');
    expect(countryName(null)).toBe(null);
  });
});
