import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/spool/show/[id]/route';
import { ingressPathFromHeader } from './ingress-path';
import { parseScanLink, spoolIdFromSegment } from './scan-codes';

/**
 * Spoolman's spool links (/spool/show/<id>) open SpoolmanSync's scan page, so
 * a label made for Spoolman works once SpoolmanSync's address replaces
 * Spoolman's.
 */

function show(id: string, headers: Record<string, string> = {}) {
  const request = new NextRequest(`http://homeassistant.local:3000/spool/show/${id}`, { headers });
  return GET(request, { params: Promise.resolve({ id }) });
}

describe('/spool/show/<id>', () => {
  it("sends a Spoolman spool link on to the spool's scan page", async () => {
    const res = await show('12');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/scan/spool/12');
    expect(parseScanLink(res.headers.get('location')!)).toEqual({ kind: 'spool', id: 12 });
  });

  it('reads an id with leading zeros as the same spool', async () => {
    expect((await show('007')).headers.get('location')).toBe('/scan/spool/7');
  });

  it("keeps Home Assistant's ingress base path", async () => {
    const res = await show('12', { 'x-ingress-path': '/api/hassio_ingress/aB3-x_Y9' });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/api/hassio_ingress/aB3-x_Y9/scan/spool/12');
    const trailing = await show('12', { 'x-ingress-path': '/api/hassio_ingress/aB3-x_Y9/' });
    expect(trailing.headers.get('location')).toBe('/api/hassio_ingress/aB3-x_Y9/scan/spool/12');
  });

  it('never redirects to another site, whatever the ingress header says', async () => {
    for (const header of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/../x', '/a b', '']) {
      expect((await show('12', { 'x-ingress-path': header })).headers.get('location')).toBe('/scan/spool/12');
    }
  });

  it('answers 404 for anything that is not a spool id', async () => {
    for (const id of ['abc', '12abc', '-1', '1.5', '1e3', ' 12', '', '99999999999999999999']) {
      const res = await show(id);
      expect(res.status, id).toBe(404);
      expect(res.headers.get('location'), id).toBeNull();
    }
  });
});

describe('spoolIdFromSegment', () => {
  it('reads whole numbers only', () => {
    expect(spoolIdFromSegment('31')).toBe(31);
    expect(spoolIdFromSegment('0')).toBe(0);
    expect(spoolIdFromSegment('31?x')).toBeNull();
    expect(spoolIdFromSegment('0x1F')).toBeNull();
    expect(spoolIdFromSegment(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});

describe('ingressPathFromHeader', () => {
  it('gives the base path through ingress and nothing outside it', () => {
    expect(ingressPathFromHeader('/api/hassio_ingress/abc123')).toBe('/api/hassio_ingress/abc123');
    expect(ingressPathFromHeader(null)).toBe('');
    expect(ingressPathFromHeader('/')).toBe('');
    expect(ingressPathFromHeader('//evil.example/x')).toBe('');
  });
});
