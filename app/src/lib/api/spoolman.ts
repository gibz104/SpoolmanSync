/**
 * Spoolman API client
 */

export interface Vendor {
  id: number;
  name: string;
  registered: string;
}

export interface Filament {
  id: number;
  name: string;
  vendor: Vendor | null;
  material: string;
  color_hex: string | null;
  multi_color_hexes: string | null;
  multi_color_direction: 'coaxial' | 'longitudinal' | null;
  density: number;
  diameter: number;
  weight?: number;
}

export interface Spool {
  id: number;
  filament: Filament;
  remaining_weight: number;
  used_weight: number;
  initial_weight: number;
  spool_weight?: number;
  registered: string;
  first_used?: string;
  last_used?: string;
  extra: Record<string, string>;
  comment?: string;
  archived: boolean;
  location?: string;
  lot_nr?: string;
}

export interface UpdateTrayPayload {
  spool_id: number;
  active_tray_id: string;
}

export interface ExtraField {
  key: string;
  name: string;
  field_type: string;
  unit?: string;
  default_value?: string;
  choices?: string[];
  multi_choice?: boolean;
  order?: number;
}

/**
 * Parse extra field value from JSON string
 * Spoolman stores extra values as JSON-encoded strings
 */
export function parseExtraValue(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return value;
  }
}

/**
 * Normalize a spool serial / RFID tag for comparison.
 *
 * Values reach us from three places that don't agree on formatting:
 *  - SpoolmanSync's own writes (`setSpoolTag`) — JSON-encoded, e.g. `"\"AB12\""`
 *  - hand-edits in Spoolman's UI or via its API — may be stored bare, e.g. `AB12`
 *  - ha-bambulab's `tray_uuid` attribute — casing is not guaranteed stable
 *
 * We unwrap the JSON encoding, then trim and case-fold, so a tag only fails to
 * match when it genuinely differs. Comparing raw strings here silently broke
 * auto-matching for anyone whose tag was entered by hand.
 *
 * Deliberately NOT parseExtraValue: that coerces any JSON value to a string, so
 * an all-numeric serial stored bare would be read as a number and come back
 * mangled ("1234...012" → "1.234...e+31", "1e5" → "100000"). A serial is always
 * an opaque identifier, so we only unwrap when the JSON value is a string and
 * otherwise keep the raw text exactly as written.
 */
export function normalizeTag(value: string | undefined | null): string {
  if (!value) return '';
  let unwrapped = value;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') unwrapped = parsed;
  } catch {
    // Not JSON — a bare, hand-entered value. Use it as-is.
  }
  return unwrapped.trim().toLowerCase();
}

/**
 * Build a searchable string from a spool object
 * Includes all fields for full-text search
 */
export function buildSpoolSearchValue(spool: Spool): string {
  const parts = [
    spool.id.toString(),
    spool.filament.vendor?.name,
    spool.filament.material,
    spool.filament.name,
    spool.filament.color_hex,
    spool.comment,
    spool.location,
    spool.lot_nr,
    spool.registered,
    spool.first_used,
    spool.last_used,
  ];

  // Add all extra field values
  if (spool.extra) {
    for (const value of Object.values(spool.extra)) {
      parts.push(parseExtraValue(value));
    }
  }

  return parts.filter(Boolean).join(' ');
}

/**
 * Built-in spool fields that can be used as filters
 */
export const BUILT_IN_FILTER_FIELDS = [
  { key: 'material', name: 'Material', builtIn: true },
  { key: 'vendor', name: 'Vendor', builtIn: true },
  { key: 'location', name: 'Location', builtIn: true },
  { key: 'lot_nr', name: 'Lot Number', builtIn: true },
] as const;

/**
 * Default filters enabled for new users
 */
export const DEFAULT_ENABLED_FILTERS = ['material', 'vendor'];

/**
 * Resolver function that converts entity_ids to stable unique_ids.
 * Provided by callers that have access to the HA entity registry.
 */
export type EntityIdResolver = (entityId: string) => Promise<string>;

/**
 * Resolver that maps a tray key (unique_id, entity_id, or virtual slot key) to a
 * human-readable Spoolman `location` label. Returns '' when the tray can't be
 * resolved (in which case the location field is left untouched). Provided by
 * callers only when location sync is enabled — see makeLocationResolver().
 */
