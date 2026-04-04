/**
 * Bambu Cloud API client for fetching slicer filament profiles.
 * Auth endpoints mirror the OrcaSlicer/Bambu Studio agent.
 */

const LOGIN_URL = 'https://api.bambulab.com/v1/user-service/user/login';
const TFA_URL   = 'https://bambulab.com/api/sign-in/tfa';
const SLICER_URL = 'https://api.bambulab.com/v1/iot-service/api/slicer/setting?version=1.10.0.89';

const BBL_HEADERS: Record<string, string> = {
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
  'X-BBL-Client-Type': 'slicer',
  'X-BBL-Client-Version': '01.09.05.51',
  'X-BBL-Language': 'en-US',
  'X-BBL-OS-Type': 'linux',
  'X-BBL-OS-Version': '6.2.0',
  'X-BBL-Agent-Version': '01.09.05.01',
  'X-BBL-Executable-info': '{}',
  'X-BBL-Agent-OS-Type': 'linux',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

export interface BambuFilamentProfile {
  filamentId: string;
  name: string;
  vendor: string;
  material: string;
}

export type BambuLoginResult =
  | { status: 'success'; token: string }
  | { status: 'needs_code' }
  | { status: 'needs_tfa'; tfaKey: string }
  | { status: 'error'; message: string };

/**
 * Login with email + password. Returns a token on success, or indicates a
 * verification code is needed (Bambu's "new device" flow).
 */
export async function bambuLogin(email: string, password: string): Promise<BambuLoginResult> {
  try {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: BBL_HEADERS,
      body: JSON.stringify({ account: email, password }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { status: 'error', message: `Bambu Cloud login failed: HTTP ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;

    if (typeof data.accessToken === 'string' && data.accessToken) {
      return { status: 'success', token: data.accessToken };
    }

    if (data.loginType === 'verifyCode') {
      return { status: 'needs_code' };
    }

    if (data.loginType === 'tfa') {
      return { status: 'needs_tfa', tfaKey: String(data.tfaKey ?? '') };
    }

    return { status: 'error', message: `Unexpected login response: ${JSON.stringify(data).slice(0, 200)}` };
  } catch (err) {
    return { status: 'error', message: `Bambu Cloud request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Login with email + verification code (the "new device" email code flow).
 */
export async function bambuLoginWithCode(email: string, code: string): Promise<BambuLoginResult> {
  try {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: BBL_HEADERS,
      body: JSON.stringify({ account: email, code }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { status: 'error', message: `Bambu Cloud login failed: HTTP ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;

    if (typeof data.accessToken === 'string' && data.accessToken) {
      return { status: 'success', token: data.accessToken };
    }

    return { status: 'error', message: `Login with code failed: ${JSON.stringify(data).slice(0, 200)}` };
  } catch (err) {
    return { status: 'error', message: `Bambu Cloud request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Complete TFA login with a TOTP code from an authenticator app.
 * tfaKey is returned by bambuLogin() when loginType === 'tfa'.
 */
export async function bambuLoginWithTfa(email: string, tfaKey: string, tfaCode: string): Promise<BambuLoginResult> {
  try {
    const res = await fetch(TFA_URL, {
      method: 'POST',
      headers: BBL_HEADERS,
      body: JSON.stringify({ account: email, tfaCode, tfaKey }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { status: 'error', message: `Bambu Cloud TFA login failed: HTTP ${res.status}` };
    }

    // bambulab.com/api/sign-in/tfa is a web endpoint — token arrives as a cookie, not in the body
    const cookies = res.headers.get('set-cookie') ?? '';

    // Extract the token value from cookies (key is "token")
    const tokenMatch = cookies.match(/(?:^|,\s*)token=([^;,]+)/);
    const token = tokenMatch?.[1] ?? '';
    if (token) {
      return { status: 'success', token };
    }

    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { status: 'error', message: `TFA login failed: no token in cookies. Body: ${JSON.stringify(data).slice(0, 200)}` };
  } catch (err) {
    return { status: 'error', message: `Bambu Cloud request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Fetch the user's slicer filament profiles from Bambu Cloud.
 * Returns the "private" list which includes all profiles the user has
 * configured in Bambu Studio / OrcaSlicer.
 */
export async function fetchBambuFilaments(token: string): Promise<BambuFilamentProfile[]> {
  const res = await fetch(SLICER_URL, {
    headers: { ...BBL_HEADERS, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Bambu Cloud filament fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const filamentSection = data.filament as Record<string, unknown> | undefined;
  const privateList = filamentSection?.private;

  if (!Array.isArray(privateList)) {
    throw new Error('Unexpected response structure from Bambu Cloud slicer API');
  }

  const seen = new Set<string>();
  const profiles: BambuFilamentProfile[] = [];

  for (const item of privateList) {
    const f = item as Record<string, unknown>;
    const id = String(f.filament_id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // Strip "@vendor" suffix that Bambu sometimes appends to names
    const rawName = String(f.name ?? '');
    const name = rawName.includes('@') ? rawName.split('@')[0].trim() : rawName;

    profiles.push({
      filamentId: id,
      name,
      vendor: String(f.filament_vendor ?? ''),
      material: String(f.filament_type ?? ''),
    });
  }

  return profiles;
}
