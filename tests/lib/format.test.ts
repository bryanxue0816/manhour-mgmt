// Display formatters for man-hour figures.
//
// These are pure string producers, so the interesting cases are all edge cases: the
// four variants must stay visibly different from each other (collapsing them changes
// what operators see on four screens), and the signed variant has to survive the two
// values that break naive sign handling - exact zero and negative zero.

import { describe, expect, it } from 'vitest';

import {
  formatHours,
  formatHoursBare,
  formatHoursRounded,
  formatHoursUnknown,
  formatHoursValue,
  formatSignedHours,
} from '@/lib/format';

describe('formatSignedHours', () => {
  it('prefixes a positive figure with a plus', () => {
    // An adjustment of "300" is ambiguous on screen - added or removed? Every
    // adjustment figure carries its sign explicitly for that reason.
    expect(formatSignedHours(300)).toBe('+300');
  });

  it('keeps the minus on a negative figure', () => {
    expect(formatSignedHours(-45)).toBe('-45');
  });

  it('renders exact zero without a sign', () => {
    // Two live slips can net to zero. "+0" would imply an increase; "0" is honest.
    expect(formatSignedHours(0)).toBe('0');
  });

  it('renders negative zero as plain zero', () => {
    // Intl.NumberFormat has rendered -0 as "-0" since ES2020, so an unnormalised
    // negative zero reaches the screen as 「-0」 and reads as a tiny reduction. -0 is
    // easy to produce: any subtraction of equal magnitudes with a negative result.
    expect(formatSignedHours(-0)).toBe('0');
  });

  it('keeps the thousands separator and one decimal', () => {
    expect(formatSignedHours(4631.5)).toBe('+4,631.5');
    expect(formatSignedHours(-4631.5)).toBe('-4,631.5');
  });
});

describe('formatHoursValue', () => {
  it('separates thousands and keeps one decimal', () => {
    expect(formatHoursValue(4631.5)).toBe('4,631.5');
  });

  it('drops a trailing zero decimal', () => {
    expect(formatHoursValue(4632)).toBe('4,632');
  });

  it('rounds beyond one decimal rather than inventing precision', () => {
    // Attendance data arrives in 0.5 steps, so a second decimal can only come from a
    // float artefact in a sum.
    expect(formatHoursValue(4632.25)).toBe('4,632.3');
  });
});

describe('formatHours', () => {
  it('appends the unit', () => {
    expect(formatHours(4632)).toBe('4,632 H');
  });
});

describe('formatHoursRounded', () => {
  it('separates thousands and drops the decimal', () => {
    expect(formatHoursRounded(36193.4)).toBe('36,193');
  });
});

describe('formatHoursBare', () => {
  it('drops both the decimal and the separator', () => {
    // The KPI card renders at display size in a fixed-width slot, where the comma
    // costs a character and buys little at four digits.
    expect(formatHoursBare(4632.4)).toBe('4632');
  });
});

describe('formatHoursUnknown', () => {
  it('formats a number like formatHours', () => {
    expect(formatHoursUnknown(4632)).toBe('4,632 H');
  });

  it('renders a missing tooltip value as empty rather than "undefined"', () => {
    expect(formatHoursUnknown(undefined)).toBe('');
    expect(formatHoursUnknown(null)).toBe('');
  });
});
