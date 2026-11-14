'use client';

import { useSyncExternalStore } from 'react';
import { currentNfcBlocker, type NfcBlocker } from '@/lib/web-nfc';

const subscribe = () => () => {};

/**
 * Why this page cannot use Web NFC, or null if it can (see web-nfc.ts).
 * Undefined while the server renders and the page hydrates, which can't know.
 */
export function useNfcBlocker(): NfcBlocker | null | undefined {
  return useSyncExternalStore(subscribe, currentNfcBlocker, () => undefined);
}
