import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { HomeAssistantClient, isEmbeddedMode, isAddonMode } from '@/lib/api/homeassistant';
import {
  generateHAConfig, mergeConfiguration, mergeAutomations,
  detectPackagesConfig, addPackagesDirective, addPackageEntry,
  repairDuplicatePackagesDirective,
  stripSpoolmanSyncConfig, toPackageFileContent,
  type MissingEntityReport,
} from '@/lib/ha-config-generator';
import { createActivityLog } from '@/lib/activity-log';
import { getHiddenPrinters } from '@/app/api/printers/setup/route';
import { getOrCreateWebhookSecret, enableWebhookAuth } from '@/lib/webhook-secret';
import * as fs from 'fs/promises';


/**
 * Record any printer-level entities discovery couldn't find.
 *
 * Without this the only trace is a console.warn on the server, so a printer whose
 * `print_weight` is missing looks identical to a healthy one right up until the
 * user notices weight is never deducted. Writing it to the activity log puts it
 * on the Logs page where it is actually findable.
 */
async function logMissingEntities(missing: MissingEntityReport[]): Promise<void> {
  if (missing.length === 0) return;

  const breaking = missing.filter(m => m.breaksUsageTracking);
  const summary = missing
    .map(m => `${m.name || m.prefix} (${m.missing.join(', ')})`)
    .join('; ');

  await createActivityLog({
    type: 'error',
    message: breaking.length > 0
      ? `Filament usage tracking is disabled for ${breaking.length} printer(s) — required Home Assistant entities were not found: ${summary}`
      : `Some Home Assistant entities were not found: ${summary}`,
    details: { missingEntities: missing },
  });
}

