import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('core package surface', () => {
  it('exposes the main entry points', () => {
    expect(core.CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(core.CASE_SCHEMA_V1).toBe('midden.case.v1');
    expect(typeof core.apply).toBe('function');
    expect(typeof core.parseNmapXml).toBe('function');
    expect(typeof core.renderCommand).toBe('function');
    expect(core.TACTICS.length).toBe(14);
  });
});
