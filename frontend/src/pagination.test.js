import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, pageCountFor, clampPage, offsetFor } from './pagination.js';

describe('batch results pagination', () => {
  it('uses a bounded page size', () => {
    expect(PAGE_SIZE).toBe(200);
  });

  it('computes page counts covering the whole result set', () => {
    expect(pageCountFor(0)).toBe(1);
    expect(pageCountFor(1)).toBe(1);
    expect(pageCountFor(200)).toBe(1);
    expect(pageCountFor(201)).toBe(2);
    expect(pageCountFor(10000)).toBe(50);
  });

  it('every index of a large batch falls on some page', () => {
    const total = 10000;
    const pages = pageCountFor(total);
    // First index of first page is 0, last index of last page covers total-1.
    expect(offsetFor(0)).toBe(0);
    expect(offsetFor(pages - 1) + PAGE_SIZE).toBeGreaterThanOrEqual(total);
  });

  it('clamps navigation into bounds', () => {
    expect(clampPage(-1, 5)).toBe(0);
    expect(clampPage(0, 5)).toBe(0);
    expect(clampPage(4, 5)).toBe(4);
    expect(clampPage(99, 5)).toBe(4);
    expect(clampPage(NaN, 5)).toBe(0);
  });

  it('derives offsets from page indexes', () => {
    expect(offsetFor(0)).toBe(0);
    expect(offsetFor(1)).toBe(200);
    expect(offsetFor(3)).toBe(600);
  });
});
