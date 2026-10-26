#!/bin/bash

# SpoolmanSync Home Assistant Entrypoint
# Initializes HA config on first run and starts Home Assistant

set -e

CONFIG_DIR="/config"
DEFAULT_CONFIG_DIR="/default_config"

echo "=== SpoolmanSync Home Assistant Starting ==="
echo "Config dir: $CONFIG_DIR"
echo "Default config dir: $DEFAULT_CONFIG_DIR"

# Debug: Show what's in default_config
echo "Contents of $DEFAULT_CONFIG_DIR:"
ls -la "$DEFAULT_CONFIG_DIR/" 2>/dev/null || echo "  (empty or not found)"

if [ -d "$DEFAULT_CONFIG_DIR/custom_components" ]; then
    echo "Contents of $DEFAULT_CONFIG_DIR/custom_components:"
    ls -la "$DEFAULT_CONFIG_DIR/custom_components/" 2>/dev/null || echo "  (empty)"
fi

# First run detection - if no configuration.yaml exists in /config
if [ ! -f "$CONFIG_DIR/configuration.yaml" ]; then
    echo "=== First run detected - initializing configuration ==="

    # Copy default config files
    echo "Copying configuration.yaml..."
    cp "$DEFAULT_CONFIG_DIR/configuration.yaml" "$CONFIG_DIR/configuration.yaml"

    echo "Copying automations.yaml..."
    cp "$DEFAULT_CONFIG_DIR/automations.yaml" "$CONFIG_DIR/automations.yaml"

    # Note: We don't pre-seed .storage files - HA will create them during onboarding
    # This is more reliable than trying to pre-seed auth files

    # Copy custom_components (HACS, ha-bambulab)
    echo "Copying custom_components..."
    mkdir -p "$CONFIG_DIR/custom_components"
    if [ -d "$DEFAULT_CONFIG_DIR/custom_components" ]; then
        cp -rv "$DEFAULT_CONFIG_DIR/custom_components/"* "$CONFIG_DIR/custom_components/" || echo "Warning: custom_components copy had issues"
    else
        echo "WARNING: No custom_components found in $DEFAULT_CONFIG_DIR"
    fi

    echo "=== Configuration initialized ==="
else
    echo "Existing configuration found, skipping initialization"
fi

# Keep bundled integrations current on every start.
# On first run they are copied above. On later runs (e.g. after pulling a newer
# SpoolmanSync image, which is rebuilt with the latest ha-bambulab), refresh the
# integrations we bundle whenever the bundled version is newer than what is
# installed. This is what lets embedded-mode users receive ha-bambulab fixes by
# just updating the image, with no manual steps. We never downgrade, and HACS is
# left alone because it manages its own updates.
# This block is best-effort and must never stop Home Assistant from starting:
# every command is guarded and the calls below are wrapped in `|| true`.
update_bundled_integration() {
    local name="$1"
    local src="$DEFAULT_CONFIG_DIR/custom_components/$name"
    local dst="$CONFIG_DIR/custom_components/$name"

    [ -d "$src" ] || return 0
    mkdir -p "$CONFIG_DIR/custom_components" 2>/dev/null || true

    if [ ! -d "$dst" ]; then
        echo "Installing bundled integration: $name"
        cp -r "$src" "$dst" 2>/dev/null || echo "Warning: failed to install $name"
        return 0
    fi

    # Only update when the bundled version is strictly newer (never downgrade).
    # Any failure (no python, bad json, etc.) falls back to "keep".
    local decision
    decision=$(python3 -c '
import json, re, sys
def ver(p):
    try:
        with open(p) as f: return json.load(f).get("version", "0")
    except Exception:
        return "0"
def parts(v): return [int(x) for x in re.findall(r"\d+", str(v))] or [0]
b, i = parts(ver(sys.argv[1])), parts(ver(sys.argv[2]))
print("update" if b > i else "keep")
' "$src/manifest.json" "$dst/manifest.json" 2>/dev/null || echo keep)

    if [ "$decision" = "update" ]; then
        echo "Updating bundled integration: $name (bundle is newer than installed)"
        # Staged outside custom_components, where Home Assistant would load a
        # leftover copy as another integration, and the installed copy is moved
        # aside rather than deleted, so a swap that fails half way can be undone
        # instead of leaving Home Assistant without the integration.
        local staging="$CONFIG_DIR/.spoolmansync-staging"
        rm -rf "$staging" "$dst.ssupdate" 2>/dev/null || true
        mkdir -p "$staging" 2>/dev/null || true
        if cp -r "$src" "$staging/$name" 2>/dev/null && mv "$dst" "$staging/$name.previous" 2>/dev/null; then
            if ! mv "$staging/$name" "$dst" 2>/dev/null; then
                echo "Warning: could not swap in updated $name, restoring the installed version"
                mv "$staging/$name.previous" "$dst" 2>/dev/null || cp -r "$src" "$dst" 2>/dev/null \
                    || echo "ERROR: $name could not be restored; restart to try again"
            fi
        else
            echo "Warning: could not stage updated $name, keeping existing version"
        fi
        rm -rf "$staging" 2>/dev/null || true
    else
        echo "Bundled integration $name is current"
    fi
    return 0
}

if [ -d "$DEFAULT_CONFIG_DIR/custom_components" ]; then
    update_bundled_integration "bambu_lab" || true
    update_bundled_integration "ha_creality_ws" || true
fi

# Verify what we have in config
echo "=== Verification ==="
echo "Contents of $CONFIG_DIR:"
ls -la "$CONFIG_DIR/" 2>/dev/null

if [ -d "$CONFIG_DIR/custom_components" ]; then
    echo "Contents of $CONFIG_DIR/custom_components:"
    ls -la "$CONFIG_DIR/custom_components/" 2>/dev/null
fi

if [ -d "$CONFIG_DIR/.storage" ]; then
    echo "Contents of $CONFIG_DIR/.storage:"
    ls -la "$CONFIG_DIR/.storage/" 2>/dev/null
fi

echo "=== Setting permissions for SpoolmanSync ==="
# Allow the SpoolmanSync app container to write to config files
# The app runs as UID 1001 (nextjs user)
chmod 666 "$CONFIG_DIR/configuration.yaml" 2>/dev/null || true
chmod 666 "$CONFIG_DIR/automations.yaml" 2>/dev/null || true
# Make config dir writable so new files can be created
chmod 777 "$CONFIG_DIR" 2>/dev/null || true

echo "=== Starting Home Assistant ==="

# Start Home Assistant with the original init script
exec /init
