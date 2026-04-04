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
  extra?: Record<string, string>;
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

export class SpoolmanClient {
  private baseUrl: string;
  private entityIdResolver: EntityIdResolver | null = null;

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
  async getSpools(): Promise<Spool[]> {
    return this.fetch('/spool');
  }

  /**
   * Get a spool by ID
   */
  async getSpool(id: number): Promise<Spool> {
    return this.fetch(`/spool/${id}`);
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

    // Assign the new spool
    return this.fetch(`/spool/${spoolId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        extra: await this.sanitizeExtra(newExtra),
      }),
    });
  }

  /**
   * Unassign a spool from its current tray
   */
  async unassignSpoolFromTray(spoolId: number): Promise<Spool> {
    // Get current spool to preserve other extra fields
    const spool = await this.getSpool(spoolId);

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

    // Send the updated extra object with empty active_tray
    return this.fetch<Spool>(`/spool/${spoolId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        extra: await this.sanitizeExtra(newExtra),
      }),
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

    for (const spool of spools) {
      if (spool.id === exceptSpoolId) continue;

      const existingTagRaw = spool.extra?.['tag'];
      if (!existingTagRaw) continue;

      try {
        const parsed = JSON.parse(existingTagRaw);
        if (parsed === trayUuid) {
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
      } catch {
        // If parsing fails, skip this spool
      }
    }
  }

  /**
   * Find a spool by its serial number (tray_uuid)
   */
  async findSpoolByTag(trayUuid: string): Promise<Spool | null> {
    const spools = await this.getSpools();

    for (const spool of spools) {
      const existingTagRaw = spool.extra?.['tag'];
      if (!existingTagRaw) continue;

      try {
        const parsed = JSON.parse(existingTagRaw);
        if (parsed === trayUuid) {
          return spool;
        }
      } catch {
        // If parsing fails, skip this spool
      }
    }

    return null;
  }

  /**
   * Find a spool by Bambu filament_id (slicer profile ID stored in Spoolman filament extra field)
   * combined with color distance to pick the right color variant.
   *
   * filament_id alone covers a profile (e.g. all colors of "SUNLU PLA Meta"),
   * color then narrows to the specific spool (e.g. the green one vs the blue one).
   * Uses the same COLOR_THRESHOLD=40 as findSpoolByColorAndMaterial.
   */
  async findSpoolByFilamentIdAndColor(
    filamentId: string,
    rawColor: string,
  ): Promise<Spool | null> {
    const spools = await this.getSpools();
    const activeSpools = spools.filter(s => !s.archived);

    const normalizeColor = (c: string) => c.replace(/^#/, '').toLowerCase().slice(0, 6);
    const parseRgb = (hex: string): [number, number, number] | null => {
      if (hex.length !== 6) return null;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
      return [r, g, b];
    };
    const COLOR_THRESHOLD = 40;
    const colorDistance = (a: string, b: string): number => {
      const rgbA = parseRgb(a);
      const rgbB = parseRgb(b);
      if (!rgbA || !rgbB) return Infinity;
      return Math.sqrt(
        Math.pow(rgbA[0] - rgbB[0], 2) +
        Math.pow(rgbA[1] - rgbB[1], 2) +
        Math.pow(rgbA[2] - rgbB[2], 2),
      );
    };

    const targetColor = normalizeColor(rawColor);

    // Spoolman's /api/v1/spool returns filament objects with extra: {} always empty.
    // Filament extra fields (including filament_id) are only in /api/v1/filament.
    // Fetch filaments separately and build a lookup map: filament numeric id → bambu filament_id string.
    const allFilaments = await this.getFilaments();
    const filamentExtraMap = new Map<number, string>();
    for (const f of allFilaments) {
      const raw = f.extra?.['filament_id'];
      if (raw) {
        filamentExtraMap.set(f.id, parseExtraValue(raw));
      }
    }

    // Find spools whose filament has matching filament_id extra field
    const byId = activeSpools.filter(s => {
      return filamentExtraMap.get(s.filament.id) === filamentId;
    });

    if (byId.length === 0) return null;

    // Among those, find closest color within threshold
    const withDistance = byId
      .map(s => ({ spool: s, distance: colorDistance(normalizeColor(s.filament.color_hex ?? ''), targetColor) }))
      .filter(c => c.distance <= COLOR_THRESHOLD)
      .sort((a, b) => a.distance - b.distance);

    if (withDistance.length === 0) return null;
    if (withDistance.length === 1) return withDistance[0].spool;

    // Multiple within threshold — return closest only if it clearly wins
    if (withDistance[0].distance === withDistance[1].distance) {
      console.warn(
        `[SpoolmanSync] filament_id match: ambiguous color for filament_id=${filamentId}, color≈${targetColor}`,
      );
      return null;
    }

    return withDistance[0].spool;
  }

  /**
   * Find a spool by color hex + material type, with optional name hint for ranking.
   *
   * Handles non-Bambu spools (Sunlu etc.) that have no RFID serial.
   * AMS sends color as RRGGBBAA (8 chars) or RRGGBB (6 chars), with or without #.
   * Spoolman stores color_hex as 6-char hex without #.
   * Material is normalized: PLA+/PLA-HF → PLA, PETG-HF → PETG, ABS+ → ABS, etc.
   *
   * Color matching uses Euclidean RGB distance with threshold 40.
   * Bambu's machine display has a fixed palette — the closest two adjacent palette
   * colors (Red #C12E1F vs Terracotta #B15533) are ~47 units apart, so threshold 40
   * safely distinguishes them while absorbing manufacturer color variation.
   *
   * Returns the single best matching active spool, or null if 0 or 2+ equally scored.
   */
  async findSpoolByColorAndMaterial(
    rawColor: string,
    rawMaterial: string,
    nameHint?: string,
  ): Promise<{ spool: Spool; confidence: 'exact' | 'fuzzy' } | null> {
    const spools = await this.getSpools();
    const activeSpools = spools.filter(s => !s.archived);

    // Normalize color: strip #, take first 6 chars (drop alpha channel)
    const normalizeColor = (c: string) =>
      c.replace(/^#/, '').toLowerCase().slice(0, 6);

    // Parse 6-char hex string to [r, g, b]
    const parseRgb = (hex: string): [number, number, number] | null => {
      if (hex.length !== 6) return null;
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
      return [r, g, b];
    };

    // Euclidean RGB distance — max possible is ~441 (black to white)
    // Bambu palette neighbors are ≥47 apart, so threshold 40 won't cross-match
    const COLOR_THRESHOLD = 40;
    const colorDistance = (a: string, b: string): number => {
      const rgbA = parseRgb(a);
      const rgbB = parseRgb(b);
      if (!rgbA || !rgbB) return Infinity;
      return Math.sqrt(
        Math.pow(rgbA[0] - rgbB[0], 2) +
        Math.pow(rgbA[1] - rgbB[1], 2) +
        Math.pow(rgbA[2] - rgbB[2], 2),
      );
    };

    // Normalize material: uppercase, strip common suffixes/variants
    const normalizeMaterial = (m: string) =>
      m.toUpperCase()
        .replace(/[+-](HF|CF|GF|ST|MATTE|SILK|SPARKLE|GLOW)$/i, '')
        .replace(/\+$/, '')
        .trim();

    const targetColor = normalizeColor(rawColor);
    const targetMaterial = normalizeMaterial(rawMaterial);

    // Filter by material + color within threshold, tracking distance for ranking
    type Candidate = { spool: Spool; distance: number };
    const candidates: Candidate[] = activeSpools
      .filter(s => normalizeMaterial(s.filament.material ?? '') === targetMaterial)
      .map(s => ({
        spool: s,
        distance: colorDistance(normalizeColor(s.filament.color_hex ?? ''), targetColor),
      }))
      .filter(c => c.distance <= COLOR_THRESHOLD)
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
      const isExact = candidates[0].distance === 0;
      return { spool: candidates[0].spool, confidence: isExact ? 'exact' : 'fuzzy' };
    }

    // Multiple candidates within threshold — rank by name similarity if nameHint provided
    if (!nameHint) {
      console.warn(
        `[SpoolmanSync] Fuzzy match: ${candidates.length} spools match color≈${targetColor} material=${targetMaterial}, no name hint to disambiguate`,
      );
      return null;
    }

    const hintWords = nameHint.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = candidates.map(c => {
      const spoolText = [c.spool.filament.vendor?.name, c.spool.filament.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const matchCount = hintWords.filter(w => spoolText.includes(w)).length;
      return { spool: c.spool, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);

    // Only auto-assign if the top candidate clearly beats the second
    if (scored[0].score === 0 || scored[0].score === scored[1].score) {
      console.warn(
        `[SpoolmanSync] Fuzzy match: ambiguous name match for "${nameHint}" among ${candidates.length} candidates`,
      );
      return null;
    }

    return { spool: scored[0].spool, confidence: 'fuzzy' };
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
