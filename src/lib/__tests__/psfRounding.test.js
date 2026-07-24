// A derived rate you can't multiply back.
//
// George checked the per-tenant breakdown by hand: "i did 19.72 * 2100 = 41412
// which is off". He was right — and so was the app. FIVE POINTS WINGS pays
// $41,403 on 2,100 SF, which is $19.7157/SF; displayed to the cent that reads
// $19.72, and $19.72 x 2,100 is $41,412, nine dollars above the rent above it.
// Nothing was wrong with the money; the rate simply didn't admit it was rounded.
// These pin the rule that decides when a figure has to say so.
import { describe, it, expect } from 'vitest';
import { dividesEvenly, approx, psf, money } from '../format';

describe('a rate only reads as exact when it multiplies back', () => {
  it('George’s figure: $41,403 over 2,100 SF cannot be shown to the cent', () => {
    expect(dividesEvenly(41403, 2100)).toBe(false);
    expect(approx(41403, 2100)).toBe('≈ ');
    // The rounded rate really does miss, which is the whole point.
    expect(psf(41403 / 2100)).toBe('$19.72/SF');
    expect(19.72 * 2100).toBe(41412);
  });

  it('a rate that lands exactly says nothing extra', () => {
    expect(dividesEvenly(60000, 2000)).toBe(true); // $30.00/SF
    expect(approx(60000, 2000)).toBe('');
    expect(dividesEvenly(22491, 2100)).toBe(true); // $10.71/SF, exact to the cent
  });

  it('the same rule covers the monthly figure — twelve rounded months', () => {
    expect(approx(41403, 12)).toBe(''); // $3,450.25 x 12 = $41,403 exactly
    expect(money(41403 / 12)).toBe('$3,450.25');
    expect(approx(34100, 12)).toBe('≈ '); // $2,841.67 x 12 = $34,100.04
    expect(approx(45004.98, 12)).toBe('≈ ');
  });

  it('half a cent of float dust is not an approximation', () => {
    // 0.1 + 0.2 arithmetic must not flip an otherwise exact figure.
    expect(dividesEvenly(3 * 0.1 * 1000, 1000)).toBe(true);
    expect(dividesEvenly(1077 * 12.26, 1077)).toBe(true);
  });

  it('degenerate inputs never claim a figure is wrong', () => {
    expect(dividesEvenly(1000, 0)).toBe(true);
    expect(dividesEvenly(1000, null)).toBe(true);
    expect(dividesEvenly(null, 12)).toBe(true);
    expect(approx('x', 12)).toBe('');
  });
});