export type LocationResolver = (trayKey: string) => Promise<string>;

/**
 * Spoolman's `location` field is `str | None` with max_length 64. Lives here
 * (with the API client) rather than in spool-location.ts so this module can
 * enforce it without importing the DB-backed settings layer, which would create
 * a circular import.
 */
export const SPOOLMAN_LOCATION_MAX = 64;

export class SpoolmanClient {
  private baseUrl: string;
  private entityIdResolver: EntityIdResolver | null = null;
  private locationResolver: LocationResolver | null = null;
  private unassignedLocation = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Set a resolver that converts entity_ids to unique_ids.
   * When set, all read-modify-write operations on the extra field will
   * defensively convert any entity_id in active_tray to a stable unique_id.
   * This prevents race conditions where concurrent Spoolman API calls
   * (e.g., PUT /spool/{id}/use) revert the extra field to stale data
   * containing entity_ids instead of unique_ids.
   */
  setEntityIdResolver(resolver: EntityIdResolver): void {
    this.entityIdResolver = resolver;
  }

  /**
   * Set a resolver that maps a tray key to a Spoolman `location` label. When set,
   * assignSpoolToTray writes the resolved label into the native `location` field,
   * and unassignSpoolFromTray clears it — but only if it still matches the label
   * we set (so a manually-set location is never destroyed). When not set (sync
   * disabled), the `location` field is left completely untouched.
   */
  setLocationResolver(resolver: LocationResolver): void {
    this.locationResolver = resolver;
  }

  /**
   * Optional "holding pen": where a spool's `location` goes when it is
   * unassigned, instead of being unset.
   *
   * Applies only inside the same guard as the clear — the location is replaced
   * only when it still equals the label SpoolmanSync wrote for the tray being
   * left, so a location set by hand is never overwritten. Has no effect unless
   * a location resolver is also set (i.e. location sync is enabled), and an
   * empty value keeps the original clear-on-unassign behavior.
   */
  setUnassignedLocation(location: string): void {
    this.unassignedLocation = (location || '').trim();
  }

  /**
   * Sanitize an extra object before writing to Spoolman.
   * Converts any entity_id in active_tray to a unique_id.
   */
  private async sanitizeExtra(extra: Record<string, string>): Promise<Record<string, string>> {
    if (!this.entityIdResolver) return extra;

    const activeTrayRaw = extra['active_tray'];
    if (!activeTrayRaw) return extra;

    try {
      const parsed = JSON.parse(activeTrayRaw);
      if (typeof parsed === 'string' && parsed.startsWith('sensor.')) {
        const uniqueId = await this.entityIdResolver(parsed);
        if (uniqueId !== parsed) {
          extra['active_tray'] = JSON.stringify(uniqueId);
        }
      }
    } catch {
      // Not valid JSON, leave as-is
    }

    return extra;
  }

  private async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Spoolman API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * Check if connection is valid
   */
  async checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get all spools
   */
  async getSpools(includeArchived = false): Promise<Spool[]> {
    const params = includeArchived ? '?allow_archived=true' : '';
    return this.fetch(`/spool${params}`);
  }

  /**
   * Get a spool by ID
   */
  async getSpool(id: number): Promise<Spool> {
    return this.fetch(`/spool/${id}`);
  }

  /**
   * Read Spoolman's user-managed location list.
   *
   * Spoolman keeps this in the `locations` *setting* (a JSON-encoded array of
   * strings), NOT on the spools — see its Locations page, which reads the same
   * setting. A location created there exists before any spool is moved into it,
   * and deleting one removes it from the setting while leaving the string on
   * whatever spools still sit in it.
   *
   * Returns [] on any failure. Older Spoolman versions have no such setting,
   * and the caller falls back to locations derived from spools.
   */
  async getConfiguredLocations(): Promise<string[]> {
    try {
      const setting = await this.fetch<{ value?: unknown }>('/setting/locations');
      if (typeof setting?.value !== 'string') return [];
      const parsed = JSON.parse(setting.value);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((v): v is string => typeof v === 'string')
        .map(v => v.trim())
        .filter(v => v.length > 0);
    } catch {
      // Not fatal: pre-locations Spoolman (404) or a transient failure.
      return [];
    }
  }

