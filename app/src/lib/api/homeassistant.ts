/**
 * Home Assistant API client
 * Supports both OAuth2 (external) and trusted networks (embedded) authentication
 *
 * Entity discovery uses HA's WebSocket API to fetch the entity/device registries.
 * Bambu Lab printers are matched by translation_key (stable metadata set by ha-bambulab).
 * Creality printers are matched by entity_id patterns from ha_creality_ws.
 */

import prisma from '@/lib/db';
import WebSocket from 'ws';
import { normalizeCrealityColorHex } from '@/lib/creality';

export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HAAutomation {
  id: string;
  alias: string;
  description?: string;
  trigger: unknown[];
  condition?: unknown[];
  action: unknown[];
  mode?: string;
}

export type PrinterBrand = 'bambu_lab' | 'creality' | 'virtual';

export interface HAPrinter {
  brand: PrinterBrand;
  entity_id: string;
  name: string;
  state: string;
  prefix: string;  // Stable prefix for YAML entity naming (derived from unique_id)
  ams_units: HAAMS[];
  external_spools: HATray[];
  current_stage_entity?: string;
  print_weight_entity?: string;
  print_progress_entity?: string;
  used_material_entity?: string;  // Creality's used_material_length sensor (cm)
  is_virtual?: boolean;  // True for user-defined virtual printers (dry boxes/dryers)
}

export interface HAAMS {
  entity_id: string;
  name: string;
  ams_number: number;  // 1-4 for regular AMS, 128+ for AMS HT
  trays: HATray[];
}

// HA Entity/Device Registry types (fetched via WebSocket API)
interface EntityRegistryEntry {
  entity_id: string;
  platform: string;
  device_id: string | null;
  translation_key: string | null;
  translation_placeholders: Record<string, string> | null;
  disabled_by: string | null;
  unique_id: string;
}

interface DeviceRegistryEntry {
  id: string;
  identifiers: [string, string][];
  via_device_id: string | null;
  manufacturer: string | null;
  model: string | null;
  name: string | null;
  name_by_user: string | null;
}

export interface HATray {
  entity_id: string;
  unique_id?: string;     // Stable ID from entity registry (survives entity renames)
  tray_number: number;
  is_external?: boolean;  // True for external spool slots
  name?: string;  // Filament name from RFID (e.g., "Matte Dark Blue")
  color?: string;
  material?: string;
  tray_uuid?: string;  // Spool serial number (unique per physical spool). Bambu only —
                       // Creality exposes no per-spool identifier (see src/lib/creality.ts).
  remaining_weight?: number;
}

/**
 * Check if running in embedded HA mode
 */
export function isEmbeddedMode(): boolean {
  return process.env.HA_MODE === 'embedded';
}

/**
 * Check if running as a Home Assistant add-on
 * Add-ons use the Supervisor API with SUPERVISOR_TOKEN for authentication
 */
export function isAddonMode(): boolean {
  return process.env.HA_MODE === 'addon' && !!process.env.SUPERVISOR_TOKEN;
}

/**
 * Get the Supervisor API URL for add-on mode
 * The Supervisor proxies requests to Home Assistant Core
 * Note: We return the base URL without /api since the fetch method adds it
 */
export function getSupervisorHAUrl(): string {
  return 'http://supervisor/core';
}

/**
 * Get the Supervisor token for add-on authentication
 */
export function getSupervisorToken(): string | null {
  return process.env.SUPERVISOR_TOKEN || null;
}

/**
 * Get the embedded HA URL
 */
export function getEmbeddedHAUrl(): string {
  return process.env.HA_URL || 'http://homeassistant:8123';
}

/**
 * Onboarding status response
 */
interface OnboardingStep {
  step: string;
  done: boolean;
}

/**
 * Check if HA needs onboarding (accessible without auth)
 */
