import { describe, expect, it } from 'vitest';
import { centerConfigsPageUrl, centerWebBaseUrl } from './centerUrl';

describe('centerUrl', () => {
  it('normalizes center API base URL', () => {
    expect(centerWebBaseUrl('http://127.0.0.1:26630/api/')).toBe('http://127.0.0.1:26630');
    expect(centerWebBaseUrl('http://10.0.0.1:26630/')).toBe('http://10.0.0.1:26630');
  });

  it('builds configs hash route', () => {
    expect(centerConfigsPageUrl('http://127.0.0.1:26630')).toBe('http://127.0.0.1:26630/#/configs');
  });
});
