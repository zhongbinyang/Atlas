import { describe, expect, it } from 'vitest';
import { centerConfigsPageUrl, centerWebBaseUrl } from './centerUrl';

describe('centerUrl', () => {
  it('strips trailing api and slash', () => {
    expect(centerWebBaseUrl('http://127.0.0.1:9080/api/')).toBe('http://127.0.0.1:9080');
    expect(centerWebBaseUrl('http://10.0.0.1:9080/')).toBe('http://10.0.0.1:9080');
  });

  it('builds configs deep link', () => {
    expect(centerConfigsPageUrl('http://127.0.0.1:9080')).toBe('http://127.0.0.1:9080/#/configs');
  });
});
