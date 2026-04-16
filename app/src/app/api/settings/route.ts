import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import {
  isEmbeddedMode,
  isAddonMode,
  getEmbeddedHAUrl,
  HomeAssistantClient,
  checkHAOnboardingStatus,
  completeHAOnboarding,
} from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';

export async function GET() {
  try {
    const embeddedMode = isEmbeddedMode();
    const addonMode = isAddonMode();
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    // In add-on mode, HA is always connected via Supervisor
    if (addonMode) {
      // Verify Supervisor connection works
      const client = HomeAssistantClient.forAddon();
      const haConnected = client ? await client.checkConnection() : false;

      // Auto-configure Spoolman from addon config if not already set in DB
      let activeSpoolmanConnection = spoolmanConnection;
      const envSpoolmanUrl = process.env.SPOOLMAN_URL?.replace(/\/+$/, '');
      if (!activeSpoolmanConnection && envSpoolmanUrl) {
        try {
          const spoolmanClient = new SpoolmanClient(envSpoolmanUrl);
          const isValid = await spoolmanClient.checkConnection();
          if (isValid) {
            await spoolmanClient.ensureRequiredFieldsExist();
            await prisma.spoolmanConnection.deleteMany();
            await prisma.spoolmanConnection.create({ data: { url: envSpoolmanUrl } });
            activeSpoolmanConnection = { id: '', url: envSpoolmanUrl, createdAt: new Date(), updatedAt: new Date() };
            console.log(`Spoolman auto-configured from addon config: ${envSpoolmanUrl}`);
            await createActivityLog({ type: 'connection', message: 'Spoolman connected via addon configuration' });
          } else {
            console.log(`Spoolman URL from addon config is not reachable: ${envSpoolmanUrl}`);
          }
        } catch (err) {
          console.error('Failed to auto-configure Spoolman from addon config:', err);
        }
      }

      // Fetch optional settings
      const qrBaseUrlSetting = await prisma.settings.findUnique({ where: { key: 'qr_base_url' } });
      const showLocationSetting = await prisma.settings.findUnique({ where: { key: 'show_spool_location' } });
      const autoMappingSetting = await prisma.settings.findUnique({ where: { key: 'auto_mapping_enabled' } });
      const printerFilamentReportSetting = await prisma.settings.findUnique({ where: { key: 'show_printer_filament_report' } });

      return NextResponse.json({
        embeddedMode: false,
        addonMode: true,
        directAccessPort: parseInt(process.env.DIRECT_ACCESS_PORT || '3000', 10),
        homeassistant: haConnected ? {
          url: 'Home Assistant (via Supervisor)',
          connected: true,
        } : null,
        spoolman: activeSpoolmanConnection ? {
          url: activeSpoolmanConnection.url,
          connected: true,
        } : null,
        qrBaseUrl: qrBaseUrlSetting?.value || '',
        showSpoolLocation: showLocationSetting?.value === 'true',
        showPrinterFilamentReport: printerFilamentReportSetting?.value === 'true',
        autoMappingEnabled: !autoMappingSetting || autoMappingSetting.value === 'true',
      });
    }

    // In embedded mode, check if HA is reachable
    let haConnected = false;
    let haUrl = '';

    if (embeddedMode) {
      haUrl = getEmbeddedHAUrl();

      // First check if we have a stored connection (from previous onboarding)
      let storedConnection = await prisma.hAConnection.findFirst();

      if (storedConnection) {
        // We have stored credentials, try to use them
        const client = new HomeAssistantClient(
          haUrl,
          storedConnection.accessToken,
          storedConnection.refreshToken,
          storedConnection.expiresAt,
          true,
          storedConnection.clientId
        );
        haConnected = await client.checkConnection();
        console.log('Embedded HA connection with stored token:', haConnected ? 'success' : 'failed');

        // If token-based connection failed, try to re-authenticate with stored admin credentials
        if (!haConnected) {
          const adminCredsSetting = await prisma.settings.findUnique({
            where: { key: 'ha_admin_credentials' },
          });
          if (adminCredsSetting) {
            try {
              const creds = JSON.parse(adminCredsSetting.value);
              console.log('Token invalid, attempting re-authentication with stored credentials...');
              const result = await HomeAssistantClient.loginWithCredentials(
                haUrl, creds.username, creds.password, storedConnection.clientId
              );
              if (result) {
                // Success - update stored tokens
                await prisma.hAConnection.updateMany({
                  data: {
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken,
                    expiresAt: result.expiresAt,
                  },
                });
                haConnected = true;
                console.log('Auto-recovery successful: re-authenticated with stored credentials');
              } else {
                // Stored credentials are also invalid (password was changed)
                console.log('Auto-recovery failed: stored credentials rejected');
              }
            } catch {
              console.error('Failed to parse admin credentials for auto-recovery');
            }
          }
        }
      }

      if (!haConnected) {
        // Check if HA needs onboarding
        console.log('No stored connection, checking HA onboarding status...');
        const onboardingStatus = await checkHAOnboardingStatus(haUrl);
        console.log('HA onboarding status:', JSON.stringify(onboardingStatus));

        if (onboardingStatus.error) {
          // Couldn't determine onboarding status - HA might not be ready yet
          console.log('Could not check onboarding status, HA may still be starting');
          // haConnected stays false, UI will show "waiting" state
        } else if (onboardingStatus.needsOnboarding) {
          // Auto-complete onboarding
          console.log('HA needs onboarding, completing automatically...');
          const result = await completeHAOnboarding(haUrl);

          if (result.success && result.accessToken) {
            // Store the service account credentials
            await prisma.hAConnection.deleteMany();
            await prisma.hAConnection.create({
              data: {
                url: haUrl,
                clientId: 'http://spoolmansync',
                accessToken: result.accessToken,
                refreshToken: result.refreshToken || null,
                expiresAt: result.expiresAt || null,
              },
            });
            console.log('HA onboarding complete, service account credentials stored');

            // Store admin login credentials for users to access HA
            if (result.servicePassword) {
              await prisma.settings.upsert({
                where: { key: 'ha_admin_credentials' },
                create: {
                  key: 'ha_admin_credentials',
                  value: JSON.stringify({
                    username: 'admin',
                    password: result.servicePassword,
                  }),
                },
                update: {
                  value: JSON.stringify({
                    username: 'admin',
                    password: result.servicePassword,
                  }),
                },
              });
              console.log('Admin credentials stored for HA access');
            }

            haConnected = true;
          } else {
            console.error('Auto-onboarding failed:', result.error);
          }
        } else {
          // Onboarding already done but we don't have a token
          // This shouldn't happen in normal flow - maybe HA was set up manually
          console.log('Onboarding complete but no stored token - HA may have been set up manually');
          // Try to check if HA API is accessible (it won't be without token)
          const client = HomeAssistantClient.forEmbedded();
          haConnected = await client.checkConnection();
          console.log('Embedded HA connection (no token):', haConnected ? 'success' : 'failed');
        }
      }
    } else {
      const haConnection = await prisma.hAConnection.findFirst();
      if (haConnection) {
        haUrl = haConnection.url;
        haConnected = true;
      }
    }

    // Get admin credentials for embedded mode
    let adminCredentials = null;
    if (embeddedMode && haConnected) {
      const adminCredsSetting = await prisma.settings.findUnique({
        where: { key: 'ha_admin_credentials' },
      });
      if (adminCredsSetting) {
        try {
          const creds = JSON.parse(adminCredsSetting.value);
          adminCredentials = {
            username: creds.username,
            password: creds.password,
          };
        } catch {
          console.error('Failed to parse admin credentials');
        }
      }

      // Note: If no admin credentials exist, they weren't stored during initial onboarding.
      // This can happen if the HA instance was set up before this feature was added.
      // The credentials can only be created during fresh onboarding - HA's user management
      // API is WebSocket-only, not REST API.
    }

    // Determine HA response:
    // - Connected: { url, connected: true, adminCredentials }
    // - Broken connection in embedded mode (stored connection exists but token invalid): { url, connected: false, error: 'token_invalid' }
    // - Not yet set up (no stored connection, HA still starting): null
    let haResponse = null;
    if (haConnected) {
      haResponse = {
        url: haUrl,
        connected: true,
        adminCredentials, // Only populated in embedded mode
      };
    } else if (embeddedMode && await prisma.hAConnection.findFirst()) {
      // We have a stored connection but it's broken — don't show "Connecting..." spinner
      haResponse = {
        url: haUrl,
        connected: false,
        error: 'token_invalid',
      };
    }
    // else: null — HA hasn't been set up yet (first startup)

    // Fetch optional settings
    const qrBaseUrlSetting = await prisma.settings.findUnique({ where: { key: 'qr_base_url' } });
    const showLocationSetting = await prisma.settings.findUnique({ where: { key: 'show_spool_location' } });
    const autoMappingSetting = await prisma.settings.findUnique({ where: { key: 'auto_mapping_enabled' } });
    const printerFilamentReportSetting = await prisma.settings.findUnique({ where: { key: 'show_printer_filament_report' } });

    return NextResponse.json({
      embeddedMode,
      addonMode: false,
      homeassistant: haResponse,
      spoolman: spoolmanConnection ? {
        url: spoolmanConnection.url,
        connected: true,
      } : null,
      qrBaseUrl: qrBaseUrlSetting?.value || '',
      showSpoolLocation: showLocationSetting?.value === 'true',
      showPrinterFilamentReport: printerFilamentReportSetting?.value === 'true',
      autoMappingEnabled: !autoMappingSetting || autoMappingSetting.value === 'true',
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, url, config } = body;

    if (type === 'filter_config') {
      // Save spool filter configuration
      await prisma.settings.upsert({
        where: { key: 'spool_filter_config' },
        create: {
          key: 'spool_filter_config',
          value: JSON.stringify(config || []),
        },
        update: {
          value: JSON.stringify(config || []),
        },
      });

      return NextResponse.json({ success: true });
    }

    if (type === 'reconnect_ha') {
      // Re-authenticate with HA using provided credentials (embedded mode only)
      const { username, password } = body;
      if (!username || !password) {
        return NextResponse.json({ error: 'Username and password are required' }, { status: 400 });
      }

      const haUrl = getEmbeddedHAUrl();
      const storedConnection = await prisma.hAConnection.findFirst();
      const clientId = storedConnection?.clientId || 'http://spoolmansync';

      const result = await HomeAssistantClient.loginWithCredentials(haUrl, username, password, clientId);
      if (!result) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }

      // Update stored tokens
      await prisma.hAConnection.updateMany({
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        },
      });

      // Update stored admin credentials so future auto-recovery uses the new password
      await prisma.settings.upsert({
        where: { key: 'ha_admin_credentials' },
        create: {
          key: 'ha_admin_credentials',
          value: JSON.stringify({ username, password }),
        },
        update: {
          value: JSON.stringify({ username, password }),
        },
      });

      await createActivityLog({
        type: 'connection',
        message: 'Home Assistant reconnected with updated credentials',
      });

      return NextResponse.json({ success: true });
    }

    if (type === 'show_spool_location') {
      const enabled = body.enabled === true;
      await prisma.settings.upsert({
        where: { key: 'show_spool_location' },
        create: { key: 'show_spool_location', value: String(enabled) },
        update: { value: String(enabled) },
      });
      return NextResponse.json({ success: true });
    }

    if (type === 'show_printer_filament_report') {
      const enabled = body.enabled === true;
      await prisma.settings.upsert({
        where: { key: 'show_printer_filament_report' },
        create: { key: 'show_printer_filament_report', value: String(enabled) },
        update: { value: String(enabled) },
      });
      return NextResponse.json({ success: true });
    }

    if (type === 'auto_mapping') {
      const enabled = body.enabled === true;
      await prisma.settings.upsert({
        where: { key: 'auto_mapping_enabled' },
        create: { key: 'auto_mapping_enabled', value: String(enabled) },
        update: { value: String(enabled) },
      });
      return NextResponse.json({ success: true });
    }

    if (type === 'qr_base_url') {
      // Save QR code base URL override
      const qrBaseUrl = (url || '').trim().replace(/\/+$/, '');
      if (qrBaseUrl) {
        await prisma.settings.upsert({
          where: { key: 'qr_base_url' },
          create: { key: 'qr_base_url', value: qrBaseUrl },
          update: { value: qrBaseUrl },
        });
      } else {
        await prisma.settings.deleteMany({ where: { key: 'qr_base_url' } });
      }
      return NextResponse.json({ success: true });
    }

    if (type === 'spoolman') {
      // Validate Spoolman connection
      const client = new SpoolmanClient(url);
      const isValid = await client.checkConnection();

      if (!isValid) {
        return NextResponse.json({ error: 'Cannot connect to Spoolman' }, { status: 400 });
      }

      // Ensure required extra fields exist in Spoolman
      // This includes active_tray (for tray assignments) and barcode (for QR scanning)
      try {
        await client.ensureRequiredFieldsExist();
      } catch (error) {
        console.error('Failed to ensure required fields:', error);
        return NextResponse.json({
          error: 'Connected to Spoolman but failed to configure required extra fields. Please check Spoolman logs.',
        }, { status: 500 });
      }

      // Upsert connection
      await prisma.spoolmanConnection.deleteMany();
      await prisma.spoolmanConnection.create({
        data: { url },
      });

      // Log activity
      await createActivityLog({
        type: 'connection',
        message: 'Spoolman connected successfully',
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid settings type' }, { status: 400 });
  } catch (error) {
    console.error('Error saving settings:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'regenerate-ha-password') {
      // Password regeneration is not supported - HA's user management API
      // is only available via WebSocket, not REST API.
      // To change the password, users need to:
      // 1. Login to HA with the current credentials
      // 2. Go to Profile settings and change the password
      // Note: The access token used by SpoolmanSync will continue to work
      // even if the password is changed, since we use token-based auth.
      return NextResponse.json({
        error: 'Password regeneration is not supported. To change the password, please login to Home Assistant directly and update it in your Profile settings. This will not affect SpoolmanSync functionality.',
      }, { status: 400 });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Error updating settings:', error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { type } = body;

    if (type === 'homeassistant') {
      await prisma.hAConnection.deleteMany();

      // Log activity
      await createActivityLog({
        type: 'connection',
        message: 'Home Assistant disconnected',
      });

      return NextResponse.json({ success: true });
    }

    if (type === 'spoolman') {
      await prisma.spoolmanConnection.deleteMany();

      // Log activity
      await createActivityLog({
        type: 'connection',
        message: 'Spoolman disconnected',
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid settings type' }, { status: 400 });
  } catch (error) {
    console.error('Error deleting settings:', error);
    return NextResponse.json({ error: 'Failed to delete settings' }, { status: 500 });
  }
}
