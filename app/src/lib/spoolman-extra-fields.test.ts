import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpoolmanClient } from './api/spoolman';

afterEach(() => vi.unstubAllGlobals());

/**
 * A Spoolman with one spool (id 1). GET /spool/1 hands out a snapshot that is
 * already stale: another client has since changed the spool's tag and note.
 * From 0.22.0 Spoolman merges a PATCH's extra fields by key; before that the
 * PATCH replaced the whole object. A null version makes /info fail.
 */
function fakeSpoolman(version: string | null) {
  const snapshot = {
    active_tray: JSON.stringify('printer_tray_1'),
    tag: JSON.stringify('old-tag'),
    custom_note: JSON.stringify('old note'),
  };
  const state = {
    extra: { ...snapshot, tag: JSON.stringify('new-tag'), custom_note: JSON.stringify('new note') } as Record<string, string>,
    patches: [] as Record<string, string>[],
  };
  const [major, minor] = (version ?? '0.0').split('.').map(Number);
  const merges = major > 0 || minor >= 22;

  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url.endsWith('/info')) {
      return version === null ? new Response('', { status: 500 }) : Response.json({ version });
    }
    if (options.method === 'PATCH') {
      const extra = JSON.parse(options.body as string).extra as Record<string, string>;
      state.patches.push(extra);
      state.extra = merges ? { ...state.extra, ...extra } : { ...extra };
      return Response.json({ id: 1, extra: state.extra });
    }
    if (url.endsWith('/spool')) return Response.json([{ id: 1, extra: state.extra }]);
    return Response.json({ id: 1, extra: snapshot });
  }));
  return state;
}

describe('tray writes preserve unrelated extra fields', () => {
  it.each(['assign', 'unassign'] as const)(
    '%s on Spoolman 0.22+ sends only the assignment, so it cannot undo another client\'s change',
    async (operation) => {
      const state = fakeSpoolman('0.27.1');

      const client = new SpoolmanClient('http://spoolman');
      if (operation === 'assign') {
        await client.assignSpoolToTray(1, 'printer_tray_2');
      } else {
        await client.unassignSpoolFromTray(1);
      }

      const activeTray = JSON.stringify(operation === 'assign' ? 'printer_tray_2' : '');
      expect(state.patches).toEqual([{ active_tray: activeTray }]);
      expect(state.extra).toEqual({
        active_tray: activeTray,
        tag: JSON.stringify('new-tag'),
        custom_note: JSON.stringify('new note'),
      });
    },
  );

  it.each(['0.21.0', null])(
    'sends every field back when Spoolman replaces the whole object (version %s)',
    async (version) => {
      const state = fakeSpoolman(version);

      await new SpoolmanClient('http://spoolman').assignSpoolToTray(1, 'printer_tray_2');

      // Spoolman before 0.22 would otherwise drop the serial and the user's own
      // field. A version that can't be read is treated the same way.
      expect(state.extra).toEqual({
        active_tray: JSON.stringify('printer_tray_2'),
        tag: JSON.stringify('old-tag'),
        custom_note: JSON.stringify('old note'),
      });
    },
  );

  it('stores a serial on Spoolman 0.22+ without rewriting the assignment', async () => {
    const state = fakeSpoolman('0.22.0');

    await new SpoolmanClient('http://spoolman').setSpoolTag(1, 'SERIAL1');

    expect(state.patches).toEqual([{ tag: JSON.stringify('SERIAL1') }]);
    expect(state.extra.active_tray).toBe(JSON.stringify('printer_tray_1'));
  });

  it('stores a serial on older Spoolman with the spool\'s other fields', async () => {
    const state = fakeSpoolman('0.21.0');

    await new SpoolmanClient('http://spoolman').setSpoolTag(1, 'SERIAL1');

    expect(state.extra).toEqual({
      active_tray: JSON.stringify('printer_tray_1'),
      tag: JSON.stringify('SERIAL1'),
      custom_note: JSON.stringify('old note'),
    });
  });
});