export async function checkHAOnboardingStatus(baseUrl: string): Promise<{ needsOnboarding: boolean; steps?: string[]; error?: string }> {
  try {
    console.log(`Checking HA onboarding status at ${baseUrl}/api/onboarding`);
    const response = await fetch(`${baseUrl}/api/onboarding`);
    console.log(`Onboarding check response: ${response.status}`);

    if (response.status === 404) {
      // Onboarding complete - API returns 404 when done
      console.log('Onboarding already complete (404)');
      return { needsOnboarding: false };
    }
    if (response.status === 200) {
      // HA API returns an array of steps directly
      const steps: OnboardingStep[] = await response.json();
      console.log('Onboarding data:', JSON.stringify(steps));
      const pendingSteps = steps.filter(s => !s.done).map(s => s.step);
      if (pendingSteps.length > 0) {
        console.log('Onboarding needed, pending steps:', pendingSteps);
        return { needsOnboarding: true, steps: pendingSteps };
      }
      console.log('All onboarding steps complete');
      return { needsOnboarding: false };
    }
    // Unexpected status - HA might not be ready
    console.error('Unexpected onboarding status:', response.status);
    return { needsOnboarding: false, error: `Unexpected status: ${response.status}` };
  } catch (err) {
    console.error('Error checking HA onboarding:', err);
    return { needsOnboarding: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Generate a random password for HA accounts
 */
export function generateRandomPassword(length: number = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  const randomValues = new Uint32Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    password += chars[randomValues[i] % chars.length];
  }
  return password;
}

/**
 * Complete HA onboarding automatically (for embedded mode)
 * Creates a service account for SpoolmanSync to use internally
 * Returns the access token and service password if successful
 */
export async function completeHAOnboarding(baseUrl: string): Promise<{
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  servicePassword?: string;
  error?: string;
}> {
  try {
    console.log('Starting automatic HA onboarding...');

    // Generate random password for service account
    const servicePassword = generateRandomPassword();

    // Step 1: Create owner user for HA access
    // This user is used both by SpoolmanSync (via access token) and by users to login to HA
    const userResponse = await fetch(`${baseUrl}/api/onboarding/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'http://spoolmansync',
        name: 'Admin',
        username: 'admin',
        password: servicePassword,
        language: 'en',
      }),
    });

    if (!userResponse.ok) {
      const error = await userResponse.text();
      console.error('Failed to create user:', error);
      return { success: false, error: `Failed to create user: ${error}` };
    }

    const userData = await userResponse.json();
    const authCode = userData.auth_code;
    console.log('User created, got auth code');

    // Step 2: Exchange auth code for tokens
    const tokenResponse = await fetch(`${baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: 'http://spoolmansync',
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error('Failed to get tokens:', error);
      return { success: false, error: `Failed to get tokens: ${error}` };
    }

    const tokens = await tokenResponse.json();
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    console.log('Got access token');

    // Step 3: Complete core config
    await fetch(`${baseUrl}/api/onboarding/core_config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    console.log('Core config done');

    // Step 4: Skip analytics
    await fetch(`${baseUrl}/api/onboarding/analytics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    console.log('Analytics done');

    // Step 5: Complete integration step
    // client_id and redirect_uri are required by HA's schema
    await fetch(`${baseUrl}/api/onboarding/integration`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        client_id: 'http://spoolmansync',
        redirect_uri: `${baseUrl}/`,
      }),
    });
    console.log('Integration done');

    console.log('HA onboarding completed successfully!');
    // Calculate token expiry (HA tokens typically expire in 30 min)
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    return { success: true, accessToken, refreshToken, expiresAt, servicePassword };
  } catch (err) {
    console.error('Error during HA onboarding:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export class HomeAssistantClient {
  private baseUrl: string;
  private clientId: string;
  private accessToken: string | null;
  private refreshToken: string | null;
  private expiresAt: Date | null;
  private embeddedMode: boolean;
  private addonMode: boolean;
  private refreshPromise: Promise<void> | null = null;

  /**
   * Authenticate with HA using username/password via the login flow API.
   * Used to re-authenticate when refresh tokens are invalidated (e.g., password change).
   *
   * Three-step flow:
   * 1. POST /auth/login_flow - start flow, get flow_id
   * 2. POST /auth/login_flow/{flow_id} - submit credentials, get auth code
   * 3. POST /auth/token - exchange auth code for tokens
   *
   * Returns null on any failure (invalid credentials, HA unreachable, etc.)
   */
  static async loginWithCredentials(
    baseUrl: string,
    username: string,
    password: string,
    clientId: string = 'http://spoolmansync'
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date } | null> {
    try {
      // Step 1: Start the login flow
      const flowResponse = await fetch(`${baseUrl}/auth/login_flow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          handler: ['homeassistant', null],
          redirect_uri: `${clientId}/`,
        }),
      });

      if (!flowResponse.ok) {
        console.error('Failed to start login flow:', flowResponse.status);
        return null;
      }

      const flowData = await flowResponse.json();
      const flowId = flowData.flow_id;

      // Step 2: Submit credentials
      const loginResponse = await fetch(`${baseUrl}/auth/login_flow/${flowId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          username,
          password,
        }),
      });

      if (!loginResponse.ok) {
        console.error('Login flow submission failed:', loginResponse.status);
        return null;
      }

      const loginData = await loginResponse.json();

      if (loginData.type !== 'create_entry') {
        console.error('Login flow did not create entry:', loginData.type, loginData.errors);
        return null;
      }

      const authCode = loginData.result;

      // Step 3: Exchange auth code for tokens
      const tokenResponse = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          client_id: clientId,
        }),
      });

      if (!tokenResponse.ok) {
        console.error('Token exchange failed:', tokenResponse.status);
        return null;
      }

      const tokens = await tokenResponse.json();
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 1800) * 1000);

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      };
    } catch (err) {
      console.error('loginWithCredentials failed:', err);
      return null;
    }
  }

  constructor(
    baseUrl: string,
    accessToken?: string | null,
    refreshToken?: string | null,
    expiresAt?: Date | null,
    embeddedMode: boolean = false,
    clientId: string = 'http://spoolmansync',
    addonMode: boolean = false
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId;
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    this.expiresAt = expiresAt || null;
    this.embeddedMode = embeddedMode;
    this.addonMode = addonMode;
  }

  /**
   * Create a client for embedded mode (trusted networks, no auth needed)
   */
  static forEmbedded(): HomeAssistantClient {
    return new HomeAssistantClient(
      getEmbeddedHAUrl(),
      null,
      null,
      null,
      true
    );
  }

  /**
   * Create a client for add-on mode (uses Supervisor token)
   * The Supervisor token never expires while the add-on is running
   */
  static forAddon(): HomeAssistantClient | null {
    const token = getSupervisorToken();
    if (!token) {
      console.error('SUPERVISOR_TOKEN not available in add-on mode');
      return null;
    }
    return new HomeAssistantClient(
      getSupervisorHAUrl(),
      token,
      null, // No refresh token needed - Supervisor manages this
      null, // Token doesn't expire while add-on runs
      false,
      'http://spoolmansync',
      true // addonMode
    );
  }

  /**
   * Create a client from the stored connection or embedded/addon mode
   * Returns null if no valid connection/credentials exist
   */
  static async fromConnection(): Promise<HomeAssistantClient | null> {
    // Add-on mode: use Supervisor token, no database lookup needed
    if (isAddonMode()) {
      return HomeAssistantClient.forAddon();
    }

    // Check for stored connection first (works for both embedded and external)
    const connection = await prisma.hAConnection.findFirst();

    if (isEmbeddedMode()) {
      const haUrl = getEmbeddedHAUrl();
      // In embedded mode, require stored credentials from auto-onboarding
      if (connection) {
        return new HomeAssistantClient(
          haUrl,
          connection.accessToken,
          connection.refreshToken,
          connection.expiresAt,
          true,
          connection.clientId
        );
      }
      // No stored connection - auto-onboarding hasn't completed yet
      // The settings API handles onboarding, so return null here
      return null;
    }

    // External mode - require stored connection
    if (!connection) return null;

    return new HomeAssistantClient(
      connection.url,
      connection.accessToken,
      connection.refreshToken,
      connection.expiresAt,
      false,
      connection.clientId
    );
  }

  // Refresh the token this many ms before it actually expires, so the token
  // doesn't lapse between the expiry check and the subsequent API call.
  private static readonly TOKEN_REFRESH_MARGIN_MS = 60_000;

  /**
   * Refresh the access token if expired (or about to expire)
   */
  private async ensureValidToken(): Promise<void> {
    // Add-on mode: Supervisor token is always valid while add-on runs
    if (this.addonMode) {
      return;
    }

    // If no expiry set, or not expiring within the safety margin, token is valid
    if (
      !this.expiresAt ||
      new Date(Date.now() + HomeAssistantClient.TOKEN_REFRESH_MARGIN_MS) < this.expiresAt
    ) {
      return;
    }

    // If no refresh token, can't refresh
    if (!this.refreshToken) {
      throw new Error('Access token expired and no refresh token available');
    }

    // Coalesce concurrent refreshes: if one is already in flight, await it
    // instead of firing a second refresh request.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshAccessToken();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Perform the actual token refresh against HA's /auth/token endpoint.
   */
  private async refreshAccessToken(): Promise<void> {
    // Refresh the token
    // Note: HA requires client_id for refresh token requests (must match original OAuth client_id)
    const response = await fetch(`${this.baseUrl}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken!,
        client_id: this.clientId,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to refresh HA access token: ${response.status}${body ? ` - ${body}` : ''}`
      );
    }

    const tokens = await response.json();
    this.accessToken = tokens.access_token;
    // Mirror loginWithCredentials: default to 1800s (30 min) if HA omits expires_in,
    // otherwise the token would be treated as never-expiring.
    this.expiresAt = new Date(Date.now() + (tokens.expires_in || 1800) * 1000);

    // HA may rotate the refresh token. Only adopt it when present so a response
    // without one doesn't clobber the stored refresh token with undefined/null.
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }

    // Update stored tokens (only if we have a token)
    if (this.accessToken) {
      await prisma.hAConnection.updateMany({
        data: {
          accessToken: this.accessToken,
          expiresAt: this.expiresAt,
          // Persist the rotated refresh token only when HA returned a new one.
          ...(tokens.refresh_token ? { refreshToken: this.refreshToken } : {}),
        },
      });
    }
  }

  private async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    // Ensure token is valid before making request (only for OAuth mode)
    await this.ensureValidToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    // Add auth header if we have a token
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${this.baseUrl}/api${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HA API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * Check if connection is valid
   */
  async checkConnection(): Promise<boolean> {
    try {
      // Ensure token is fresh before checking
      await this.ensureValidToken();

      const headers: Record<string, string> = {};
      if (this.accessToken) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
      }

      const response = await fetch(`${this.baseUrl}/api/`, { headers });
      console.log(`HA connection check to ${this.baseUrl}/api/ - status: ${response.status}`);
      return response.ok;
    } catch (err) {
      console.error(`HA connection check failed:`, err);
      return false;
    }
  }

  /**
   * Get all states
   */
  async getStates(): Promise<HAState[]> {
    return this.fetch('/states');
  }

  /**
   * Get states for a specific entity
   */
  async getState(entityId: string): Promise<HAState> {
    return this.fetch(`/states/${entityId}`);
  }

  /**
   * Send commands over a one-shot WebSocket connection to HA.
   * Opens WS, authenticates, sends all commands, collects results, then closes.
   */
  private async wsCommand<T>(commands: Array<{ type: string }>): Promise<T[]> {
    await this.ensureValidToken();

    // Build WS URL from base URL
    const wsUrl = this.baseUrl
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://')
      + '/api/websocket';

    return new Promise<T[]>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const results: T[] = new Array(commands.length);
      let received = 0;
      let nextId = 1;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket command timed out after 30s'));
      }, 30000);

      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({
            type: 'auth',
            access_token: this.accessToken,
          }));
        } else if (msg.type === 'auth_ok') {
          for (const cmd of commands) {
            ws.send(JSON.stringify({ id: nextId++, ...cmd }));
          }
        } else if (msg.type === 'auth_invalid') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`WebSocket authentication failed: ${msg.message || 'invalid token'}`));
        } else if (msg.type === 'result') {
          if (!msg.success) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`WebSocket command failed: ${JSON.stringify(msg.error)}`));
            return;
          }
          const idx = msg.id - 1; // ids are 1-based
          results[idx] = msg.result;
          received++;
          if (received === commands.length) {
            clearTimeout(timeout);
            ws.close();
            resolve(results);
          }
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message}`));
      });
    });
  }

  /**
   * Fetch entity and device registries via WebSocket API.
   * These contain translation_key and device hierarchy data that the REST API doesn't expose.
   */
  async getEntityAndDeviceRegistry(): Promise<{
    entities: EntityRegistryEntry[];
    devices: DeviceRegistryEntry[];
  }> {
    const [entities, devices] = await this.wsCommand<EntityRegistryEntry[] | DeviceRegistryEntry[]>([
      { type: 'config/entity_registry/list' },
      { type: 'config/device_registry/list' },
    ]);
    return {
      entities: entities as unknown as EntityRegistryEntry[],
      devices: devices as unknown as DeviceRegistryEntry[],
    };
  }

  /**
   * Discover Bambu Lab printers using translation_key from the HA entity/device registries.
   *
   * translation_key is stable metadata set by ha-bambulab regardless of entity renames
   * or HA language settings. This replaces the regex-based approach that required
   * maintaining patterns for 17+ languages and broke on renamed entities.
   *
   * Discovery algorithm:
   * 1. Fetch entity + device registries via WebSocket (for translation_key, device hierarchy)
   * 2. Fetch all states via REST (for current values/attributes)
   * 3. Find printers: bambu_lab entities with translation_key === 'print_status'
   * 4. Walk device tree: printer → child devices (AMS, external spool) via via_device_id
   * 5. Classify child device entities by translation_key (tray_1-4, external_spool, etc.)
   */
  async discoverPrinters(): Promise<HAPrinter[]> {
    const [registry, states] = await Promise.all([
      this.getEntityAndDeviceRegistry(),
      this.getStates(),
    ]);

    const { entities, devices } = registry;
    const stateMap = new Map(states.map(s => [s.entity_id, s]));

    // Build device → entities map (only bambu_lab, non-disabled)
    const bambuEntities = entities.filter(e => e.platform === 'bambu_lab' && !e.disabled_by);
    const deviceEntityMap = new Map<string, EntityRegistryEntry[]>();
    for (const entity of bambuEntities) {
      if (!entity.device_id) continue;
      if (!deviceEntityMap.has(entity.device_id)) {
        deviceEntityMap.set(entity.device_id, []);
      }
      deviceEntityMap.get(entity.device_id)!.push(entity);
    }

    // Find all print_status entities (identifies printers)
    const printerEntities = bambuEntities.filter(e =>
      getEffectiveTranslationKey(e) === 'print_status'
    );

    // Deduplicate by device_id — ha-bambulab may create versioned entities
    const seenDevices = new Set<string>();
    const printers: HAPrinter[] = [];

    for (const printerEntity of printerEntities) {
      if (!printerEntity.device_id || seenDevices.has(printerEntity.device_id)) continue;
      seenDevices.add(printerEntity.device_id);

      // If multiple print_status entities exist for this device, pick the best one
      const printStatusCandidates = printerEntities.filter(e => e.device_id === printerEntity.device_id);
      const bestPrinterEntity = pickBestEntity(printStatusCandidates, stateMap);
      if (!bestPrinterEntity) continue;

      const printerState = stateMap.get(bestPrinterEntity.entity_id);
      const printerDevice = devices.find(d => d.id === bestPrinterEntity.device_id);

      // Derive stable prefix from unique_id (always {Model}_{Serial}_{key})
      const prefix = bestPrinterEntity.unique_id
        .replace(/_print_status$/, '')
        .toLowerCase();

      const name = printerDevice?.name_by_user || printerDevice?.name || prefix;

      // Find child devices (AMS units, external spools) via device hierarchy
      const childDevices = devices.filter(d => d.via_device_id === bestPrinterEntity.device_id);

      // Classify child devices by their entities' translation_keys
      const amsUnits: HAAMS[] = [];
      const externalSpools: HATray[] = [];

      for (const childDevice of childDevices) {
        const childEntities = deviceEntityMap.get(childDevice.id) || [];

        // Check for tray entities (tray_1 through tray_4) → this is an AMS device
        const trayEntities = childEntities.filter(e => {
          const key = getEffectiveTranslationKey(e);
          return key !== null && /^tray_[1-4]$/.test(key);
        });

        // Check for external_spool entity → this is an External Spool device
        const extSpoolEntities = childEntities.filter(e =>
          getEffectiveTranslationKey(e) === 'external_spool'
        );

        if (trayEntities.length > 0) {
          const amsNumber = parseAmsNumber(childDevice);
          const humidityEntity = childEntities.find(e =>
            getEffectiveTranslationKey(e) === 'humidity_index'
          );

          const ams: HAAMS = {
            entity_id: humidityEntity?.entity_id || trayEntities[0].entity_id,
            name: amsNumber >= 128 ? `AMS HT${amsNumber > 128 ? ` ${amsNumber - 127}` : ''}` : `AMS ${amsNumber}`,
            ams_number: amsNumber,
            trays: [],
          };

          for (const trayEntity of trayEntities) {
            const key = getEffectiveTranslationKey(trayEntity)!;
            const trayNum = parseInt(key.replace('tray_', ''), 10);

            // If multiple entities for same tray (versioned), pick the best
            const sameTray = trayEntities.filter(e => getEffectiveTranslationKey(e) === key);
            const bestTray = pickBestEntity(sameTray, stateMap);
            if (!bestTray || bestTray.entity_id !== trayEntity.entity_id) continue;

            const trayState = stateMap.get(bestTray.entity_id);
            ams.trays.push({
              entity_id: bestTray.entity_id,
              unique_id: bestTray.unique_id,
              tray_number: trayNum,
              name: trayState?.attributes.name as string,
              color: trayState?.attributes.color as string,
              material: trayState?.attributes.type as string,
              tray_uuid: trayState?.attributes.tray_uuid as string,
              remaining_weight: trayState?.attributes.remain as number,
            });
          }

          // Sort trays by tray number
          ams.trays.sort((a, b) => a.tray_number - b.tray_number);
          amsUnits.push(ams);
        }

        if (extSpoolEntities.length > 0) {
          const bestExt = pickBestEntity(extSpoolEntities, stateMap);
          if (!bestExt) continue;

          const extState = stateMap.get(bestExt.entity_id);
          externalSpools.push({
            entity_id: bestExt.entity_id,
            unique_id: bestExt.unique_id,
            tray_number: 0,
            is_external: true,
            name: extState?.attributes.name as string,
            color: extState?.attributes.color as string,
            material: extState?.attributes.type as string,
            tray_uuid: extState?.attributes.tray_uuid as string,
            remaining_weight: extState?.attributes.remain as number,
          });
        }
      }

      // Sort AMS units by number, external spools by index derived from unique_id
      amsUnits.sort((a, b) => a.ams_number - b.ams_number);
      externalSpools.sort((a, b) => {
        const aEntity = bambuEntities.find(e => e.entity_id === a.entity_id);
        const bEntity = bambuEntities.find(e => e.entity_id === b.entity_id);
        return getExternalSpoolIndex(aEntity?.unique_id || '') - getExternalSpoolIndex(bEntity?.unique_id || '');
      });

      // Find printer-level entities by translation_key
      const printerDeviceEntities = deviceEntityMap.get(bestPrinterEntity.device_id!) || [];

      const findPrinterEntity = (key: string) => {
        const candidates = printerDeviceEntities.filter(e => getEffectiveTranslationKey(e) === key);
        return pickBestEntity(candidates, stateMap);
      };

      const printer: HAPrinter = {
        brand: 'bambu_lab',
        entity_id: bestPrinterEntity.entity_id,
        name,
        state: printerState?.state || 'unknown',
        prefix,
        ams_units: amsUnits,
        external_spools: externalSpools,
        current_stage_entity: findPrinterEntity('stage')?.entity_id,
        print_weight_entity: findPrinterEntity('print_weight')?.entity_id,
        print_progress_entity: findPrinterEntity('print_progress')?.entity_id,
      };

      printers.push(printer);
    }

    // Discover Creality printers from ha_creality_ws integration
    const crealityPrinters = this.discoverCrealityPrinters(entities, devices, stateMap);
    printers.push(...crealityPrinters);

    // Single-spool / non-AMS printers (e.g. Ender 3 V3 KE with no CFS) expose no
    // assignable slot, so they can't be tracked. Synthesize one virtual external
    // spool slot for any discovered printer that has zero AMS units and zero
    // external spools, so the user can assign a spool to it (issue #68). The
    // synthetic id has no backing HA entity; it is used purely as the assignment
    // key (active_tray), so it never passes through the entity_id→unique_id
    // resolver and survives unchanged end-to-end.
    for (const printer of printers) {
      if (printer.ams_units.length === 0 && printer.external_spools.length === 0) {
        const syntheticId = `${printer.prefix}_virtual_external_spool`;
        printer.external_spools.push({
          entity_id: syntheticId,
          unique_id: syntheticId,
          tray_number: 0,
          is_external: true,
        });
      }
    }

    return printers;
  }

  /**
   * Discover Creality printers from ha_creality_ws integration.
   * Uses entity_id pattern matching (ha_creality_ws doesn't use translation_key).
   *
   * Entity patterns:
   *   Print status:     sensor.<name>_print_status
   *   CFS slot:         sensor.<name>_cfs_box_<N>_slot_<M>_filament/color/percent
   *   CFS external:     sensor.<name>_cfs_external_filament/color/percent
   *   Used material:    sensor.<name>_used_material_length
   *   Print progress:   sensor.<name>_print_progress
   */
  private discoverCrealityPrinters(
    entities: EntityRegistryEntry[],
    devices: DeviceRegistryEntry[],
    stateMap: Map<string, HAState>,
  ): HAPrinter[] {
    const crealityEntities = entities.filter(e => e.platform === 'ha_creality_ws' && !e.disabled_by);
    if (crealityEntities.length === 0) return [];

    // Build device → entities map
    const deviceEntityMap = new Map<string, EntityRegistryEntry[]>();
    for (const entity of crealityEntities) {
      if (!entity.device_id) continue;
      if (!deviceEntityMap.has(entity.device_id)) {
        deviceEntityMap.set(entity.device_id, []);
      }
      deviceEntityMap.get(entity.device_id)!.push(entity);
    }

    // Find printer devices by print_status entity
    const printerEntities = crealityEntities.filter(e =>
      e.entity_id.endsWith('_print_status')
    );

    const seenDevices = new Set<string>();
    const printers: HAPrinter[] = [];

    for (const printerEntity of printerEntities) {
      if (!printerEntity.device_id || seenDevices.has(printerEntity.device_id)) continue;
      seenDevices.add(printerEntity.device_id);

      const printerState = stateMap.get(printerEntity.entity_id);
      const printerDevice = devices.find(d => d.id === printerEntity.device_id);

      // Derive prefix from entity_id: remove "sensor." prefix and "_print_status" suffix
      const prefix = printerEntity.entity_id
        .replace(/^sensor\./, '')
        .replace(/_print_status$/, '');

      const name = printerDevice?.name_by_user || printerDevice?.name || prefix;

      // Gather all entities for this printer — include device entities and child device entities
      const allPrinterEntities: EntityRegistryEntry[] = [
        ...(deviceEntityMap.get(printerEntity.device_id) || []),
      ];

      // Also check child devices (CFS boxes may be child devices)
      const childDevices = devices.filter(d => d.via_device_id === printerEntity.device_id);
      for (const childDevice of childDevices) {
        allPrinterEntities.push(...(deviceEntityMap.get(childDevice.id) || []));
      }

      // Find CFS slot entities by pattern matching
      const cfsSlotPattern = /cfs_box_(\d+)_slot_(\d+)_filament$/;
      const slotFilamentEntities = allPrinterEntities.filter(e =>
        cfsSlotPattern.test(e.entity_id)
      );

      // Group slots by box number
      const boxMap = new Map<number, HATray[]>();
      for (const slotEntity of slotFilamentEntities) {
        const match = slotEntity.entity_id.match(cfsSlotPattern)!;
        const boxNum = parseInt(match[1], 10);
        const slotNum = parseInt(match[2], 10);

        const slotState = stateMap.get(slotEntity.entity_id);
        const attrs = slotState?.attributes || {};

        if (!boxMap.has(boxNum)) {
          boxMap.set(boxNum, []);
        }

        boxMap.get(boxNum)!.push({
          entity_id: slotEntity.entity_id,
          unique_id: slotEntity.unique_id,
          tray_number: slotNum,
          name: attrs.name as string,
          color: normalizeCrealityColorHex(attrs.color_hex),
          material: attrs.type as string,
          // Deliberately NO tray_uuid: the slot's `rfid` attribute is Creality's
          // material-type code, not a per-spool serial. See src/lib/creality.ts.
        });
      }

      // Build HAAMS units from box map
      const amsUnits: HAAMS[] = [];
      for (const [boxNum, trays] of boxMap) {
        // Find humidity entity for this box
        const humidityEntity = allPrinterEntities.find(e =>
          e.entity_id.includes(`cfs_box_${boxNum}_humidity`)
        );

        trays.sort((a, b) => a.tray_number - b.tray_number);

        amsUnits.push({
          entity_id: humidityEntity?.entity_id || trays[0].entity_id,
          name: `CFS Box ${boxNum}`,
          ams_number: boxNum,
          trays,
        });
      }
      amsUnits.sort((a, b) => a.ams_number - b.ams_number);

      // Find external filament entity
      const externalSpools: HATray[] = [];
      const extFilamentEntity = allPrinterEntities.find(e =>
        e.entity_id.includes('cfs_external_filament')
      );
      if (extFilamentEntity) {
        const extState = stateMap.get(extFilamentEntity.entity_id);
        const attrs = extState?.attributes || {};
        externalSpools.push({
          entity_id: extFilamentEntity.entity_id,
          unique_id: extFilamentEntity.unique_id,
          tray_number: 0,
          is_external: true,
          name: attrs.name as string,
          color: normalizeCrealityColorHex(attrs.color_hex),
          material: attrs.type as string,
          // Deliberately NO tray_uuid: the slot's `rfid` attribute is Creality's
          // material-type code, not a per-spool serial. See src/lib/creality.ts.
        });
      }

      // Find print-related entities
      const usedMaterialEntity = allPrinterEntities.find(e =>
        e.entity_id.endsWith('_used_material_length')
      );
      const printProgressEntity = allPrinterEntities.find(e =>
        e.entity_id.endsWith('_print_progress')
      );

      printers.push({
        brand: 'creality',
        entity_id: printerEntity.entity_id,
        name,
        state: printerState?.state || 'unknown',
        prefix,
        ams_units: amsUnits,
        external_spools: externalSpools,
        print_progress_entity: printProgressEntity?.entity_id,
        used_material_entity: usedMaterialEntity?.entity_id,
      });
    }

    return printers;
  }

  /**
   * Get a mapping of entity_id → unique_id for all printer integration entities.
   * Used by the webhook handler to convert entity_ids to stable unique_ids.
   */
  async getEntityIdToUniqueIdMap(): Promise<Map<string, string>> {
    const registry = await this.getTrayEntityRegistry();
    return new Map([...registry].map(([entityId, { uniqueId }]) => [entityId, uniqueId]));
  }

  /**
   * entity_id → { unique_id, platform } for the supported printer integrations.
   *
   * Callers that need the platform as well as the unique_id must use this rather
   * than pairing getEntityIdToUniqueIdMap() with a second lookup: each call opens
   * its own WebSocket connection, and the webhook runs on every tray change.
   */
  async getTrayEntityRegistry(): Promise<Map<string, { uniqueId: string; platform: string }>> {
    const supportedPlatforms = new Set(['bambu_lab', 'ha_creality_ws']);
    const { entities } = await this.getEntityAndDeviceRegistry();
    const map = new Map<string, { uniqueId: string; platform: string }>();
    for (const entity of entities) {
      if (supportedPlatforms.has(entity.platform)) {
        map.set(entity.entity_id, { uniqueId: entity.unique_id, platform: entity.platform });
      }
    }
    return map;
  }

  /**
   * Create an automation
   */
  async createAutomation(automation: HAAutomation): Promise<void> {
    await this.fetch('/services/automation/reload', { method: 'POST' });
    // Note: Creating automations via API requires config file modifications
    // We'll use the automation config entry instead
  }

  /**
   * Validate Home Assistant configuration without restarting.
   * Returns { result: 'valid', errors: null } on success,
   * or { result: 'invalid', errors: '...' } on failure.
   */
  async checkConfig(): Promise<{ result: 'valid' | 'invalid'; errors: string | null }> {
    return this.fetch('/config/core/check_config', { method: 'POST' });
  }

  /**
   * Call a webhook
   */
  async callWebhook(webhookId: string, data: Record<string, unknown>): Promise<void> {
    await fetch(`${this.baseUrl}/api/webhook/${webhookId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  }

  /**
   * Fire an event
   */
  async fireEvent(eventType: string, eventData: Record<string, unknown>): Promise<void> {
    await this.fetch(`/events/${eventType}`, {
      method: 'POST',
      body: JSON.stringify(eventData),
    });
  }

  /**
   * Call a Home Assistant service
   */
  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {}
  ): Promise<void> {
    await this.fetch(`/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(serviceData),
    });
  }

  // ============================================
  // Config Flow API (for setting up integrations)
  // ============================================

  /**
   * Start a new config flow for an integration
   */
  async startConfigFlow(domain: string): Promise<ConfigFlowResult> {
    return this.fetch('/config/config_entries/flow', {
      method: 'POST',
      body: JSON.stringify({ handler: domain }),
    });
  }

  /**
   * Continue a config flow with user input
   * Note: HA returns 400 with errors object for validation failures
   */
  async continueConfigFlow(flowId: string, userInput: Record<string, unknown>): Promise<ConfigFlowResult> {
    await this.ensureValidToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add auth header if we have a token
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${this.baseUrl}/api/config/config_entries/flow/${flowId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(userInput),
    });

    // For config flows, 400 errors typically mean validation failed
    if (response.status === 400) {
      const errorBody = await response.json();
      console.log('Config flow 400 response:', JSON.stringify(errorBody));

      // If the response contains full form data (data_schema, step_id), return it as-is
      // This handles cases where HA returns 400 but with a valid form to display
      if (errorBody.data_schema && errorBody.step_id) {
        return errorBody as ConfigFlowResult;
      }

      // If it just has errors, return a synthetic form result with the current step
      // but mark it specially so frontend knows it's a validation error
      if (errorBody.errors) {
        return {
          flow_id: flowId,
          type: 'form',
          handler: errorBody.handler || 'unknown',
          step_id: 'error',
          errors: errorBody.errors,
        } as ConfigFlowResult;
      }

      throw new Error(`HA API error: ${response.status} - ${JSON.stringify(errorBody)}`);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`HA API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    console.log('Config flow response:', JSON.stringify({ type: result.type, step_id: result.step_id, hasErrors: !!result.errors }));
    return result;
  }

  /**
   * Get the current state of a config flow
   */
  async getConfigFlow(flowId: string): Promise<ConfigFlowResult> {
    return this.fetch(`/config/config_entries/flow/${flowId}`);
  }

  /**
   * Delete/abort a config flow
   */
  async deleteConfigFlow(flowId: string): Promise<void> {
    await this.fetch(`/config/config_entries/flow/${flowId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get all config entries for a domain
   */
  async getConfigEntries(domain?: string): Promise<ConfigEntry[]> {
    const url = domain
      ? `/config/config_entries/entry?domain=${domain}`
      : '/config/config_entries/entry';
    return this.fetch(url);
  }

  /**
   * Delete a config entry
   */
  async deleteConfigEntry(entryId: string): Promise<void> {
    await this.fetch(`/config/config_entries/entry/${entryId}`, {
      method: 'DELETE',
    });
  }

  // ============================================
  // User Management API (for embedded mode admin user)
  // ============================================

  /**
   * Get all users in Home Assistant
   */
  async getUsers(): Promise<HAUser[]> {
    // HA uses WebSocket for user listing, but we can use the REST API
    // by calling the /api/config/auth/list endpoint
    return this.fetch('/config/auth/list');
  }

  /**
   * Create a new user in Home Assistant
   */
  async createUser(name: string, username: string, password: string, isAdmin: boolean = false): Promise<HAUser> {
    return this.fetch('/config/auth/create', {
      method: 'POST',
      body: JSON.stringify({
        name,
        username,
        password,
        group_ids: isAdmin ? ['system-admin'] : ['system-users'],
        local_only: false,
      }),
    });
  }

  /**
   * Delete a user from Home Assistant
   */
  async deleteUser(userId: string): Promise<void> {
    await this.fetch('/config/auth/delete', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    });
  }

  /**
   * Create or recreate the admin user with a new password
   * Returns the new password
   */
  async resetAdminUser(adminUsername: string = 'admin'): Promise<{ userId: string; password: string }> {
    // First, try to find and delete existing admin user
    try {
      const users = await this.getUsers();
      const existingAdmin = users.find(u => u.username === adminUsername);
      if (existingAdmin) {
        console.log(`Deleting existing admin user: ${existingAdmin.id}`);
        await this.deleteUser(existingAdmin.id);
      }
    } catch (err) {
      console.log('No existing admin user to delete or error listing users:', err);
    }

    // Create new admin user with random password
    const newPassword = generateRandomPassword();
    const newUser = await this.createUser(
      'Admin',
      adminUsername,
      newPassword,
      true // isAdmin
    );

    console.log(`Created new admin user: ${newUser.id}`);
    return { userId: newUser.id, password: newPassword };
  }
}

// Config flow types
export interface ConfigFlowResult {
  flow_id: string;
  type: 'form' | 'create_entry' | 'abort' | 'external' | 'external_done' | 'menu';
  handler: string;
  step_id: string;
  data_schema?: ConfigFlowSchema[];
  errors?: Record<string, string>;
  description_placeholders?: Record<string, string>;
  title?: string;
  result?: ConfigEntry;
  menu_options?: string[];
  reason?: string; // Abort reason when type is 'abort'
}

export interface ConfigFlowSchema {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: { suggested_value?: unknown };
}

export interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  source: string;
  state: string;
  supports_options: boolean;
  supports_remove_device: boolean;
  supports_unload: boolean;
  disabled_by: string | null;
}

export interface HAUser {
  id: string;
  username: string;
  name: string;
  is_owner: boolean;
  is_active: boolean;
  local_only: boolean;
  system_generated: boolean;
  group_ids: string[];
  credentials: Array<{ type: string }>;
}

// =============================================================================
// Helper functions for translation_key-based discovery
// =============================================================================

/**
 * Get the effective translation_key for an entity.
 * Falls back to parsing the unique_id suffix for very old ha-bambulab versions
 * that don't set translation_key.
 */
function getEffectiveTranslationKey(entity: EntityRegistryEntry): string | null {
  if (entity.translation_key) {
    // ha-bambulab v2.2.21+ uses translation_key="tray" with translation_placeholders
    // instead of per-tray keys like "tray_1". Try placeholders first, then unique_id fallback.
    if (entity.translation_key === 'tray') {
      if (entity.translation_placeholders?.tray_number) {
        return `tray_${entity.translation_placeholders.tray_number}`;
      }
      // Placeholders not in WS response — extract tray number from unique_id
      const trayMatch = entity.unique_id.match(/_tray_(\d+)$/);
      if (trayMatch) return `tray_${trayMatch[1]}`;
    }
    return entity.translation_key;
  }

  // Fallback: extract known key from unique_id suffix (old ha-bambulab without translation_key)
  const knownKeys = [
    'print_status', 'print_weight', 'print_progress', 'print_length',
    'tray_1', 'tray_2', 'tray_3', 'tray_4',
    'external_spool', 'humidity_index', 'active_tray', 'stage',
  ];
  for (const key of knownKeys) {
    if (entity.unique_id.endsWith(`_${key}`)) return key;
  }
  return null;
}

/**
 * Pick the best entity from multiple candidates (e.g., versioned entities for same function).
 * Prefers: non-disabled > available state > original (no _N suffix) entity.
 */
function pickBestEntity(
  candidates: EntityRegistryEntry[],
  stateMap: Map<string, HAState>
): EntityRegistryEntry | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  return candidates.reduce((best, current) => {
    const bestState = stateMap.get(best.entity_id);
    const currentState = stateMap.get(current.entity_id);
    const bestAvailable = bestState && bestState.state !== 'unavailable' && bestState.state !== 'unknown';
    const currentAvailable = currentState && currentState.state !== 'unavailable' && currentState.state !== 'unknown';

    if (currentAvailable && !bestAvailable) return current;
    if (bestAvailable && !currentAvailable) return best;

    // Both same availability — prefer entity without _N suffix (original)
    const bestHasSuffix = /_\d+$/.test(best.entity_id);
    const currentHasSuffix = /_\d+$/.test(current.entity_id);
    if (!currentHasSuffix && bestHasSuffix) return current;
    if (!bestHasSuffix && currentHasSuffix) return best;

    return best;
  });
}

/**
 * Determine AMS number from the device's original name.
 *
 * ha-bambulab constructs device names in the format "{Model}_{Serial}_AMS_{N}"
 * e.g., "H2C_31B8CP620601523_AMS_1", "H2C_31B8CP620601523_AMS_128".
 * This comes from the `name` field in the WS device registry, which is the
 * integration-provided original name (stable, not affected by user renames —
 * user renames go into `name_by_user` instead).
 *
 * The device `identifiers` field contains the AMS hardware serial number,
 * NOT the constructed name, so we can't use that for AMS numbering.
 *
 * Regular AMS: indices 1-4 (firmware 0-based, ha-bambulab adds 1)
 * AMS HT: indices 128-135 (firmware 0x80-0x87, used as-is)
 * AMS Lite: index 1 (single unit)
 */
function parseAmsNumber(device: DeviceRegistryEntry): number {
  const name = device.name || '';
  const match = name.match(/_AMS_(\d+)$/);
  if (match) return parseInt(match[1], 10);
  return 1;
}

/**
 * Extract external spool index from entity unique_id.
 * e.g., "..._ExternalSpool_external_spool" → 1
 *       "..._ExternalSpool2_external_spool" → 2
 */
function getExternalSpoolIndex(uniqueId: string): number {
  const match = uniqueId.match(/_ExternalSpool(\d*)/i);
  if (!match) return 1;
  return match[1] ? parseInt(match[1], 10) : 1;
}
