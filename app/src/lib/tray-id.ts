/**
 * The unique_id of a tray whose entity was renamed after a spool was assigned
 * to it by entity_id (assignments made before trays were keyed by unique_id).
 *
 * The original entity_id is usually the unique_id itself. Failing that, the
 * tray suffix ("_tray_1") is matched, but only when exactly one tray has it:
 * every AMS of every printer has a "_tray_1", and a wrong answer is stored,
 * re-pointing the spool at another tray (or printer) for good. An assignment
 * left as an entity_id still works and can be re-assigned by hand.
 */
export function renamedTrayUniqueId(entityId: string, uniqueIds: ReadonlySet<string>): string | undefined {
  const bare = entityId.replace(/^sensor\./, '');
  if (uniqueIds.has(bare)) return bare;
  const suffix = entityId.match(/_(tray_\d+|external_spool\d*)$/)?.[0];
  if (!suffix) return undefined;
  const candidates = [...uniqueIds].filter(uid => uid.endsWith(suffix) && !uid.endsWith('_virtual_external_spool'));
  if (candidates.length > 1) console.warn(`[Migration] ${entityId} could be any of ${candidates.length} trays; leaving it as is`);
  return candidates.length === 1 ? candidates[0] : undefined;
}
