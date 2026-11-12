import * as React from 'react';
import type { Spool } from '@/lib/api/spoolman';

// Self-contained SVG: no printer-card assets or Home Assistant session required.
export function SpoolReelDetails({ spool, showLocation }: { spool: Spool; showLocation?: boolean }) {
  const shadeId = React.useId();
  const weight = spool.remaining_weight;
  const known = typeof weight === 'number' && Number.isFinite(weight) && weight >= 0;
  // Prefer this roll's net weight, then the filament's nominal full weight.
  const fullWeight = [spool.initial_weight, spool.filament.weight].find(
    value => typeof value === 'number' && Number.isFinite(value) && value > 0,
  ) ?? 1000;
  const remainingPercent = known ? weight / fullWeight * 100 : 0;
  const percent = known ? Math.round(remainingPercent) : null;
  const amount = Math.min(100, remainingPercent);
  const colors = (spool.filament.multi_color_hexes || spool.filament.color_hex || 'cccccc')
    .split(',').map(hex => '#' + hex.trim().replace(/^#/, ''));
  const row = (label: string, value: string) => <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0, lineHeight: '1.85' }}>
    <span className="text-muted-foreground" style={{ fontSize: 11, flexShrink: 0 }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>{value}</span>
  </div>;
  return <>
    <div data-spool-reel-layout="1" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%', flex: 1, marginTop: 8, marginBottom: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="line-clamp-2" style={{ fontSize: 'clamp(14px,4.9cqw,18px)', fontWeight: 600, lineHeight: 1.3, minHeight: '2.6em', marginBottom: 10, overflowWrap: 'anywhere' }} title={spool.filament.name || spool.filament.material}>{spool.filament.name || spool.filament.material}</p>
        {row('Material:', spool.filament.material)}
        {row('Vendor:', spool.filament.vendor?.name || 'Unknown')}
        {showLocation && row('Location:', spool.location || '—')}
      </div>
      <div style={{ width: 'clamp(64px,32cqw,112px)', flexShrink: 0, textAlign: 'center' }}>
        <svg data-spool-reel="1" viewBox="0 0 110 110" style={{ display: 'block', width: '100%' }} role="img" aria-label={known ? `${percent}% remaining` : 'Remaining weight unknown'}>
          <defs><linearGradient id={shadeId} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".18" /><stop offset="1" stopColor="#000" stopOpacity=".16" /></linearGradient></defs>
          <g transform="translate(55 55)">
            <circle r="51" fill="#282828" stroke="#686868" strokeWidth="3" />
            {known && colors.map((color, i) => <circle key={i} cx="0" cy="0" r="34" fill="none" stroke={color} strokeWidth="25" pathLength="100" strokeDasharray={`${amount / colors.length} ${100 - amount / colors.length}`} strokeDashoffset={-i * amount / colors.length} transform="rotate(-90)" />)}
            <circle r="46" fill={`url(#${shadeId})`} />
            <circle r="20" fill="#131313" stroke="#555" strokeWidth="4" />
            <path d="M35 0h9" stroke="#888" strokeOpacity=".5" strokeWidth="6" strokeLinecap="round" />
          </g>
        </svg>
        <div style={{ fontSize: 20, fontWeight: 650, marginTop: 4 }}>{known ? `${percent}%` : 'Unknown'}</div>
        <div className="text-muted-foreground" style={{ fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>{known ? `${Math.round(weight)} g remaining` : 'Remaining weight unknown'}</div>
      </div>
    </div>
    <div className="text-muted-foreground" style={{ fontSize: 10, marginTop: 'auto' }}>#{spool.id}</div>
  </>;
}

export function SpoolSlotBadge({ number, label }: { number: number; label: string }) {
  return <svg data-spool-slot-badge="1" width="23" height="23" viewBox="0 0 32 32" role="img" aria-label={label} style={{ flexShrink: 0 }}>
    <rect x="1" y="1" width="29" height="29" rx="14" fill="#404040" stroke="#777" strokeWidth=".6" />
    <text x="15" y="25" fontSize="25" textAnchor="middle" fill="#ddd">{number}</text>
  </svg>;
}
