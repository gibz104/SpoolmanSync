import { describe, it, expect } from 'vitest';
import { parsePrinterOrder, isPrinterOrder, sortPrinters, movePrinter, mergePrinterOrder } from './printer-order';

const printers = (...prefixes: string[]) => prefixes.map(prefix => ({ prefix, name: prefix.toUpperCase() }));
const prefixes = (list: { prefix: string }[]) => list.map(p => p.prefix);

describe('sortPrinters', () => {
  it('puts the printers in the stored order', () => {
    expect(prefixes(sortPrinters(printers('a1', 'p1s', 'x1c'), ['x1c', 'a1', 'p1s']))).toEqual(['x1c', 'a1', 'p1s']);
  });

  it('keeps printers the order does not list after the rest, in the order they were found', () => {
    // A printer added later, and a virtual printer (dry box) created later.
    expect(prefixes(sortPrinters(printers('a1', 'new', 'x1c', 'virtual_2'), ['x1c', 'a1'])))
      .toEqual(['x1c', 'a1', 'new', 'virtual_2']);
  });

  it('ignores stored printers that are gone, and leaves the found order alone without an order', () => {
    expect(prefixes(sortPrinters(printers('a1', 'x1c'), ['gone', 'x1c']))).toEqual(['x1c', 'a1']);
    expect(prefixes(sortPrinters(printers('a1', 'x1c'), []))).toEqual(['a1', 'x1c']);
  });
});

describe('movePrinter', () => {
  it('swaps a printer with its neighbour', () => {
    expect(movePrinter(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(movePrinter(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('does nothing past either end or for an unknown printer', () => {
    expect(movePrinter(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
    expect(movePrinter(['a', 'b'], 'b', 1)).toEqual(['a', 'b']);
    expect(movePrinter(['a', 'b'], 'zz', 1)).toEqual(['a', 'b']);
  });
});

describe('mergePrinterOrder', () => {
  it('keeps a place for stored printers that are not shown right now', () => {
    expect(mergePrinterOrder(['b', 'a'], ['a', 'offline', 'b'])).toEqual(['b', 'a', 'offline']);
  });

  it('stays bounded', () => {
    const stored = Array.from({ length: 150 }, (_, i) => `p${i}`);
    expect(mergePrinterOrder(['x'], stored)).toHaveLength(100);
  });
});

describe('parsePrinterOrder and isPrinterOrder', () => {
  it('read a stored order, and treat anything unreadable as none', () => {
    expect(parsePrinterOrder('["x1c","a1"]')).toEqual(['x1c', 'a1']);
    expect(parsePrinterOrder('["x1c",3,null]')).toEqual(['x1c']);
    for (const bad of [null, undefined, '', 'not json', '{"a":1}', '"x1c"']) expect(parsePrinterOrder(bad)).toEqual([]);
  });

  it('accept only a bounded list of non-empty strings from a request', () => {
    expect(isPrinterOrder(['x1c_00m09d462101575', 'virtual_3'])).toBe(true);
    expect(isPrinterOrder([])).toBe(true);
    for (const bad of ['x1c', null, [1], [''], ['x'.repeat(201)], Array(101).fill('p'), { 0: 'a' }]) {
      expect(isPrinterOrder(bad)).toBe(false);
    }
  });
});
