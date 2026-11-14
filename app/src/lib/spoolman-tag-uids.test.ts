import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpoolmanClient, TagHeldError } from './api/spoolman';

/**
 * Spoolman 0.27's native tags (#89): a tag's hardware UID identifies one spool
 * (or filament). The fake below follows Spoolman 0.27.1's API: GET
 * /spool?tag=, POST /spool/{id}/tag (409 naming the holder), DELETE
 * /spool/{id}/tag/{uid}. Before 0.27 the tag filter does not exist, and
 * Spoolman answers with every spool.
 */

interface FakeSpoolman {
  version: string;
  /** uid -> holder */
  tags: Map<string, { spool?: number; filament?: number }>;
  spools: number[];
  calls: string[];
}

function install(fake: FakeSpoolman) {
  const reply = (status: number, body?: unknown) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body ?? '') }) as unknown as Response;
  const spool = (id: number, withTags: boolean) => ({
    id, archived: false, extra: {}, filament: { id, name: `F${id}`, material: 'PLA' },
    ...(withTags ? { tags: [...fake.tags].filter(([, h]) => h.spool === id).map(([uid]) => ({ uid, format: null })) } : {}),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = url.replace('http://spoolman.test/api/v1', '');
    fake.calls.push(`${method} ${path}`);
    const modern = fake.version >= '0.27';
    if (path === '/info') return reply(200, { version: fake.version });
    const list = path.match(/^\/spool\?tag=(\w+)$/);
    if (method === 'GET' && list) {
      if (!modern) return reply(200, fake.spools.map(id => spool(id, false)));
      const holder = fake.tags.get(list[1]);
      return reply(200, holder?.spool ? [spool(holder.spool, true)] : []);
    }
    const link = path.match(/^\/spool\/(\d+)\/tag$/);
    if (method === 'POST' && link && modern) {
      const id = Number(link[1]);
      const { uid } = JSON.parse(opts.body as string);
      const holder = fake.tags.get(uid);
      if (holder && holder.spool !== id) {
        return reply(409, { message: 'Tag is linked elsewhere', spool_id: holder.spool ?? null, filament_id: holder.filament ?? null });
      }
      fake.tags.set(uid, { spool: id });
      return reply(201, { uid, format: null });
    }
    const unlink = path.match(/^\/spool\/(\d+)\/tag\/(\w+)$/);
    if (method === 'DELETE' && unlink && modern) {
      if (fake.tags.get(unlink[2])?.spool === Number(unlink[1])) fake.tags.delete(unlink[2]);
      return reply(204);
    }
    return reply(404, { detail: 'Not Found' });
  }));
}

const fake = (version: string, tags: [string, { spool?: number; filament?: number }][] = []): FakeSpoolman =>
  ({ version, tags: new Map(tags), spools: [1, 2, 3], calls: [] });

const client = () => new SpoolmanClient('http://spoolman.test');

afterEach(() => vi.unstubAllGlobals());

describe('supportsTagUids', () => {
  it('is true from Spoolman 0.27', async () => {
    for (const [version, expected] of [['0.26.1', false], ['0.27.0', true], ['0.27.1', true], ['0.28.0-dev', true], ['1.0.0', true]] as const) {
      install(fake(version));
      expect(await client().supportsTagUids()).toBe(expected);
    }
  });
});

describe('findSpoolByTagUid', () => {
  it('finds the spool a tag is linked to, whatever the spelling', async () => {
    install(fake('0.27.1', [['04A2B3C4', { spool: 2 }]]));
    expect((await client().findSpoolByTagUid('04:a2:b3:c4'))?.id).toBe(2);
  });

  it('finds nothing for an unlinked tag, or one that identifies a filament', async () => {
    install(fake('0.27.1', [['0A0B0C0D', { filament: 5 }]]));
    expect(await client().findSpoolByTagUid('04A2B3C4')).toBeNull();
    expect(await client().findSpoolByTagUid('0A0B0C0D')).toBeNull();
  });

  it('finds nothing on Spoolman before 0.27, which ignores the filter and lists every spool', async () => {
    const f = fake('0.26.1');
    install(f);
    expect(await client().findSpoolByTagUid('04A2B3C4')).toBeNull();
    expect(f.calls).toEqual(['GET /spool?tag=04A2B3C4']);
  });

  it('does not ask about text that is no UID', async () => {
    const f = fake('0.27.1');
    install(f);
    expect(await client().findSpoolByTagUid('not-a-uid')).toBeNull();
    expect(f.calls).toEqual([]);
  });
});

describe('linkTagUid', () => {
  it('links a new tag', async () => {
    const f = fake('0.27.1');
    install(f);
    expect(await client().linkTagUid(3, '04:a2:b3:c4')).toEqual({ movedFrom: null });
    expect(f.tags.get('04A2B3C4')).toEqual({ spool: 3 });
  });

  it('is a no-op for a tag the spool already holds', async () => {
    const f = fake('0.27.1', [['04A2B3C4', { spool: 3 }]]);
    install(f);
    expect(await client().linkTagUid(3, '04A2B3C4')).toEqual({ movedFrom: null });
    expect(f.calls).toEqual(['POST /spool/3/tag']);
  });

  it('moves a tag from the spool that held it', async () => {
    const f = fake('0.27.1', [['04A2B3C4', { spool: 1 }]]);
    install(f);
    expect(await client().linkTagUid(3, '04A2B3C4')).toEqual({ movedFrom: 1 });
    expect(f.tags.get('04A2B3C4')).toEqual({ spool: 3 });
    expect(f.calls).toEqual(['POST /spool/3/tag', 'DELETE /spool/1/tag/04A2B3C4', 'POST /spool/3/tag']);
  });

  it('leaves a tag that identifies a filament where it is', async () => {
    const f = fake('0.27.1', [['04A2B3C4', { filament: 5 }]]);
    install(f);
    await expect(client().linkTagUid(3, '04A2B3C4')).rejects.toBeInstanceOf(TagHeldError);
    expect(f.tags.get('04A2B3C4')).toEqual({ filament: 5 });
  });

  it('fails on Spoolman before 0.27', async () => {
    install(fake('0.26.1'));
    await expect(client().linkTagUid(3, '04A2B3C4')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses text that is no UID', async () => {
    install(fake('0.27.1'));
    await expect(client().linkTagUid(3, 'zz')).rejects.toThrow('not a tag UID');
  });
});

