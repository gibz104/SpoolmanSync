# Changelog

All notable changes to SpoolmanSync will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional "location when unassigned" holding pen. With location sync enabled, a spool removed from a tray normally has its Spoolman `location` cleared, which makes it disappear from Spoolman's location views until you remember to file it. You can now set a location — e.g. "Holding Pen" — that unassigned spools are parked in instead. The field appears under the "Sync spool locations to Spoolman" toggle and is empty by default, preserving the existing clear-on-unassign behavior; it has no effect at all unless location sync is on. A location you set by hand is still never overwritten.

### Fixed
- Spoolman location suggestions are no longer stale. The pick-list offered when creating a virtual printer was derived only from locations already written on spools, and counted archived spools. As a result, locations created in Spoolman didn't appear until a spool was moved into them, and deleted locations lingered indefinitely whenever an archived spool still carried the name. SpoolmanSync now reads Spoolman's own `locations` setting first (preserving your ordering) and then adds any additional locations found on non-archived spools — the same list Spoolman's Locations page builds — so the two always agree. The Settings page also refreshes the list when the tab regains focus.
- Missing Home Assistant entities no longer fail silently. When a printer-level entity such as `print_weight` couldn't be discovered, the generated configuration contained `states('')` — a template that errors on every evaluation, leaving the filament-usage sensor dead, the utility meter at zero, and no usage webhook ever sent, with the only trace a warning on the server console. SpoolmanSync now generates an explicitly unavailable sensor that names the missing entity, reports the problem in the Automations page (in every deployment mode) and the activity log, and keeps spool assignment and tray-change detection working. A missing print-stage entity no longer emits a blank trigger `entity_id` for Bambu or Creality printers, which previously made Home Assistant reject the entire automation — including the tray-change tracking that was otherwise unaffected. A printer discovered with no trays or external spools at all is now skipped rather than emitting an automation with an empty trigger list that would fail to load alongside every other printer in the same file.
- Spool serial (RFID / `tray_uuid`) auto-matching is no longer defeated by formatting. Matching required an exact match on the raw stored value, so a serial entered by hand in Spoolman — stored bare rather than JSON-encoded, or differing only in case or whitespace — never matched, and the resulting log entry claimed no matching spool existed. Comparison is now normalized on both sides, without coercing numeric-looking serials.
- The tray-change log entry no longer claims "no matching spool" when a spool is assigned. That check only ever looked up the tray's RFID serial, never the tray assignment, so it fired for any correctly-assigned spool that hadn't yet completed a tracked print — appearing to contradict the dashboard. The entry now states what was actually checked and records whether a spool remains assigned.
- Fixed two false positives in the dashboard's "possible wrong spool" warning: a Spoolman colour stored with a leading `#` was compared against a stripped RFID colour and always flagged, and material variants such as `PLA+` and `PLA_Basic` were flagged against the printer's `PLA`. Genuinely different materials, including compound ones such as `PLA-CF`, are still flagged.

