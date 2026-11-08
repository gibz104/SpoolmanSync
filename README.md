# SpoolmanSync

**Automatic filament tracking for Bambu Lab and Creality printers with Spoolman**

![Build Status](https://github.com/gibz104/SpoolmanSync/actions/workflows/docker-publish.yml/badge.svg)
[![Ko-Fi](https://img.shields.io/badge/Ko--fi-Support%20this%20project-ff5f5f?logo=ko-fi)](https://ko-fi.com/gibz104)
[![GitHub stars](https://img.shields.io/github/stars/gibz104/SpoolmanSync?style=social)](https://github.com/gibz104/SpoolmanSync)

SpoolmanSync is a web app that automatically tracks which filament spools are loaded in your 3D printer's AMS/CFS and keeps [Spoolman](https://github.com/Donkie/Spoolman) inventory in sync, deducting the filament each print uses from the right spool. Works with **Bambu Lab** (X1C, P1S, P2S, A1, H2D, X2D with AMS, AMS 2 Pro, AMS HT, AMS Lite) and **Creality** (K1, K2, K2 Plus, Hi, Ender 3 V3 with CFS) printers, and supports filament from any vendor.

No YAML editing. No Home Assistant expertise required.

## Features

- **Web dashboard** — view printers, AMS/CFS units, and tray assignments at a glance
- **Click-to-assign** — pick spools from your Spoolman inventory with search and filters
- **Multi-brand support** — Bambu Lab and Creality printers side-by-side on one dashboard
- **Automatic usage tracking** — deducts the filament each tray uses as a print runs, settles a finished print to the slicer's per-tray figures (purge and prime tower included), and charges a cancelled print only for what it printed
- **Print history** — every print listed under **Reports → Recent Prints** with what it deducted from which spool; anything that cannot be accounted for is flagged instead of guessed
- **QR & NFC** — scan Spoolman QR codes, print your own QR labels, or write NFC stickers for instant assignment
- **Kiosk mode** — a touchscreen spool-scanning station (a Raspberry Pi by the printer, say)
- **Low stock alerts** — Home Assistant notifications when you're down to your last spool of a type
- **Multi-AMS / multi-CFS** — works with any combination of units per printer
- **Localized Home Assistant** — supports non-English HA installations (German, Dutch, Spanish, Italian, etc.)
- **Works with all filament brands** — Polymaker, Sunlu, Elegoo, Hatchbox, eSUN, generic, etc.
- **Three install modes** — HA add-on, embedded (bundled HA), or connects to your existing HA

## Installation

Pick the option that matches your setup:

### Option 1: Home Assistant Add-on (recommended for HA OS / Supervised)

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add `https://github.com/gibz104/SpoolmanSync`
3. Install **SpoolmanSync**, start it, and enable **Show in sidebar**
4. Open from the sidebar and configure Spoolman URL in Settings

Requires the [ha-bambulab](https://github.com/greghesp/ha-bambulab) integration (for Bambu Lab) or [ha_creality_ws](https://github.com/3dg1luk43/ha_creality_ws) (for Creality), both installable via [HACS](https://hacs.xyz/), plus [Spoolman](https://github.com/Donkie/Spoolman) running on your network.

### Option 2: Embedded Mode (bundled Home Assistant)

Best for users without Home Assistant. Includes a pre-configured HA with ha-bambulab and ha_creality_ws already installed.

```bash
curl -O https://raw.githubusercontent.com/gibz104/SpoolmanSync/main/docker-compose.prebuilt.yml
docker compose -f docker-compose.prebuilt.yml --profile embedded up -d
```

Open http://localhost:3000, then in **Settings** click **Add Printer** and choose your printer brand.

### Option 3: External Mode (existing Home Assistant)

For users who already run Home Assistant with ha-bambulab or ha_creality_ws installed.

```bash
curl -O https://raw.githubusercontent.com/gibz104/SpoolmanSync/main/docker-compose.prebuilt.yml
docker compose -f docker-compose.prebuilt.yml --profile external up -d
```

Open http://localhost:3000 and connect to your existing HA in **Settings**. Your printers will appear automatically on the dashboard.

## Initial Setup

After any install mode:

1. **Connect Spoolman** — enter your Spoolman URL in **Settings**
2. **Add printers** — in add-on or embedded mode, click **Add Printer** and pick Bambu Lab or Creality; in external mode printers are auto-discovered
3. **Assign spools** — click any tray on the dashboard to assign a spool from Spoolman
4. **Generate automations** (for tray changes) — go to **Automations** and click **Configure Automations**. In add-on/embedded mode this is one click. In external mode you'll copy the generated YAML into your HA `configuration.yaml` and `automations.yaml`, restart HA, then click **Mark as Configured**. These let SpoolmanSync auto-assign Bambu spools by their RFID tag and clear a tray you empty; usage tracking does not depend on them

That's it. As you print, filament is deducted from the assigned spools, and each print is listed under **Reports → Recent Prints**.

**Upgrading from 1.x?** Usage used to be tracked by generated Home Assistant helpers and automations. Re-run **Configure Automations** (or, in external mode, replace the SpoolmanSync YAML you copied into Home Assistant) to remove them. Until then their usage reports are ignored, so nothing is deducted twice. Run one SpoolmanSync per Home Assistant and Spoolman: every install connected to them now deducts usage, so a second one (a test install beside your usual one, say) deducts each print again.

## How It Works

**Printer → Home Assistant (ha-bambulab or ha_creality_ws) → SpoolmanSync → Spoolman**

SpoolmanSync discovers your printers and their AMS/CFS trays from Home Assistant. When you assign a spool to a tray, the assignment is stored in Spoolman's `extra.active_tray` field.

### Filament usage tracking

SpoolmanSync tracks usage itself, following each printer's entities over Home Assistant's WebSocket API. No Home Assistant helpers, sensors or YAML are involved, and Spoolman is updated as the print runs.

- **Bambu Lab** — the slicer's plate weight (ha-bambulab's *Print weight* sensor) times print progress, counted from when the printer starts printing: heating, levelling and calibrating move the progress but use next to no filament. A finished print is settled to the slicer's per-tray figures, purge and prime tower included.
- **Creality** — the length the printer reports extruding, converted with the density and diameter Spoolman records for the spool's filament.
- **Multi-colour prints** — each tray is charged while it feeds; a finished print settles to the slicer's split.
- **Cancelled or failed prints** — charged for what was printed; a print cancelled while the printer is still preparing is charged nothing.
- **Spoolman offline** — what a print owes is kept and deducted once Spoolman is reachable again.
- **Records** — every print is listed under **Reports → Recent Prints** with what it deducted, and the **Logs** page shows each print as it starts.

The generated Home Assistant automations only report tray changes, for RFID auto-matching and for clearing a tray you empty.

### Spool matching

Spool matching works in three ways:
- **Manual assignment** (all vendors) — click a tray, pick a spool
- **RFID auto-match** (Bambu Lab spools with tags) — remembers which physical spool is which for future swaps. Creality CFS reports a material-type code rather than a per-spool serial, so Creality spools are matched by their tray assignment instead
- **QR code / NFC** (any vendor) — scan printed QR labels or NFC stickers with your phone to assign

## Low Stock Alerts

Get notified via Home Assistant when you're down to your last spool of a filament type and it's running low. Configure in **Settings → Low Filament Alerts**:
- Threshold type (percentage or grams)
- Grouping (by material, material+name, or material+name+vendor)
- Selective monitoring — track only the groups you care about

Alerts fire only when you're on your *last* spool of a group — no noise from partially-used spools when you have backups.

## Troubleshooting

**No printers showing up** — verify ha-bambulab or ha_creality_ws is installed in HA and your printers appear in the HA entity registry. Check the Logs page in SpoolmanSync.

**Nothing deducted after a print** — open **Reports → Recent Prints**. It says whether SpoolmanSync is connected to Home Assistant and lists every print it followed, with a note on any print it could not deduct (no spool assigned to the tray, say).

**Tray changes not picked up** — tray changes reach SpoolmanSync through the generated automations' webhook (usage tracking does not use it). Make sure you clicked **Mark as Configured** after adding automations (external mode), and that HA can reach SpoolmanSync at the URL you entered. Use your machine's IP, not `localhost`, if HA is on a different machine.

**QR scanner or NFC not working** — browsers require HTTPS for camera and NFC access from non-`localhost` addresses. Use a reverse proxy, Tailscale, or access via `http://localhost:3000` on the same machine. Web NFC is Android-only (Chrome, Edge, Opera, Samsung Internet).

**Creality filament weight looks wrong** — ha_creality_ws reports filament usage as a length, which SpoolmanSync converts to weight with the density and diameter of the spool's filament in Spoolman. Check those values in Spoolman if a spool's deductions look off.

**A print shows a warning under Recent Prints** — SpoolmanSync deducts nothing it cannot account for, and says why instead: Home Assistant never reported the print's weight (on a Bambu printer this happens when ha-bambulab cannot find the print's file, or when a different print weighs exactly what the one before did, which Home Assistant shows as no change), a tray that fed it had no spool assigned (or had several), objects were skipped (the plate weight still includes them), or Spoolman did not confirm a deduction (check that spool's weight). A job resumed after a power loss is noted too: it is charged only for the part printed after it resumed. A print that ran entirely while SpoolmanSync was not running shows as **Not seen**: nothing was deducted for it, so deduct it in Spoolman. The same notes appear on the Logs page.

**A Bambu print was charged far less than the slicer said** — SpoolmanSync charges the weight in the printer's *Print weight* sensor. When ha-bambulab 2.2.26 or earlier cannot find a print's file, that sensor shows an earlier print's weight instead ([ha-bambulab#2155](https://github.com/greghesp/ha-bambulab/issues/2155), fixed in ha-bambulab 2.3.0 for printers it reads over FTP). If it still shows the last print's, the print is flagged and nothing is charged, but an older print's weight cannot be told apart from the real one, so check that sensor's history for the print.

## FAQ

**Does SpoolmanSync need Home Assistant?** Yes. It reads your printers through Home Assistant's ha-bambulab or ha_creality_ws integration. Embedded mode bundles a pre-configured Home Assistant, and the add-on runs inside Home Assistant OS.

**Does it work with non-Bambu filament?** Yes, filament from any vendor works. Assign a spool by clicking a tray, or by QR code or NFC; only Bambu Lab spools with RFID tags are matched automatically.

**How accurate is the filament usage?** A finished Bambu Lab print is charged exactly the slicer's per-tray figures. A cancelled print is charged by how far it got, and Creality usage comes from the length the printer reports extruding.

**Do I need to edit YAML?** No. In add-on and embedded mode one click sets up the tray-change automations; in external mode you paste the generated YAML once. Usage tracking needs no YAML at all.

**Can I run more than one SpoolmanSync?** Run one per Home Assistant and Spoolman. Every connected instance deducts usage, so a second one would deduct each print again.

## Links

- [Changelog](CHANGELOG.md)
- [GitHub Issues](https://github.com/gibz104/SpoolmanSync/issues)
- [Home Assistant Community post](https://community.home-assistant.io/t/spoolmansync-automatic-filament-tracking-for-bambu-lab-printers-beginner-friendly/977383)
- [Docker Hub](https://hub.docker.com/r/gibz104/spoolmansync)

## License

MIT — see [LICENSE.txt](LICENSE.txt)
