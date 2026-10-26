import { describe, it, expect } from 'vitest';
import { renamedTrayUniqueId } from './tray-id';

const ids = new Set([
  'x1c_01p00a000000001_ams_1_tray_1', 'x1c_01p00a000000001_ams_2_tray_1',
  'x1c_01p00a000000002_ams_1_tray_1', 'p1s_02_ams_1_tray_3', 'ke_virtual_external_spool',
  'x1c_01p00a000000001_externalspool_external_spool',
]);

describe('renamedTrayUniqueId', () => {
  it('uses the original entity id when it is the unique_id', () => {
    expect(renamedTrayUniqueId('sensor.x1c_01p00a000000002_ams_1_tray_1', ids)).toBe('x1c_01p00a000000002_ams_1_tray_1');
  });

  it('matches the tray suffix when only one tray has it', () => {
    expect(renamedTrayUniqueId('sensor.my_renamed_tray_3', ids)).toBe('p1s_02_ams_1_tray_3');
    // The synthesized slot of a single-spool printer has no entity, so is never a rival.
    expect(renamedTrayUniqueId('sensor.renamed_external_spool', ids)).toBe('x1c_01p00a000000001_externalspool_external_spool');
  });

  it('declines when several trays could be meant, rather than picking one', () => {
    expect(renamedTrayUniqueId('sensor.renamed_tray_1', ids)).toBeUndefined();
  });
});
