import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Spool } from '@/lib/api/spoolman';
import { SpoolReelDetails, SpoolSlotBadge } from './spool-reel-details';

const spool: Spool = {
  id: 1, registered: '', remaining_weight: 400, used_weight: 600,
  initial_weight: 1000, archived: false, extra: {}, location: 'AMS',
  filament: {
    id: 1, name: 'Green', material: 'PLA', vendor: null,
    color_hex: '078252', multi_color_hexes: null, multi_color_direction: null,
    density: 1.24, diameter: 1.75,
  },
};

const render = (overrides: Partial<Spool> = {}) => renderToStaticMarkup(
  createElement(SpoolReelDetails, { spool: { ...spool, ...overrides }, showLocation: true }),
);

describe('dashboard spool reels', () => {
  it.each([[0, 0], [400, 40], [1000, 100], [1500, 150]])(
    'shows %s g as %s percent on the 1000 g scale', (weight, percent) => {
      const html = render({ remaining_weight: weight });
      expect(html).toContain(`aria-label="${percent}% remaining"`);
      expect(html).toContain(`${weight} g remaining`);
      expect(html).toContain(`stroke-dasharray="${Math.min(percent, 100)} ${100 - Math.min(percent, 100)}"`);
    },
  );

  it.each([null, undefined, -1, NaN, Infinity])('keeps invalid weight %s distinct from an empty spool', weight => {
    const html = render({ remaining_weight: weight as number });
    expect(html).toContain('Remaining weight unknown');
    expect(html).not.toContain('stroke-dasharray=');
    expect(html).not.toContain('0% remaining');
  });

  it('splits the remaining arc across multiple filament colors', () => {
    const html = render({ filament: { ...spool.filament, multi_color_hexes: 'ff0000,00ff00' } });
    expect(html).toContain('stroke="#ff0000"');
    expect(html).toContain('stroke="#00ff00"');
    expect(html.match(/stroke-dasharray="20 80"/g)).toHaveLength(2);
    expect(html).toContain('stroke-dashoffset="-20"');
  });

  it('gives each reel its own gradient and hides location when disabled', () => {
    const html = renderToStaticMarkup(createElement('div', {},
      createElement(SpoolReelDetails, { spool }),
      createElement(SpoolReelDetails, { spool }),
    ));
    const ids = [...html.matchAll(/linearGradient id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
    expect(html).not.toContain('Location:');
  });

  it('keeps the accessible tray label with the numeric badge, including slot nine', () => {
    const html = renderToStaticMarkup(createElement(SpoolSlotBadge, { number: 9, label: 'Tray 9' }));
    expect(html).toContain('aria-label="Tray 9"');
    expect(html).toContain('>9</text>');
  });
});
