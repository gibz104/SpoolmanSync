# SpoolmanSync

**The easiest way to sync Bambu Lab AMS filament with Spoolman**

![Build Status](https://github.com/gibz104/SpoolmanSync/actions/workflows/docker-publish.yml/badge.svg)
[![Ko-Fi](https://img.shields.io/badge/Ko--fi-Support%20this%20project-ff5f5f?logo=ko-fi)](https://ko-fi.com/gibz104)
[![GitHub stars](https://img.shields.io/github/stars/gibz104/SpoolmanSync?style=social)](https://github.com/gibz104/SpoolmanSync)

> **Tired of manually editing YAML files?** SpoolmanSync provides a modern web UI for Bambu Lab filament tracking with Spoolman - no Home Assistant expertise required.

SpoolmanSync automatically tracks which filament spools are loaded in your Bambu Lab printer's AMS units and syncs this information with [Spoolman](https://github.com/Donkie/Spoolman) for accurate filament inventory management. Works with **all filament brands** - not just Bambu Lab spools.

## Why SpoolmanSync?

| Feature | SpoolmanSync | Other Solutions |
|---------|:------------:|:---------------:|
| Web UI for spool assignment | ✅ | ❌ |
| QR/Barcode scanning | ✅ | ❌ |
| Printable QR code labels | ✅ | ❌ |
| NFC tag writing | ✅ | ❌ |
| Home Assistant add-on | ✅ | ❌ |
| Bundled Home Assistant option | ✅ | ❌ |
| No YAML editing required | ✅ | ❌ |
| Multi-AMS support | ✅ | Limited |
| Non-English Home Assistant support | ✅ | ❌ |
| Works with ANY filament brand | ✅ | Partial |
| Low stock alerts | ✅ | ❌ |
| Automatic filament usage tracking | ✅ | ✅ |

## Fork Additions

This fork extends the upstream project with improvements focused on reliable automatic spool matching for non-Bambu filaments. See the relevant sections below for full details.

**Filament Profile Linking page:**
- [Direct Bambu Cloud login](#filament-profile-linking) from the Filaments page — no printer re-registration needed
- Multi-select link modal — one Bambu profile ID can map to many Spoolman filaments (different colors of the same material)
- Material + Vendor filter dropdowns and spool ID in the link modal
- Sortable table columns with link count display ("5 Linked" vs "Unlinked")
- Spoolman quick-access button in the page header
- Persistent color reference panel state (saved across reloads)

**Dashboard:**
- Taller spool selector popup (60 vh instead of fixed 300 px)

**Auto-matching improvements:**
- [Single-candidate bypass](#priority-2-filament-profile-id--color) — skips the color threshold when exactly one spool matches a filament profile ID
- [Learning from manual assignments](#learning-from-manual-assignments) — each manual assignment teaches the system to auto-match the same spool next time

**Building this fork:** Clone this repository and follow the [Building from Source](#building-from-source) instructions. There is no pre-built image for this fork. If the changes are merged upstream, the official image will be updated automatically.

---

## Features

- **Dashboard** - View all your printers, AMS units, and tray assignments at a glance
- **Spool Assignment** - Click any tray to assign a spool from your Spoolman inventory
- **Filament Profile Linking** - Link Bambu Studio filament profiles to Spoolman filaments for reliable automatic matching without NFC tags
- **QR Code Scanning** - Scan Spoolman QR codes or custom barcodes to quickly look up and assign spools
- **QR Label Generation** - Create and print QR code labels for your spools. Scan with your phone camera to quickly assign to AMS trays
- **NFC Tag Writing** - Write spool links to NFC sticker tags. Tap with your phone to assign spools (Android only: Chrome, Edge, Opera, Samsung Internet)
- **Low Stock Alerts** - Get notified when you're down to your last spool of a filament type and it's running low. Sent as Home Assistant persistent notifications
- **Kiosk Mode** - Touch-optimized interface for small screens with USB NFC/RFID readers (e.g., Raspberry Pi kiosk setups)
- **AMS 2 Pro & AMS HT Support** - Works with all AMS hardware variants
- **Bambu Cloud Login** - Add printers by logging in with your Bambu Cloud account
- **Home Assistant Add-on** - Install directly from the HA add-on store with sidebar integration
- **Bundled Home Assistant** - Includes a pre-configured Home Assistant with ha-bambulab integration
- **Webhook Integration** - Receives tray change events from Home Assistant automations
- **Activity Logging** - Track all spool changes and sync events

## Home Assistant Add-on (Recommended for HA OS users)

If you're running Home Assistant OS or Supervised, install SpoolmanSync directly as an add-on:

1. Add this repository to your add-on store:
   - Go to **Settings** → **Add-ons** → **Add-on Store**
   - Click **⋮** (top right) → **Repositories**
   - Add: `https://github.com/gibz104/SpoolmanSync`
2. Find **SpoolmanSync** in the store and click **Install**
3. Start the add-on and enable **Show in sidebar**
4. Open SpoolmanSync from the sidebar — your printers are automatically discovered from ha-bambulab
5. Configure your Spoolman URL in **Settings** (or in the add-on configuration tab)
6. Go to **Automations** and click **Configure Automations**

**Port conflict?** The add-on uses port `3000` by default for direct access and QR/NFC scanning. If another add-on or service is already using port 3000, change it in the add-on's **Configuration** tab.

**Requirements:** [ha-bambulab](https://github.com/greghesp/ha-bambulab) integration installed via [HACS](https://hacs.xyz/) and [Spoolman](https://github.com/Donkie/Spoolman) running and accessible from Home Assistant.

---

## Quick Install (Pre-built Images)

The fastest way to get started with Docker using pre-built images:

```bash
# Download the compose file
curl -O https://raw.githubusercontent.com/gibz104/SpoolmanSync/main/docker-compose.prebuilt.yml

# Start with embedded Home Assistant (recommended for most users)
docker compose -f docker-compose.prebuilt.yml --profile embedded up -d

# Or, if you already have Home Assistant with ha-bambulab
docker compose -f docker-compose.prebuilt.yml --profile external up -d
```

Then open http://localhost:3000 and follow the setup steps below.

---

## Building from Source

If you prefer to build locally or want to contribute:

### 1. Clone the Repository

```bash
git clone https://github.com/gibz104/SpoolmanSync.git
cd SpoolmanSync
```

### 2. Choose Your Mode

SpoolmanSync requires a Docker Compose profile. Choose based on your setup:

| Mode | Command | Best For |
|------|---------|----------|
| **Add-on** | [See above](#home-assistant-add-on-recommended-for-ha-os-users) | HA OS / Supervised users |
| **Embedded** | `docker compose --profile embedded up -d` | Most users - includes bundled Home Assistant |
| **External** | `docker compose --profile external up -d` | Users who already have Home Assistant with ha-bambulab |

---

## Embedded Mode Setup (Recommended)

Use this if you don't have Home Assistant or want a simpler setup.

### Step 1: Start the Application

```bash
docker compose --profile embedded up -d
```

### Step 2: Open the UI

Go to http://localhost:3000 in your browser.

### Step 3: Add Your Printer

1. Go to **Settings** in the navigation
2. Click **Add Printer**
3. Log in with your Bambu Cloud email and password
4. Enter the verification code sent to your email
5. Select your printer from the list
6. Click **Continue**

https://github.com/user-attachments/assets/51e006da-cdae-4db8-b261-bd622802ff62

### Step 4: Connect Spoolman

1. In **Settings**, scroll to the Spoolman section
2. Enter your Spoolman URL (e.g., `http://127.0.0.1:7912`)
3. Click **Connect**

https://github.com/user-attachments/assets/47153c92-0a99-4749-8519-a24f1baad8a6

### Step 5: Set Up Automations

This enables automatic tray change detection.

1. Go to **Automations** in the navigation
2. Click **Configure Automations**
3. The automations are automatically created in the embedded Home Assistant

https://github.com/user-attachments/assets/4019ee5d-b2bb-4ae9-9c52-f581ec43f8c5

### You're Done!

Your dashboard should now show your printer with AMS trays. Click any tray to assign a spool from your Spoolman inventory.

---

## External Mode Setup

Use this if you already have Home Assistant with [ha-bambulab](https://github.com/greghesp/ha-bambulab) configured.

### Step 1: Start the Application

```bash
docker compose --profile external up -d
```

### Step 2: Open the UI

Go to http://localhost:3000 in your browser.

### Step 3: Connect Home Assistant

1. Go to **Settings** in the navigation
2. Enter your Home Assistant URL (e.g., `http://127.0.0.1:8123`)
3. Click **Connect with Home Assistant**
4. You'll be redirected to Home Assistant to authorize SpoolmanSync
5. Enter you Home Assistant credentials and click "Log in"

https://github.com/user-attachments/assets/1f711fd2-28cd-41b5-8a41-06e991baec83

Your printers should automatically appear on the dashboard (discovered from ha-bambulab).

### Step 4: Connect Spoolman

1. In **Settings**, scroll to the Spoolman section
2. Enter your Spoolman URL (e.g., `http://127.0.0.1:7912`)
3. Click **Connect**

https://github.com/user-attachments/assets/915a321a-a6a8-4f81-85ae-5e7f6121f536

### Step 5: Set Up Automations

This enables automatic spool tracking and filament usage monitoring.

1. Go to **Automations** in the navigation
2. Enter the **SpoolmanSync URL** - the address where Home Assistant can reach SpoolmanSync (e.g., `http://192.168.1.100:3000`). Use your machine's IP address, not `localhost`, if Home Assistant is on a different machine.
3. Click **Generate Configuration**
4. You'll see two YAML configurations:
   - **configuration.yaml** - Copy and add to your Home Assistant's `configuration.yaml`
   - **automations.yaml** - Copy and add to your Home Assistant's `automations.yaml`
5. Restart Home Assistant
6. Return to SpoolmanSync and click **Mark as Configured**

https://github.com/user-attachments/assets/06f0c220-e30a-4d19-9960-d8d6c10ae257

### You're Done!

Your dashboard should now show your printers with AMS trays. Click any tray to assign a spool from your Spoolman inventory.

---

## Stopping and Restarting

Always use the same profile you used to start:

```bash
# Embedded mode
docker compose --profile embedded down      # Stop
docker compose --profile embedded up -d     # Start

# External mode
docker compose --profile external down      # Stop
docker compose --profile external up -d     # Start
```

---

## How It Works

1. **Discovery**: SpoolmanSync connects to Home Assistant and discovers Bambu Lab printers via the ha-bambulab integration entities.

2. **Manual Assignment**: Users can manually assign spools to trays via the dashboard or by scanning QR codes.

3. **Automatic Sync**: When Home Assistant automations detect tray changes, they call the SpoolmanSync webhook with tray information (color, material, filament ID, tag UID). SpoolmanSync matches this to spools in Spoolman using a priority-based matching chain and updates the `active_tray` extra field.

4. **Spoolman Integration**: All spool assignments are stored in Spoolman's `extra` field as `active_tray`, making it compatible with other Spoolman integrations.

---

## Automatic Spool Matching (No NFC Required)

This fork adds automatic tray-to-spool matching for **non-Bambu spools without NFC tags** (e.g. Sunlu, Polymaker, generic brands). Matching uses a priority chain:

| Priority | Method | Requires |
|----------|--------|----------|
| 1 | Bambu RFID serial (`tray_uuid`) | Bambu-brand spools with NFC |
| 2 | **Filament profile ID + color** | `filament_id` set in Spoolman filament extra field |
| 3 | **Color + material fuzzy match** | Color within RGB distance 40 of Spoolman filament color |
| 4 | Manual assignment | Always available as fallback |

### Priority 2: Filament Profile ID + Color

Bambu Studio assigns a unique profile ID (e.g. `Pa8c5a1a`) to each filament profile. The ha-bambulab integration exposes this as the `filament_id` attribute on AMS tray sensors. When you load a spool, Bambu broadcasts its profile ID — SpoolmanSync uses this to narrow candidates to the right profile, then color to pick the exact color variant.

**Setup:**
1. In Spoolman, go to **Settings** → **Extra Fields** → add a field on **Filaments** with key `filament_id`
2. Link profiles on the **Filaments** page (see [Filament Profile Linking](#filament-profile-linking)) — this sets the `filament_id` extra field automatically
3. Ensure the HA automation passes `filament_id` — the generated automation config in this fork includes it automatically

**Single-candidate bypass:** If exactly one Spoolman filament has the matching `filament_id`, it is selected immediately without a color check. The color threshold only applies when multiple filaments share the same profile ID (e.g. you have several colors of the same product line) — in that case, color distance determines which one is loaded.

### Priority 3: Color + Material Fuzzy Match

Falls back to matching by color (RGB Euclidean distance ≤ 40) and normalized material type (`PLA+` → `PLA`, `PETG-HF` → `PETG`, etc.). Works without any extra configuration as long as your Spoolman filament colors roughly match what you select on the Bambu machine display.

**Color note:** Bambu's machine display uses a fixed palette of ~20 colors. The threshold of 40 RGB units is calibrated so adjacent palette colors (minimum ~47 units apart) are never confused. See the **Bambu Color Reference** panel on the Filaments page for the full palette.

If multiple spools match the same color + material, the name hint from the printer is used to disambiguate.

### Learning from Manual Assignments

Every time you manually assign a spool via the dashboard, SpoolmanSync learns from it to improve future auto-matching:

1. **RFID serial stored** — if the tray reports a non-zero `tray_uuid` (Bambu-brand spools), it is written to the spool's `location` tag so Priority 1 (RFID) can match it on the next swap without any manual step.

2. **Profile linked automatically** — if the tray name matches a known Bambu filament profile and the Spoolman filament doesn't yet have a `filament_id` set, SpoolmanSync links them. Priority 2 will then auto-match this spool on the next swap.

This means the system gets smarter with use: after manually assigning a spool once, the same spool will typically be recognized automatically in subsequent swaps.

---

## Filament Profile Linking

The **Filaments** page is the control center for linking Bambu Studio filament profiles to Spoolman filaments. This is what powers Priority 2 automatic matching — once a profile is linked, SpoolmanSync can identify which spool is loaded without NFC tags.

### Connecting to Bambu Cloud

The Filaments page includes a direct login form so you can fetch profiles without going through the Settings printer-registration flow (useful if your printers are already registered).

1. Go to **Filaments** in the navigation
2. If no Bambu Cloud token is stored, a connect form appears
3. Enter your Bambu Cloud email and password and click **Connect**
4. If your account uses two-factor authentication, enter the 6-digit code from your authenticator app

> After a successful login, all your Bambu Studio filament profiles are fetched and stored locally. Click **Refresh** at any time to re-sync.

<!-- Screenshot: Filaments page connect form -->

### Linking Profiles to Spoolman Filaments

Each row in the table is a Bambu Studio filament profile (e.g. `Sunlu PLA+ Matte`). The **Status** column shows how many Spoolman filaments are linked to that profile.

| Status | Meaning |
|--------|---------|
| `5 Linked` | 5 Spoolman filaments point to this Bambu profile ID |
| `Unlinked` | No Spoolman filament linked — auto-match won't fire for this profile |

Click **Link to Spoolman** (or **Manage Links**) to open the link modal:

- Use the **Material** and **Vendor** dropdowns to filter the filament list
- Type in the search box to narrow further
- **Check all color variants** of the same material — one Bambu profile ID covers all colors of a product line, so you'd typically select every color of that filament you own
- Each row shows the filament name, material, vendor, color swatch, and Spoolman ID (`#42`)
- Click **Link N filaments** to save

<!-- Screenshot: Filaments link modal with multi-select -->

> **Why multi-select?** A single Bambu profile ID (e.g. `GFSNL02`) covers all colors of a filament line. Linking all your color variants lets the color+threshold step (Priority 2) pick the exact spool loaded.

### Sorting and Filtering the Table

Click any column header (**Name**, **Vendor**, **Material**, **Status**) to sort. Click again to reverse. The ▲▼ indicator shows the active sort direction.

The **Spoolman →** button in the header opens your Spoolman instance in a new tab for quick cross-reference.

### Bambu Color Reference

Expand the **Bambu Color Reference** panel at the bottom of the page to see the 20 fixed colors the Bambu machine display uses. Set your Spoolman filament colors to the closest matching entry — the auto-matcher tolerates up to 40 RGB units of distance. The panel remembers its open/closed state between page loads.

<!-- Screenshot: Filaments table with sort indicators and color reference panel -->

---

## Low Stock Alerts

SpoolmanSync can notify you when you're running low on a particular filament and need to reorder. Alerts are sent as Home Assistant persistent notifications.

**How it works:** An alert fires when you're down to your **last spool** of a filament group and that spool drops below your configured threshold. If you have 5 spools of black PETG and 4 are empty, no alert — you still have one good spool. Once that last spool drops below the threshold, you get notified.

Configure alerts in **Settings** → **Low Filament Alerts**:

- **Threshold type** — Percentage remaining or absolute weight (grams)
- **Grouping strategy** — How spools are grouped to determine "last spool":
  - **Material** — All PLA spools are one group, all PETG another
  - **Material + Name** — Groups by filament product (e.g., "HF Black PETG" and "HF Blue PETG" are separate)
  - **Material + Name + Vendor** — Same as above but distinguishes between vendors
- **Selective monitoring** — Optionally monitor only specific groups instead of your entire inventory

---

## Kiosk Mode

SpoolmanSync includes an optional kiosk mode for users who want a dedicated spool-scanning station — for example, a Raspberry Pi with a small touchscreen and USB NFC reader mounted next to their printer.

Navigate to `/kiosk` and click **Enable Kiosk Mode**. This sets a browser cookie that switches the spool assignment page to a touch-optimized layout with large tray buttons. Only the browser where you enable it is affected — all other devices see the normal UI. You can exit kiosk mode at any time via the link at the bottom of the screen.

---

## Troubleshooting

### "No service selected" when running docker compose

You must specify a profile:
```bash
docker compose --profile embedded up -d
# or
docker compose --profile external up -d
```

### No printers found

**Embedded mode:**
- Make sure you've added a printer via the **Add Printer** button
- Check that your Bambu Cloud credentials are correct

**External mode:**
- Ensure ha-bambulab integration is installed and configured in your Home Assistant
- Verify your Home Assistant URL is correct and you authorized SpoolmanSync
- Check the Logs page for error messages

### Webhook not working
- Verify the automations were added to Home Assistant
- Make sure you clicked **Mark as Configured** after adding the automations
- Check that the SpoolmanSync URL you entered is reachable from Home Assistant (use your machine's IP address, not `localhost`)
- Check that SpoolmanSync is accessible from Home Assistant's network

### QR scanner not working
- **HTTPS required for remote access**: Browsers block camera access on insecure HTTP connections. If you're accessing SpoolmanSync from a different device (not `localhost`), you'll need to set up HTTPS (e.g., via a reverse proxy or [Tailscale](https://tailscale.com/kb/1153/enabling-https))
- Ensure you've granted camera permissions in your browser
- Try using a different camera if available
- Use manual search as a fallback

### NFC tag writing not working
- **HTTPS required**: Web NFC requires a secure context. If you're not on `localhost`, you'll need HTTPS (e.g., via a reverse proxy or [Tailscale](https://tailscale.com/kb/1153/enabling-https))
- **Android only**: Web NFC is only supported on Android devices with Chrome, Edge, Opera, or Samsung Internet browsers
- **Not supported**: iOS (any browser), Firefox, and Brave do not support Web NFC
- If NFC is unavailable, SpoolmanSync shows a URL template you can use with a dedicated NFC writing app
- Make sure NFC is enabled in your device settings
- Use NTAG213, NTAG215, or NTAG216 NFC sticker tags

---

## License

MIT License - see [LICENSE.txt](LICENSE.txt)

## Contributing

Contributions are welcome! Please open an issue or pull request.
