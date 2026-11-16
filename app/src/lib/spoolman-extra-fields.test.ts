import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpoolmanClient } from './api/spoolman';

afterEach(() => vi.unstubAllGlobals());

describe('tray writes preserve unrelated extra fields', () => {
  it.each(['assign', 'unassign'] as const)(
    '%s does not replay stale extra fields over concurrent updates',
    async (operation) => {
      const originalExtra = {
        active_tray: JSON.stringify('printer_tray_1'),
        tag: JSON.stringify('old-tag'),
        custom_note: JSON.stringify('old note'),
      };
      const currentExtra = {
        ...originalExtra,
        tag: JSON.stringify('new-tag'),
        custom_note: JSON.stringify('new note'),
      };
      const patches: unknown[] = [];

      vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
        if (options.method === 'PATCH') {
          if (typeof options.body !== 'string') throw new Error('Expected JSON body');
          const body = JSON.parse(options.body);
          patches.push(body.extra);
          // Spoolman merges extra fields by key. Another client has already
          // updated tag/custom_note since the snapshot returned by GET.
          Object.assign(currentExtra, body.extra);
          return Response.json({ id: 1, extra: currentExtra });
        }
        return Response.json(url.endsWith('/spool')
          ? []
          : { id: 1, extra: originalExtra });
      }));

      const client = new SpoolmanClient('http://spoolman');
      if (operation === 'assign') {
        await client.assignSpoolToTray(1, 'printer_tray_2');
      } else {
        await client.unassignSpoolFromTray(1);
      }

      const activeTray = JSON.stringify(operation === 'assign' ? 'printer_tray_2' : '');
      expect(currentExtra).toEqual({
        active_tray: activeTray,
        tag: JSON.stringify('new-tag'),
        custom_note: JSON.stringify('new note'),
      });
      expect(patches).toEqual([{ active_tray: activeTray }]);
    },
  );
});