export async function GET() {
  try {
    const automations = await prisma.automation.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // In addon mode, HA is always connected via Supervisor
    const haConnected = isAddonMode() || !!(await prisma.hAConnection.findFirst());
    const embeddedMode = isEmbeddedMode();
    const addonMode = isAddonMode();

    return NextResponse.json({
      automations,
      haConnected,
      embeddedMode,
      addonMode,
      configured: automations.length > 0,
    });
  } catch (error) {
    console.error('Error fetching automations:', error);
    return NextResponse.json({ error: 'Failed to fetch automations' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, webhookUrl } = body;

    const haClient = await HomeAssistantClient.fromConnection();
    if (!haClient) {
      return NextResponse.json({ error: 'Home Assistant not configured' }, { status: 400 });
    }

    if (action === 'discover') {
      // Discover printers and trays, filtering out any removed from SpoolmanSync
      const allDiscovered = await haClient.discoverPrinters();
      const hiddenForDiscover = await getHiddenPrinters();
      const hiddenTitlesForDiscover = new Set(hiddenForDiscover.map(h => h.title.toLowerCase()).filter(Boolean));

      const printers = hiddenTitlesForDiscover.size > 0
        ? allDiscovered.filter(p => {
            const name = p.name.toLowerCase();
            const entityId = p.entity_id.toLowerCase();
            return ![...hiddenTitlesForDiscover].some(t => name.includes(t) || entityId.includes(t));
          })
        : allDiscovered;

      if (printers.length === 0) {
        return NextResponse.json({
          error: 'No Bambu Lab printers found. Please ensure ha-bambulab is configured and printers are added in SpoolmanSync Settings.',
        }, { status: 400 });
      }

      // Use the same config generator as embedded mode for consistency.
      // Generate/inject the webhook secret so the produced automations authenticate.
      const webhookSecret = await getOrCreateWebhookSecret();
      const config = generateHAConfig(printers, webhookUrl, webhookUrl, webhookSecret);

      // Return printer registration data so the frontend can register
      // automations in the same per-printer format as auto-configure
      const printerRegistrations = printers.map(p => ({
        prefix: p.prefix,
        name: p.name,
        trayIds: [
          ...p.ams_units.flatMap(ams => ams.trays.map(t => t.entity_id)),
          ...p.external_spools.map(es => es.entity_id),
        ],
      }));

      await logMissingEntities(config.missingEntities);

      return NextResponse.json({
        trayCount: config.trayCount,
        printerCount: config.printerCount,
        automationsYaml: config.automationsYaml,
        configurationYaml: config.configurationAdditions,
        printerRegistrations,
        missingEntities: config.missingEntities,
      });
    }

    if (action === 'register') {
      // Register automations in our database (after user applies to HA)
      // Uses same per-printer format as auto-configure for consistent stale detection
      const { printerRegistrations } = body;

      const currentAutomationIds: string[] = [];
      for (const reg of printerRegistrations) {
        const automationId = `spoolmansync_update_spool_${reg.prefix}`;
        currentAutomationIds.push(automationId);

        await prisma.automation.upsert({
          where: { haAutomationId: automationId },
          create: {
            haAutomationId: automationId,
            trayId: reg.trayIds.join(','),
            printerId: reg.name,
          },
          update: {
            trayId: reg.trayIds.join(','),
            printerId: reg.name,
          },
        });
      }

      // Clean up stale automation records for printers no longer present
      const staleRecords = await prisma.automation.findMany({
        where: {
          haAutomationId: { startsWith: 'spoolmansync_update_spool_' },
          NOT: { haAutomationId: { in: currentAutomationIds } },
        },
      });
      if (staleRecords.length > 0) {
        await prisma.automation.deleteMany({
          where: { id: { in: staleRecords.map(r => r.id) } },
        });
      }

      // Also clean up any legacy external-mode-configured records
      await prisma.automation.deleteMany({
        where: { haAutomationId: 'spoolmansync_external-mode-configured' },
      });

      // The token-carrying automations are now applied — begin enforcing the
      // webhook secret. (Done here, not at preview time, so deductions never break.)
      await enableWebhookAuth();

      const totalTrays = printerRegistrations.reduce((sum: number, r: { trayIds: string[] }) => sum + r.trayIds.length, 0);
      await createActivityLog({
        type: 'automation_created',
        message: `Registered ${printerRegistrations.length} printer(s), ${totalTrays} tray(s)`,
        details: { printerRegistrations },
      });

      return NextResponse.json({ success: true, count: printerRegistrations.length });
    }

    if (action === 'auto-configure') {
      // Auto-configure HA in embedded or addon mode
      if (!isEmbeddedMode() && !isAddonMode()) {
        return NextResponse.json({
          error: 'Auto-configure is only available in embedded or add-on mode',
        }, { status: 400 });
      }

      // Discover printers, filtering out any hidden from SpoolmanSync
      const allPrinters = await haClient.discoverPrinters();
      const hiddenPrinters = await getHiddenPrinters();
      const hiddenTitles = new Set(hiddenPrinters.map(h => h.title.toLowerCase()).filter(Boolean));

      const printers = hiddenTitles.size > 0
        ? allPrinters.filter(p => {
            // Match by checking if the printer name or entity_id contains a hidden title
            const name = p.name.toLowerCase();
            const entityId = p.entity_id.toLowerCase();
            return ![...hiddenTitles].some(t => name.includes(t) || entityId.includes(t));
          })
        : allPrinters;

      if (printers.length === 0) {
        return NextResponse.json({
          error: 'No Bambu Lab printers found. Please add a printer in SpoolmanSync Settings first.',
        }, { status: 400 });
      }

      // Generate webhook URL
      // Addon mode: host networking, HA Core and addon share localhost
      // Embedded mode: Docker network hostname
      const addonPort = process.env.DIRECT_ACCESS_PORT || '3000';
      const internalWebhookUrl = isAddonMode()
        ? `http://127.0.0.1:${addonPort}/api/webhook`
        : 'http://spoolmansync-app:3000/api/webhook';

      // Generate configuration. Generate/inject the webhook secret so the
      // produced automations authenticate to the webhook.
      const webhookSecret = await getOrCreateWebhookSecret();
      const config = generateHAConfig(
        printers,
        internalWebhookUrl,
        internalWebhookUrl,
        webhookSecret
      );

      // Write config files to HA config directory
      // Addon mode: /config/ (mounted via config:rw mapping)
      // Embedded mode: /ha-config/ (Docker volume mount)
      const haConfigPath = isAddonMode() ? '/config' : '/ha-config';
      const automationsPath = `${haConfigPath}/automations.yaml`;
      const configPath = `${haConfigPath}/configuration.yaml`;

      try {
        // Merge automations.yaml (preserves user-created automations)
        let existingAutomations = '';
        try {
          existingAutomations = await fs.readFile(automationsPath, 'utf-8');
        } catch {
          console.log('No existing automations.yaml found');
        }
        const mergedAutomationsContent = mergeAutomations(existingAutomations, config.automationsYaml);
        await fs.writeFile(automationsPath, mergedAutomationsContent, 'utf-8');
        console.log('Wrote automations.yaml');

        // Read existing configuration.yaml
        let existingConfig = '';
        try {
          existingConfig = await fs.readFile(configPath, 'utf-8');
        } catch {
          console.log('No existing configuration.yaml found');
        }

        if (isAddonMode()) {
          // === ADD-ON MODE: Use HA packages to avoid conflicting top-level keys ===
          // This prevents issues when users split their config with !include directives.

          // Step 1: Strip any legacy SpoolmanSync block from configuration.yaml
          // (from previous versions that appended directly)
          let cleanedConfig = stripSpoolmanSyncConfig(existingConfig);
          if (cleanedConfig !== existingConfig) {
            console.log('Stripped legacy SpoolmanSync config block from configuration.yaml');
          }

          // Step 1b: Repair the duplicate-packages state older versions could
          // create (issue #73): our directive inserted alongside the user's own
          // packages: line. Remove ours so detection below finds theirs and the
          // package file lands in the directory HA actually loads.
          const repair = repairDuplicatePackagesDirective(cleanedConfig);
          if (repair.repaired) {
            cleanedConfig = repair.content;
            console.log('Removed duplicate SpoolmanSync packages directive from configuration.yaml (issue #73 repair)');
          }

          // Step 2: Detect current packages configuration style
          const packagesConfig = detectPackagesConfig(cleanedConfig);
          console.log(`Detected packages style: ${packagesConfig.style}`);

          // Step 3: Determine package file path and write it
          let packageFilePath: string;
          if (packagesConfig.style === 'directory') {
            const dirPath = `${haConfigPath}/${packagesConfig.directoryPath}`;
            await fs.mkdir(dirPath, { recursive: true });
            packageFilePath = `${dirPath}/spoolmansync.yaml`;
          } else if (packagesConfig.style === 'named') {
            packageFilePath = `${haConfigPath}/spoolmansync_package.yaml`;
          } else {
            // No packages — we'll create the directory and add the directive
            const dirPath = `${haConfigPath}/packages`;
            await fs.mkdir(dirPath, { recursive: true });
            packageFilePath = `${dirPath}/spoolmansync.yaml`;
          }

          const packageContent = toPackageFileContent(config.configurationAdditions);
          await fs.writeFile(packageFilePath, packageContent, 'utf-8');
          console.log(`Wrote package file: ${packageFilePath}`);

          // If the repair moved us out of the broken duplicate state, the old
          // package file under packages/ is orphaned (that directory is no
          // longer referenced). Best-effort cleanup so it can't confuse anyone.
          const legacyPackageFile = `${haConfigPath}/packages/spoolmansync.yaml`;
          if (repair.repaired && packageFilePath !== legacyPackageFile) {
            try {
              await fs.unlink(legacyPackageFile);
              console.log('Removed orphaned package file from packages/ (issue #73 repair)');
            } catch { /* already gone — fine */ }
          }

          // Step 4: Modify configuration.yaml if needed (scenarios A and C)
          let finalConfig = cleanedConfig;
          let configModified = cleanedConfig !== existingConfig; // true if legacy block was stripped or repaired

          if (packagesConfig.style === 'none') {
            // Scenario A: add packages directive. This REFUSES rather than
            // inserting a duplicate when an unrecognized packages: entry already
            // exists (issue #73) — a loud error beats a silently broken setup.
            const directiveResult = addPackagesDirective(finalConfig);
            if (directiveResult.conflict) {
              // Deliberately do NOT delete the package file that was just
              // written: it is inert unless something includes it, and in
              // split configs (homeassistant: !include ...) this exact path
              // may already be loaded via an include this tool cannot see —
              // deleting it would break a working setup.
              return NextResponse.json({
                error: `Cannot configure automatically: ${directiveResult.conflict}. ` +
                  `The package file was written to ${packageFilePath}; make sure your packages configuration loads that folder, ` +
                  'or share your configuration.yaml formatting at https://github.com/gibz104/SpoolmanSync/issues so detection can be improved.',
              }, { status: 400 });
            }
            finalConfig = directiveResult.content;
            configModified = true;
          } else if (packagesConfig.style === 'named' && !packagesConfig.hasSpoolmansync) {
            // Scenario C: add spoolmansync entry under existing packages block
            const withEntry = addPackageEntry(finalConfig, packagesConfig);
            if (withEntry === finalConfig) {
              // The entry could not be placed — refuse loudly instead of
              // reporting success with a package HA will never load. The
              // written package file is left in place (inert until included).
              return NextResponse.json({
                error: 'Cannot configure automatically: configuration.yaml has a packages: block SpoolmanSync could not add an entry to. ' +
                  `The package file was written to ${packageFilePath}; add "spoolmansync: !include spoolmansync_package.yaml" under your packages: block yourself, ` +
                  'or share your configuration.yaml formatting at https://github.com/gibz104/SpoolmanSync/issues so detection can be improved.',
              }, { status: 400 });
            }
            finalConfig = withEntry;
            configModified = true;
          }

          if (configModified) {
            // Back up before writing
            await fs.writeFile(`${configPath}.bak`, existingConfig, 'utf-8');
            console.log('Backed up configuration.yaml to configuration.yaml.bak');

            await fs.writeFile(configPath, finalConfig, 'utf-8');
            console.log('Wrote modified configuration.yaml');

            // Validate configuration via HA API
            try {
              const checkResult = await haClient.checkConfig();
              if (checkResult.result === 'invalid') {
                console.error('Configuration validation failed:', checkResult.errors);

                // Revert configuration.yaml from backup
                await fs.writeFile(configPath, existingConfig, 'utf-8');
                console.log('Reverted configuration.yaml from backup');

                // Clean up package file
                try { await fs.unlink(packageFilePath); } catch { /* ignore */ }

                return NextResponse.json({
                  error: `Configuration validation failed. Your configuration.yaml has been restored from backup. Error: ${checkResult.errors}`,
                }, { status: 400 });
              }
              console.log('Configuration validated successfully');
            } catch (validationError) {
              console.warn('Could not validate configuration (HA may not support check_config):', validationError);
              // Continue anyway — the config was written and backed up
            }
          }
        } else {
          // === EMBEDDED MODE: Append directly to configuration.yaml (SpoolmanSync controls this HA) ===
          const mergedConfig = mergeConfiguration(existingConfig, config.configurationAdditions);
          await fs.writeFile(configPath, mergedConfig, 'utf-8');
          console.log('Wrote configuration.yaml');
        }

        // YAML-configured entities (input_number, utility_meter, template, rest_command)
        // require a restart to be created - automation.reload is not sufficient.
        // In embedded mode, restart automatically (dedicated HA instance, nothing else running).
        // In addon mode, let the user decide when to restart (other integrations may be affected).
        if (isEmbeddedMode()) {
          try {
            console.log('Restarting Home Assistant to load new configuration...');
            await haClient.callService('homeassistant', 'restart', {});
            console.log('HA restart initiated');
          } catch {
            console.log('HA restart initiated (connection dropped as expected)');
          }
        }

        // Register one automation record per printer
        const currentAutomationIds: string[] = [];
        for (const printer of printers) {
          const prefix = printer.prefix;
          const printerTrayIds: string[] = [];
          for (const ams of printer.ams_units) {
            for (const tray of ams.trays) {
              printerTrayIds.push(tray.entity_id);
            }
          }
          for (const extSpool of printer.external_spools) {
            printerTrayIds.push(extSpool.entity_id);
          }

          const automationId = `spoolmansync_update_spool_${prefix}`;
          currentAutomationIds.push(automationId);

          await prisma.automation.upsert({
            where: { haAutomationId: automationId },
            create: {
              haAutomationId: automationId,
              trayId: printerTrayIds.join(','),
              printerId: printer.name,
            },
            update: {
              trayId: printerTrayIds.join(','),
              printerId: printer.name,
            },
          });
        }

        // Clean up stale automation records for printers no longer present
        const staleRecords = await prisma.automation.findMany({
          where: {
            haAutomationId: { startsWith: 'spoolmansync_update_spool_' },
            NOT: { haAutomationId: { in: currentAutomationIds } },
          },
        });
        if (staleRecords.length > 0) {
          await prisma.automation.deleteMany({
            where: { id: { in: staleRecords.map(r => r.id) } },
          });
          console.log(`Cleaned up ${staleRecords.length} stale automation record(s)`);
        }

        // Token-carrying automations have been written and HA (re)started — begin
        // enforcing the webhook secret now that the applied automations carry it.
        await enableWebhookAuth();

        const allTrayIds = printers.flatMap(p => [
          ...p.ams_units.flatMap(ams => ams.trays.map(t => t.entity_id)),
          ...p.external_spools.map(es => es.entity_id),
        ]);

        await createActivityLog({
          type: 'automation_created',
          message: `Auto-configured SpoolmanSync for ${config.printerCount} printer(s), ${config.trayCount} tray(s)`,
          details: { printers: printers.map(p => p.name), trayIds: allTrayIds },
        });

        await logMissingEntities(config.missingEntities);

        const addonMode = isAddonMode();
        return NextResponse.json({
          success: true,
          printerCount: config.printerCount,
          trayCount: config.trayCount,
          missingEntities: config.missingEntities,
          needsRestart: addonMode,
          message: addonMode
            ? `Configuration written for ${config.printerCount} printer(s), ${config.trayCount} tray(s). Home Assistant restart required to apply changes.`
            : `Configured ${config.trayCount} trays successfully. HA is restarting to apply changes.`,
        });

      } catch (writeError) {
        console.error('Failed to write HA config files:', writeError);
        return NextResponse.json({
          error: `Failed to write configuration files: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`,
        }, { status: 500 });
      }
    }

    if (action === 'restart-ha') {
      // Restart Home Assistant on user request
      if (!isEmbeddedMode() && !isAddonMode()) {
        return NextResponse.json({
          error: 'Restart is only available in embedded or add-on mode',
        }, { status: 400 });
      }

      console.log('User requested Home Assistant restart...');
      try {
        await haClient.callService('homeassistant', 'restart', {});
      } catch {
        // Expected: HA goes down immediately on restart, so the HTTP
        // connection drops before a response is sent (504, ECONNRESET, etc).
        // This confirms the restart is working, not an actual failure.
        console.log('HA restart initiated (connection dropped as expected)');
      }

      return NextResponse.json({
        success: true,
        message: 'Home Assistant is restarting. This may take a minute.',
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Error managing automations:', error);
    return NextResponse.json({ error: 'Failed to manage automations' }, { status: 500 });
  }
}

