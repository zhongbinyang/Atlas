import { describe, expect, it } from 'vitest';
import {
  parseBoundToken,
  parseSpecIni,
  prepareSpecFromRows,
  specDocumentToJson,
  specToEditableRows,
  suggestSaveAsName,
} from './specIni';

describe('parseSpecIni', () => {
  it('parses_ul_ll_pairs', () => {
    const ini = `
[FMT_HT]
TX_AP_UL = 4.0
TX_AP_LL = -2
`;
    const r = parseSpecIni(ini);
    const sec = r.document.sections['FMT_HT'];
    const tx = sec['TX_AP'];
    expect(tx.min).toBe(-2);
    expect(tx.max).toBe(4);
  });

  it('inf_is_unbounded', () => {
    const ini = '[S]\nJitterRMS_UL = inf\nJitterRMS_LL = -inf\n';
    const r = parseSpecIni(ini);
    const sec = r.document.sections['S'];
    const j = sec['JitterRMS'];
    expect(j.min).toBeNull();
    expect(j.max).toBeNull();
  });

  it('ignores_standalone_keys', () => {
    const ini = '[S]\nMax_Ber_Curve=6\nTX_AP_UL=1\nTX_AP_LL=0\n';
    const r = parseSpecIni(ini);
    const sec = r.document.sections['S'];
    expect(sec).not.toHaveProperty('Max_Ber_Curve');
    expect(sec).toHaveProperty('TX_AP');
  });

  it('scientific_notation', () => {
    const ini = '[S]\nQk_Csen_BER_UL = 8E-5\nQk_Csen_BER_LL = 1E-5\n';
    const r = parseSpecIni(ini);
    const sec = r.document.sections['S'];
    const q = sec['Qk_Csen_BER'];
    expect(Math.abs(q.max! - 8e-5)).toBeLessThan(1e-10);
  });

  it('errors_on_zero_sections', () => {
    const ini = 'TX_AP_UL = 1\n';
    expect(() => parseSpecIni(ini)).toThrow('no sections found in spec INI');
  });
});

describe('specDocumentToJson', () => {
  it('spec_document_to_json_null_for_unbounded', () => {
    const ini = '[S]\nJitterRMS_UL = inf\nJitterRMS_LL = -inf\n';
    const doc = parseSpecIni(ini).document;
    const json = specDocumentToJson(doc);
    expect(json.version).toBe(1);
    expect(json.sections['S']['JitterRMS'].min).toBeNull();
    expect(json.sections['S']['JitterRMS'].max).toBeNull();
  });
});

describe('spec editable rows', () => {
  it('roundtrips spec JSON through editable rows', () => {
    const spec = {
      version: 1 as const,
      sections: {
        FMT_HT: { TX_AP: { min: -2, max: 4 } },
      },
    };
    const rows = specToEditableRows(spec);
    expect(rows).toEqual([
      expect.objectContaining({ section: 'FMT_HT', metric: 'TX_AP', min: '-2', max: '4' }),
    ]);
    expect(prepareSpecFromRows(rows)).toEqual({
      ok: true,
      spec: {
        version: 1,
        sections: { FMT_HT: { TX_AP: { min: -2, max: 4 } } },
      },
    });
  });

  it('treats empty and infinity tokens as unbounded', () => {
    expect(
      prepareSpecFromRows([
        { _key: '1', section: 'S', metric: 'Jitter', min: '', max: 'inf' },
      ]),
    ).toEqual({
      ok: true,
      spec: { version: 1, sections: { S: { Jitter: { min: null, max: null } } } },
    });
  });

  it('rejects duplicate section+metric and incomplete rows', () => {
    expect(
      prepareSpecFromRows([
        { _key: '1', section: 'A', metric: 'M', min: '0', max: '1' },
        { _key: '2', section: 'A', metric: 'M', min: '2', max: '3' },
      ]),
    ).toEqual({ ok: false, error: '重复项：[A] M' });
    expect(
      prepareSpecFromRows([{ _key: '1', section: 'A', metric: '', min: '0', max: '1' }]),
    ).toEqual({ ok: false, error: 'Section 和指标必须同时填写' });
  });
});

describe('suggestSaveAsName', () => {
  it('appends 副本 and keeps an existing suffix', () => {
    expect(suggestSaveAsName('FMT HT')).toBe('FMT HT 副本');
    expect(suggestSaveAsName('FMT HT 副本')).toBe('FMT HT 副本');
    expect(suggestSaveAsName('   ')).toBe('Spec 模板 副本');
  });
});

describe('parseBoundToken', () => {
  it('parses numeric values', () => {
    expect(parseBoundToken('4.0')).toBe(4);
    expect(parseBoundToken('  -2  ')).toBe(-2);
    expect(parseBoundToken('8E-5')).toBe(8e-5);
  });

  it('returns null for infinity tokens', () => {
    expect(parseBoundToken('inf')).toBeNull();
    expect(parseBoundToken('+inf')).toBeNull();
    expect(parseBoundToken('infinity')).toBeNull();
    expect(parseBoundToken('-inf')).toBeNull();
    expect(parseBoundToken('-infinity')).toBeNull();
    expect(parseBoundToken('INF')).toBeNull();
  });
});