  /**
   * Update a spool (generic PATCH)
   */
  async updateSpool(id: number, data: Record<string, unknown>): Promise<Spool> {
    return this.fetch(`/spool/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * Get spools currently assigned to a tray
   */
  async getSpoolsByTray(trayId: string): Promise<Spool[]> {
    const spools = await this.getSpools();
    const jsonTrayId = JSON.stringify(trayId);
    return spools.filter(s => s.extra?.['active_tray'] === jsonTrayId);
  }

  /**
   * Assign a spool to a tray
   */
  async assignSpoolToTray(spoolId: number, trayId: string): Promise<Spool> {
    // First, unassign any spool currently in this tray
    const currentSpools = await this.getSpoolsByTray(trayId);
    for (const spool of currentSpools) {
      if (spool.id !== spoolId) {
        await this.unassignSpoolFromTray(spool.id);
      }
    }

    // Get current spool to preserve other extra fields (like tag)
    // Spoolman's PATCH replaces the entire extra object
    const spool = await this.getSpool(spoolId);
    const newExtra: Record<string, string> = {};
    if (spool.extra) {
      for (const [key, value] of Object.entries(spool.extra)) {
        newExtra[key] = value;
      }
    }
    newExtra['active_tray'] = JSON.stringify(trayId);

    // Build the PATCH body. `location` is a native top-level field (NOT in extra).
    const body: Record<string, unknown> = { extra: await this.sanitizeExtra(newExtra) };

    // If location sync is enabled, set the native location to reflect this tray.
    // An unresolved tray ('') leaves location untouched.
    if (this.locationResolver) {
      const label = await this.locationResolver(trayId);
      if (label) body.location = label;
    }

    // Assign the new spool
    return this.fetch(`/spool/${spoolId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * Unassign a spool from its current tray
   */
  async unassignSpoolFromTray(spoolId: number): Promise<Spool> {
    // Get current spool to preserve other extra fields
    const spool = await this.getSpool(spoolId);

    // Capture the tray we're leaving (before clearing it) so we can decide
    // whether to also clear the native location field.
    const oldTrayRaw = spool.extra?.['active_tray'];

    // Build new extra object with active_tray set to empty string
    // Spoolman's PATCH replaces the entire extra object, so we need to include
    // all fields we want to keep. Setting active_tray to "" clears the assignment.
    const newExtra: Record<string, string> = {};
    if (spool.extra) {
      for (const [key, value] of Object.entries(spool.extra)) {
        if (key !== 'active_tray') {
          newExtra[key] = value;
        }
      }
    }
    // Set active_tray to JSON-encoded empty string to clear it
    // Spoolman requires extra field values to be valid JSON
    newExtra['active_tray'] = JSON.stringify('');

    const body: Record<string, unknown> = { extra: await this.sanitizeExtra(newExtra) };

    // GUARDED location clear: only touch `location` if it still equals the label
    // we would have set for the tray being left. This means a location the user
    // set (or changed) by hand is never destroyed by an unassign.
    if (this.locationResolver && spool.location) {
      let oldTray = '';
      if (oldTrayRaw) {
        try {
          const parsed = JSON.parse(oldTrayRaw);
          if (typeof parsed === 'string') oldTray = parsed;
        } catch { /* not JSON — leave blank, we won't clear */ }
      }
      if (oldTray) {
        const label = await this.locationResolver(oldTray);
        if (label && label === spool.location) {
          // With a holding pen configured, park the spool there so it stays
          // visible in Spoolman's location views instead of vanishing from them.
          // Otherwise null, which truly unsets Spoolman's `str | None` field.
          body.location = this.unassignedLocation
            ? this.unassignedLocation.slice(0, SPOOLMAN_LOCATION_MAX)
            : null;
        }
      }
    }

    // Send the updated extra object with empty active_tray
    return this.fetch<Spool>(`/spool/${spoolId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * Store a Bambu spool serial number (tray_uuid) on a spool
   * The tray_uuid is the unique identifier for the physical spool, stored on both RFID tags.
   * Also clears this serial number from any other spools (since each spool has a unique SN)
   */
  async setSpoolTag(spoolId: number, trayUuid: string): Promise<Spool> {
    // First, clear this serial number from any other spools that have it
    await this.clearDuplicateTags(trayUuid, spoolId);

    // Get current spool to preserve other extra fields
    const spool = await this.getSpool(spoolId);

    // Build new extra object
    const newExtra: Record<string, string> = {};
    if (spool.extra) {
      for (const [key, value] of Object.entries(spool.extra)) {
        newExtra[key] = value;
      }
    }

    // Store the spool serial number
    newExtra['tag'] = JSON.stringify(trayUuid);

    return this.fetch<Spool>(`/spool/${spoolId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        extra: await this.sanitizeExtra(newExtra),
      }),
    });
  }

  /**
   * Clear a spool serial number from all spools except the specified one
   * Used to ensure spool SNs are unique across spools
   */
  async clearDuplicateTags(trayUuid: string, exceptSpoolId: number): Promise<void> {
    const spools = await this.getSpools();
    const target = normalizeTag(trayUuid);
    if (!target) return;

    for (const spool of spools) {
      if (spool.id === exceptSpoolId) continue;
      if (normalizeTag(spool.extra?.['tag']) !== target) continue;

      // Clear the tag from this spool
      const newExtra: Record<string, string> = {};
      if (spool.extra) {
        for (const [key, value] of Object.entries(spool.extra)) {
          if (key !== 'tag') {
            newExtra[key] = value;
          }
        }
      }
      newExtra['tag'] = JSON.stringify('');

      await this.fetch<Spool>(`/spool/${spool.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          extra: await this.sanitizeExtra(newExtra),
        }),
      });
    }
  }

  /**
   * Find a spool by its serial number (tray_uuid).
   * Comparison is normalized — see normalizeTag().
   */
  async findSpoolByTag(trayUuid: string): Promise<Spool | null> {
    const spools = await this.getSpools();
    const target = normalizeTag(trayUuid);
    if (!target) return null;

    return spools.find(s => normalizeTag(s.extra?.['tag']) === target) ?? null;
  }

  /**
   * Count spools that carry a non-empty serial/RFID tag. Used purely for
   * diagnostics: it distinguishes "nothing is tagged yet" (expected before a
   * spool's first tracked print) from "tags exist but none matched" (a real
   * mismatch worth investigating).
   */
  countTaggedSpools(spools: Spool[]): number {
    return spools.filter(s => normalizeTag(s.extra?.['tag']) !== '').length;
  }

  /**
   * Update spool weight (use filament)
   */
  async useWeight(spoolId: number, weight: number): Promise<void> {
    await this.fetch(`/spool/${spoolId}/use`, {
      method: 'PUT',
      body: JSON.stringify({ use_weight: weight }),
    });
  }

  /**
   * Get all vendors
   */
  async getVendors(): Promise<Vendor[]> {
    return this.fetch('/vendor');
  }

  /**
   * Get all filaments
   */
  async getFilaments(): Promise<Filament[]> {
    return this.fetch('/filament');
  }

  /**
   * Get all extra fields for spools
   */
  async getSpoolExtraFields(): Promise<ExtraField[]> {
    return this.fetch('/field/spool');
  }

  /**
   * Create or update an extra field for spools
   */
  async createSpoolExtraField(key: string, name: string, fieldType: string = 'text'): Promise<ExtraField[]> {
    return this.fetch(`/field/spool/${key}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        field_type: fieldType,
      }),
    });
  }

  /**
   * Ensure all required extra fields exist in Spoolman
   * This is required for SpoolmanSync to track tray assignments and barcode scanning
   */
  async ensureRequiredFieldsExist(): Promise<void> {
    const requiredFields = [
      { key: 'active_tray', name: 'active_tray', description: 'tray assignments' },
      { key: 'barcode', name: 'barcode', description: 'barcode/QR code scanning' },
      { key: 'tag', name: 'tag', description: 'Bambu spool serial number (tray_uuid) for auto-matching' },
    ];

    try {
      const existingFields = await this.getSpoolExtraFields();
      const existingKeys = new Set(existingFields.map(f => f.key));

      for (const field of requiredFields) {
        if (!existingKeys.has(field.key)) {
          await this.createSpoolExtraField(field.key, field.name, 'text');
        }
      }
    } catch (error) {
      console.error('[SpoolmanSync] Failed to ensure required fields exist:', error);
      throw new Error('Failed to configure Spoolman extra fields. Please ensure Spoolman is accessible and try again.');
    }
  }
}
