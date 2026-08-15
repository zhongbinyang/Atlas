import { describe, expect, it } from 'vitest';
import { displayOptional } from './runDisplay';

describe('displayOptional', () => {
  it('shows an em dash when empty', () => {
    expect(displayOptional('')).toBe('—');
    expect(displayOptional(undefined)).toBe('—');
    expect(displayOptional('SN001')).toBe('SN001');
  });
});
