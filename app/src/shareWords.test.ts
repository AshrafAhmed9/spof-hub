import { describe, expect, it } from 'vitest';
import { shareWords } from '../static/hub/src/util';

describe('shareWords', () => {
  it('says all only when the rounded percent is 100', () => {
    expect(shareWords(1)).toBe('all');
    expect(shareWords(0.996)).toBe('all');
    expect(shareWords(0.994)).toBe('almost all');
  });
  it('buckets the rest', () => {
    expect(shareWords(0.95)).toBe('almost all');
    expect(shareWords(0.55)).toBe('about half');
    expect(shareWords(0.7)).toBe('most');
    expect(shareWords(0.3)).toBe('a large part');
  });
});
