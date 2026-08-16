import { describe, expect, it } from 'vitest';
import { readBuildVersion } from './buildVersion';

describe('readBuildVersion', () => {
  it('returns the version string when present', () => {
    expect(
      readBuildVersion({
        version: '2026-08-16.d4279a7',
        date: '2026-08-16',
        git: 'd4279a7',
      }),
    ).toBe('2026-08-16.d4279a7');
  });

  it('returns null when version is missing, blank, or payload is not an object', () => {
    expect(readBuildVersion(null)).toBeNull();
    expect(readBuildVersion('2026-08-16.d4279a7')).toBeNull();
    expect(readBuildVersion({})).toBeNull();
    expect(readBuildVersion({ version: '   ' })).toBeNull();
    expect(readBuildVersion({ version: 1 })).toBeNull();
  });
});