- Add-on auto-configure no longer breaks setups that already use Home Assistant packages (#73). The detection of an existing `packages:` entry in configuration.yaml failed on CRLF line endings (files edited on Windows over Samba), on a UTF-8 BOM, and on quoted paths or trailing comments — SpoolmanSync then inserted a second `packages:` key under `homeassistant:`. YAML keeps the last duplicate key, so the SpoolmanSync package was silently never loaded while everything reported success, and automations failed at runtime with "Action rest_command.spoolmansync_tray_change not found". Detection now handles all of these forms, auto-configure refuses with a clear error instead of ever inserting a duplicate, and it automatically repairs the duplicate-key state left behind by earlier versions (only ever removing the exact line SpoolmanSync itself inserted).
- Connection failures during Home Assistant OAuth are no longer misreported as "OAuth authentication failed" when the real problem is that the SpoolmanSync container cannot reach Home Assistant at all (#74). Connecting now runs a quick reachability check before sending you to the Home Assistant login, and a network-level failure during token exchange is reported as exactly that, with a hint to check Docker networking.

### Changed
- External-mode setup instructions now require a full Home Assistant restart instead of offering "or reload automations". Reloading automations does not create the `input_number`, `utility_meter`, `template` and `rest_command` entries, which left tray-change detection working while filament usage was never deducted.

## [1.6.5] - 2026-07-11

### Added
- Optional two-way sync between spool locations and Spoolman's native `location` field (opt-in; off by default). Enable "Sync spool locations to Spoolman" in Settings and:
  - Assigning a spool to a real AMS/CFS tray sets its Spoolman location to `"<Printer> - <AMS> Tray <N>"` (or `"<Printer> - External"`), and assigning to a virtual printer (dry box/shelf) sets it to the virtual printer's name — so Spoolman reporting shows where every spool is, whether loaded in a printer or in storage.
  - When creating a virtual printer, existing Spoolman locations are offered as a pick-list so names line up with the native location field.
  - Unassigning a spool clears the location, but only when it still matches the label SpoolmanSync set — a location you set by hand is never overwritten. The feature is a no-op (and safe) when Home Assistant is unreachable, and only affects spools as they are assigned or unassigned.

## [1.6.4] - 2026-07-11

> Upgrade note: existing users should re-run Auto-configure / regenerate their Home Assistant automations so tray-change webhooks include the current print state. Without regenerating, the fix below stays inactive (behavior is unchanged, nothing breaks).

### Fixed
- Filament usage is no longer lost during an AMS runout / auto-refill mid-print (#71). When a tray ran empty while a print was still active, the ran-out spool could be auto-unassigned before its accumulated usage was flushed, so the deduction was dropped and only the replacement spool was charged. Tray-change events during an active print are now treated as possible runout transitions and the assignment is preserved, so the subsequent usage flush still matches and deducts from the correct spool. Empty-tray auto-clear continues to work as before when the printer is idle, finished, or offline.

## [1.6.3] - 2026-06-25

> Upgrade note (embedded mode): pull the latest images and recreate the containers, e.g. `docker compose pull && docker compose --profile embedded up -d`. On startup the bundled Home Assistant then refreshes ha-bambulab to the version shipped in the image.

### Fixed
- Embedded mode now keeps its bundled Home Assistant integrations up to date. Previously the bundled ha-bambulab was copied into the HA config only on first run and never refreshed, so existing embedded users stayed on an old version. The container now updates the bundled ha-bambulab (and ha_creality_ws) on startup whenever the image ships a newer version, without downgrading a newer copy or touching HACS-managed integrations. This delivers upstream ha-bambulab fixes, including the duplicate-AMS-device bug behind reports of phantom AMS HT units (#70).

## [1.6.2] - 2026-06-23

> Upgrade note: existing virtual-printer assignments migrate automatically the first time the dashboard or Settings page loads after updating — no manual steps required.

### Fixed
- Virtual-printer spool assignments now use a readable key in Spoolman — `virtual_<printer name>_tray_<N>`, matching the real-AMS key style — instead of the opaque `virtual:<uuid>:<uuid>` (#70). Existing assignments are migrated automatically. Renaming a virtual printer re-keys its assignments so none are lost, and virtual-printer names are now required to be unique.

## [1.6.1] - 2026-06-19

> Upgrade note: re-run **Auto-configure** (regenerate and re-apply the automations) and restart Home Assistant to pick up the updated tray trigger.

### Fixed
- Filament usage could be badly under-counted when the printer or MQTT connection briefly flickered mid-print (#69). A transient `unavailable` blip on the active-tray sensor was treated as a tray change by the Update Spool automation, which reset the usage meter and discarded the filament tracked so far (e.g. 2.3 g logged for a 25.6 g print). The tray trigger now ignores `unavailable`/`unknown` transitions on both Bambu and Creality printers.

## [1.6.0] - 2026-06-19

> Upgrade note: to apply the power-on and tray-clear fixes (#66, #65) and enable webhook authentication, re-run **Auto-configure** (regenerate and re-apply the automations) and restart Home Assistant. The other changes take effect on update alone.

### Added
- **Virtual printers** for dry boxes, filament dryers, and shelves (#67). Create them in Settings with assignable slots; they appear on the dashboard and support QR/NFC assignment like real trays, but are excluded from usage tracking. Deleting a printer or slot clears any spool assigned to it.
- **Single-spool / non-AMS printer support** (#68). Printers without an AMS/CFS (e.g. Ender 3 V3 KE) now get an assignable external-spool slot so their filament can be tracked.
- **Edit or delete usage events** from the Logs page to correct statistics (#54). By default this only adjusts SpoolmanSync's statistics; an opt-in option also adjusts the spool's remaining weight in Spoolman.
- **Webhook authentication**: the Home Assistant webhook can require a generated shared-secret token, injected into the automations, preventing unauthenticated inventory changes from other devices on the network.
- **"Never auto-clear tray assignments"** setting for setups with flaky AMS reporting (#65).
- Unit test suite (Vitest) covering the filament-tracking logic.

### Fixed
- Filament usage is no longer deducted a second time when a printer is powered back on (#66). The print-completion automation now ignores the printer's offline state, and the usage meter resets when the printer goes offline.
- Spool assignments are no longer cleared when the AMS briefly reports a tray as empty/unavailable during a reconnect (#65). The webhook ignores transient states and re-checks the live tray state before unassigning.
- Usage-by-spool report no longer shows the same used weight for different spools that share a vendor and color (#64). Spool labels now include the Spoolman id to distinguish identical filaments.
- The "Print Jobs" statistic counted every deduction event rather than prints; it is relabeled "Usage Events" to match the underlying data (#54).
- Live updates now fall back to polling if the event stream drops after connecting; plus assorted resource-leak, race-condition, and component-lifecycle fixes.
- Home Assistant token refresh now persists rotated refresh tokens and refreshes shortly before expiry.
- The Home Assistant admin password is no longer returned by the settings API on every load; it is revealed only on explicit request.

## [1.5.3] - 2026-04-19

### Fixed
- Dashboard now shows user-renamed printer names from Home Assistant instead of the integration-provided serial number. This was a regression from the WebSocket API migration.

## [1.5.2] - 2026-04-18

### Fixed
- Ingress port conflict with other add-ons when using host networking (#63). The add-on now uses dynamic port assignment from HA Supervisor instead of hardcoded port 8099.

## [1.5.1] - 2026-04-12

### Fixed
- Add-on mode configuration no longer conflicts with users who split their HA config using `!include` directives (#61). SpoolmanSync now writes to an isolated HA package file instead of appending to `configuration.yaml`.
- Configuration.yaml is backed up before modifications and validated via HA's check_config API, with automatic revert on failure.

## [1.5.0] - 2026-04-10

### Added
- **Creality printer support** via the [ha_creality_ws](https://github.com/3dg1luk43/ha_creality_ws) integration (#28). Supports K1, K2, K2 Plus, Hi, Ender 3 V3 and other Creality printers with CFS (Creality Filament System). Bambu Lab and Creality printers can be managed side-by-side on the same dashboard.
- Brand selection in the Add Printer dialog (Bambu Lab or Creality)
- Automatic filament weight calculation for Creality printers, converting reported length (cm) to weight (g) using material-specific density lookup (PLA, PETG, ABS, ASA, TPU, PC, Nylon, etc.)
- ha_creality_ws integration pre-installed in the embedded Home Assistant Docker image
- Better error messages when a printer integration is not installed in Home Assistant

### Changed
- Documentation streamlined and updated to reflect multi-brand support

## [1.4.3] - 2026-04-07

### Fixed
- Archived spools showing as "Unknown Spool" in usage reports (#58)
- Unassigned tray warnings not differentiating between AMS units on multi-printer/multi-AMS setups (#59)

### Added
- Optional spool location display on dashboard cards, enabled via Settings (#56)

## [1.4.2] - 2026-03-24

### Fixed
- AMS units merging together on multi-AMS setups where the model name (e.g., "AMS 2 Pro") was confused with the AMS unit number (#53)

### Added
- Configurable QR code / NFC base URL in Settings for users behind reverse proxies or custom domains (#52)
- Numbered display names for multiple AMS HT units (AMS HT, AMS HT 2, etc.)

## [1.4.1] - 2026-03-23

### Fixed
- AMS tray detection with ha-bambulab v2.2.21 which changed tray sensor `translation_key` from per-tray values (`tray_1`, `tray_2`) to a shared `tray` key with placeholders (#51)

## [1.4.0] - 2026-03-22

### Changed
- Entity discovery now uses HA's WebSocket API with translation_key matching instead of regex-based entity name patterns, making discovery stable across entity renames and HA language changes (#50)
- Spool-to-tray assignments are now stored by unique_id (stable) instead of entity_id (can change if renamed)
- External mode automation registration now uses per-printer format matching embedded/addon mode, enabling stale automation detection for all deployment modes

### Added
- Dashboard warning banner when HA entity IDs have changed since automations were last configured
- Fallback matching for pre-migration spools that still use entity_id-based assignments

### Fixed
- Jinja2 null guard for `trigger.from_state`/`trigger.to_state` in generated automations, preventing errors on HA restart

### Removed
- `entity-patterns.ts` and associated tests (replaced by WebSocket-based discovery)

## [1.3.6] - 2026-03-16

### Fixed
- Tray material mismatch warnings no longer trigger for filament variants of the same base material (e.g., "PLA Matte" assigned to a tray reporting "PLA") (#49)

## [1.3.5] - 2026-03-15

### Fixed
- AMS discovery for user-renamed AMS devices with custom names (e.g., `ams_links_`, `ams_rechts_`, `ams_left_`, `ams_right_`) now works via device-based fallback (#47)

## [1.3.4] - 2026-03-14

### Fixed
- AMS entity detection for H2D printers using compact naming format (e.g., `sensor.h2d_ams2_1_humidity`, `sensor.h2d_amsht_1_humidity`) (#45, #47)
- External spool detection for H2D printers using underscore+digit naming (e.g., `sensor.h2d_externalspool_1_external_spool`) (#45, #47)

## [1.3.3] - 2026-03-08

### Fixed
- AMS HT entity detection for H2C printers using compact naming format (e.g., `sensor.h2c_ht1_humidity` instead of `sensor.h2c_ams_ht_1_humidity`) (#35)

## [1.3.2] - 2026-03-08

### Added
- **Multi-external spool support** - Printers with multiple external spools (e.g., Bambu H2C) are now fully supported across discovery, dashboard, spool assignment, and automation config generation (#35)

### Fixed
- Active tray detection for external spools now uses the `active` attribute directly from ha-bambulab instead of inferring activity from AMS tray state, enabling accurate detection on multi-nozzle printers (#35)
- AMS HT entity detection improved with proper composite ID encoding and display name handling (#35)
- Usage report chart no longer shows gaps when days have zero usage; x-axis is now continuous

## [1.3.1] - 2026-03-01

### Added
- **Low filament stock alerts** — Get notified via Home Assistant persistent notifications when you're down to your last spool of a filament type and it's running low. Configurable thresholds (percentage or grams), grouping strategies (material, material+name, material+name+vendor), and selective group monitoring (#23)

### Fixed
- Printers with versioned ha-bambulab entities (e.g., `print_status` and `print_status_2`) no longer appear as duplicates on the dashboard (#35)
- External spool not detected for ha-bambulab versions using underscore hybrid entity names (e.g., `external_spool_externe_spoel`) — added support for all languages (#38)

## [1.3.0] - 2026-02-27

### Added
- **Filament usage reporting dashboard** — New Reports page with summary cards, per-spool bar chart with filament color fills, stacked area chart for usage over time, and detail table. Filter by time period (7d, 30d, 90d, 1y, all) with automatic daily/weekly bucketing (#22)
- **Kiosk mode** — Touch-optimized interface at `/kiosk` for small screens with USB NFC/RFID readers (e.g., Raspberry Pi kiosk setups). Cookie-based opt-in, zero impact on normal users (#29)
- **App version display** — Version number shown in footer on all pages (#30)

### Fixed
- Null vendor on filaments no longer crashes the dashboard (#31)
- Number input fields in QR label settings no longer clamp values on every keystroke, allowing multi-digit entry (#32)
- Stacked area chart in usage report uses linear interpolation to prevent visual crossing artifacts

## [1.2.4] - 2026-02-22

### Fixed
- No longer store or auto-match against all-zero spool serial numbers from non-Bambu spools (#15)

## [1.2.3] - 2026-02-22

### Fixed
- Internal Next.js port (3001) no longer hardcoded in add-on mode — now derived dynamically from the configured direct access port to avoid conflicts on host_network (#27)

## [1.2.2] - 2026-02-22

### Added
- **AMS filament info in unassigned tray banner** — the "Assign Spools to Trays" alert now shows the material, name, and color reported by the AMS for each unassigned tray, making it easier to find the matching Spoolman spool (#15)

### Fixed
- Generated REST command webhook URL in add-on mode now uses the configured port instead of hardcoded 3000 (#26)

## [1.2.1] - 2026-02-17

### Added
- **"Remaining" weight badge** on dashboard tray slots showing filament remaining
- **Multi-color filament display** across all spool color swatches (dashboard, tray dialog, scan pages)
- **Expand/collapse toggle** for spool list in the QR label generator

### Fixed
- Remove printer button no longer deletes the printer from ha-bambulab — now only removes it from SpoolmanSync with the ability to re-add (#25)
- "Go to Settings" button on automations page navigated to a 404 in add-on mode (ingress path issue)
- Dashboard, automations discovery, and auto-configure now correctly filter out printers removed from SpoolmanSync
- HA restart after automation configuration in add-on mode now prompts user instead of restarting without warning
- Responsive UI improvements for logs filter buttons, tray "Remaining" badge, and label sheet print settings on small screens

## [1.2.0] - 2026-02-17

### Added
- **Multi-printer automation support** — Configure Automations now generates per-printer automations, helpers, and template sensors for all discovered printers instead of only the first (#20)
- **Spool sorting** — Sort by ID, Name, Material, or Vendor in the QR label generator, NFC writer, and tray assignment dialog
- **QR label sheet persistence** — Label sheet settings and printed-spool tracking are saved to localStorage across sessions
- **AMS Pro type-first entity naming** — Support for Danish and other locales where ha-bambulab produces entity IDs like `ams_pro_2_bakke_1` (#18)

### Fixed
- `utility_meter.calibrate` unknown action error — `cycle: none` is not a valid HA utility_meter value; omit the key entirely for no-cycle behavior (#19, #21)
- Responsive UI issues on logs page and tray assignment dialog on mobile

### Changed
- Helper entity names now include the printer prefix (e.g., `input_number.spoolmansync_{prefix}_last_tray`). **Existing users must click "Reconfigure Automations" once** after updating. Old singleton entities will become orphaned and can be manually deleted from the HA entity registry.

## [1.1.2] - 2026-02-16

### Added
- **Multi-spool label sheet printing** — Select multiple spools and print QR labels on standard label sheets (e.g., Avery 8160). Configurable paper size, grid layout, margins, spacing, borders, and label content

### Fixed
- Incorrect filament usage for long prints crossing Monday midnight — utility meter was configured with `cycle: weekly`, causing HA to reset accumulated weight automatically (#19)
- False RFID mismatch warnings on non-Bambu (third-party) spools without RFID tags (#15)

## [1.1.1] - 2026-02-14

### Added
- Configurable direct access port for the HA add-on — change in the add-on Configuration tab to avoid port 3000 conflicts with other add-ons (#14)

### Fixed
- QR code and NFC tag URLs now use the configured port instead of hardcoded 3000
- Removed confusing duplicate Network port section from add-on Configuration UI

## [1.1.0] - 2026-02-13

### Added
- **Home Assistant add-on** - Install directly from the HA add-on store with ingress sidebar integration; auto-discovers printers from ha-bambulab
- **QR code label generation** - Create and print QR code labels for spools; scan with phone camera to assign to AMS trays
- **NFC tag writing** - Write spool URLs to NFC sticker tags for tap-to-assign on Android devices
- **Dynamic spool assignment page** - QR scans and NFC taps redirect to a dedicated assignment page with tray selection
- **AMS 2 Pro and AMS HT support** - Entity pattern matching for newer AMS hardware variants
- **Auto-recovery for broken HA connections** - Embedded mode silently re-authenticates when tokens are invalidated; shows reconnect form if password was changed (#10)
- **Unraid Community Apps template** - XML template and icon for Unraid CA store

### Fixed
- External spool active tray detection for printers without AMS (#11)
- Crash when assigned spool has missing filament color or material data (#12)
- AMS discovery for entities with renamed or missing printer prefix

## [1.0.0] - 2026-02-09

### Added
- **Dashboard** - View all printers, AMS units, and tray assignments at a glance
- **Spool assignment** - Click any tray to assign a spool from Spoolman inventory
- **QR/barcode scanning** - Scan Spoolman QR codes to quickly look up and assign spools
- **Automatic filament usage tracking** - Deduct used filament weight after prints
- **Multi-AMS support** - Track multiple AMS units per printer
- **A1 AMS Lite support** - Works with Bambu A1/A1 Mini
- **External spool support** - Track filament loaded outside the AMS
- **Bundled Home Assistant** - Embedded mode includes pre-configured HA with HACS and ha-bambulab
- **Bambu Cloud login** - Add printers using Bambu Cloud credentials
- **17 language support** - Works with all ha-bambulab localizations
- **Multi-architecture Docker builds** - Supports amd64 and arm64
