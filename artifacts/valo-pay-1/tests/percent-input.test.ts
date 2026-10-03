import { describe, expect, it } from 'vitest';
import {
  basisPointsToPercent, fractionToPercent, PercentInputError, percentToBasisPoints, percentToFraction, percentToStored, storedToPercent,
} from '@/lib/percent-input';

describe('rates typed in per cent and stored as basis points', () => {
  it.each([
    ['0', 0], ['0.3', 30], ['0.30', 30], ['0.05', 5], ['.5', 50], ['1.5 %', 150], [' 12.5 ', 1250], ['100', 10000], ['100.00', 10000],
  ])('saves %s%% as exactly %i basis points', (typed, basisPoints) => {
    expect(percentToBasisPoints(typed)).toBe(basisPoints);
  });

  it('shows every saved rate back in per cent, and saves that text as the same basis points', () => {
    expect(basisPointsToPercent(30)).toBe('0.3');
    expect(basisPointsToPercent(1250)).toBe('12.5');
    expect(basisPointsToPercent(10000)).toBe('100');
    for (let basisPoints = 0; basisPoints <= 10000; basisPoints++) expect(percentToBasisPoints(basisPointsToPercent(basisPoints))).toBe(basisPoints);
  });

  it.each(['', '%', '-1', '1.001', '0.005', '100.01', '101', '1e2', '1,5', 'NaN', 'Infinity', 'ten'])('refuses %s instead of rounding it', typed => {
    expect(() => percentToBasisPoints(typed)).toThrow(PercentInputError);
    expect(() => percentToBasisPoints(typed)).toThrow('Enter a percentage from 0 to 100 with no more than 2 decimal places, for example 0.3 or 40.');
  });
});

describe('rates typed in per cent and stored as a fraction of 1', () => {
  it.each([
    ['40', 0.4], ['37.5', 0.375], ['7', 0.07], ['0.05', 0.0005], ['10', 0.1], ['92', 0.92], ['100', 1], ['0', 0],
    ['7.125', 0.07125], ['33.3333', 0.333333], ['12.345 %', 0.12345],
  ])('saves %s%% as exactly %d', (typed, fraction) => {
    expect(percentToFraction(typed)).toBe(fraction);
  });

  it('shows a saved fraction in per cent by moving the decimal point, never by multiplying', () => {
    // 0.07 * 100 is 7.000000000000001 in floating point; the digits say 7.
    expect(0.07 * 100).not.toBe(7);
    expect(fractionToPercent(0.07)).toBe('7');
    expect(fractionToPercent(0.4)).toBe('40');
    expect(fractionToPercent(0.375)).toBe('37.5');
    expect(fractionToPercent(0.0005)).toBe('0.05');
    expect(fractionToPercent(1)).toBe('100');
    expect(fractionToPercent(1e-7)).toBe('0.00001');
  });

  it('returns every percentage with up to 2 decimals as the text it was typed as', () => {
    for (let hundredths = 0; hundredths <= 10000; hundredths++) {
      const typed = basisPointsToPercent(hundredths);
      expect(fractionToPercent(percentToFraction(typed))).toBe(typed);
    }
  });

  it.each([0.07125, 0.333333, 0.12345678901234568, 1e-7, Number.MIN_VALUE])('preserves the saved fraction %d when its percentage is saved unchanged', fraction => {
    expect(percentToStored('fraction', storedToPercent('fraction', fraction))).toBe(fraction);
  });

  it('refuses an amount below the smallest supported fraction instead of saving zero', () => {
    expect(() => percentToFraction(`0.${'0'.repeat(324)}1`)).toThrow('This percentage is too small to save. Enter a larger percentage or 0.');
  });

  it.each(['', '%', '-5', '100.5', '150', '1e2', '1,5', 'NaN', 'Infinity', 'forty'])('refuses %s', typed => {
    expect(() => percentToFraction(typed)).toThrow(PercentInputError);
  });
});

describe('the per cent fields of a record form', () => {
  it('convert by the unit each field is stored in', () => {
    expect(percentToStored('basisPoints', '0.45')).toBe(45);
    expect(percentToStored('fraction', '20')).toBe(0.2);
    expect(storedToPercent('basisPoints', 45)).toBe('0.45');
    expect(storedToPercent('fraction', 0.2)).toBe('20');
  });

  it('show a stored value that is not a rate in the field’s unit as an empty field, never as a percentage', () => {
    // Shown as "12.5", an unchanged save would store 1,250 basis points: 100 times the rate.
    expect(storedToPercent('basisPoints', 12.5)).toBe('');
    expect(storedToPercent('basisPoints', -1)).toBe('');
    expect(storedToPercent('fraction', 'unknown')).toBe('');
    expect(storedToPercent('fraction', -1)).toBe('');
  });
});
