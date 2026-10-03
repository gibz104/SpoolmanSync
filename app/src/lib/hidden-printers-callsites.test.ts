import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every place that filters discovered printers against the removed ("hidden")
 * list must do it through filterHiddenPrinters, which matches on the HA config
 * entry id.
 *
 * This is a call-site test rather than a behaviour test because the bug it
 * guards was never a wrong algorithm — it was the same wrong algorithm copied
 * into several routes, and a fix that only reached one of them (#86). The
 * dashboard was corrected first while the automation-generating routes kept
 * matching the entry title as a substring, which quietly left real printers out
 * of the generated automations and therefore untracked.
 */

const SRC = join(__dirname, '..');
const DEFINES_HELPER = join('api', 'printers', 'setup', 'route.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

const files = sourceFiles(SRC).map(path => ({ path, text: readFileSync(path, 'utf8') }));
const rel = (path: string) => path.slice(SRC.length + 1);

describe('hidden printer filtering call sites (#86)', () => {
  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('routes a consumer of the hidden list through filterHiddenPrinters', () => {
    const consumers = files.filter(
      f => f.text.includes('getHiddenPrinters') && !f.path.endsWith(DEFINES_HELPER),
    );
    // The dashboard and both automation-generating actions.
    expect(consumers.length).toBeGreaterThanOrEqual(2);

    const unguarded = consumers
      .filter(f => !f.text.includes('filterHiddenPrinters'))
      .map(f => rel(f.path));
    expect(unguarded, 'reads the hidden printer list but does not use filterHiddenPrinters').toEqual([]);
  });

  it('matches no printer by its entry title', () => {
    // The signature of the old filter. A title is user-editable free text and a
    // substring of other printers' serials; only the entry id identifies one.
    const offenders = files
      .filter(f => /\.title\.toLowerCase\(\)/.test(f.text))
      .map(f => rel(f.path));
    expect(offenders, 'compares printers by entry title').toEqual([]);
  });

  it('leaves no copy of the old substring filter behind', () => {
    const offenders = files
      .filter(f => /name\.includes\(t\)|entityId\.includes\(t\)/.test(f.text))
      .map(f => rel(f.path));
    expect(offenders, 'still substring-matches a hidden title').toEqual([]);
  });
});
