'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { AddPrinterDialog } from '@/components/add-printer-dialog';
import type { AlertConfig, ActiveAlert, AvailableGroup } from '@/lib/alerts';

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

interface AdminCredentials {
  username: string;
  password: string;
}

interface Settings {
  embeddedMode: boolean;
  addonMode?: boolean;
  homeassistant: {
    url: string;
    connected: boolean;
    adminCredentials?: AdminCredentials;
    error?: string;
  } | null;
  spoolman: { url: string; connected: boolean } | null;
}

interface ConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  state: string;
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  // Form states
  const [haUrl, setHaUrl] = useState('');
  const [spoolmanUrl, setSpoolmanUrl] = useState('');
  const [saving, setSaving] = useState<'ha' | 'spoolman' | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Printer states
  const [printers, setPrinters] = useState<ConfigEntry[]>([]);
  const [hiddenPrinters, setHiddenPrinters] = useState<ConfigEntry[]>([]);
  const [addPrinterOpen, setAddPrinterOpen] = useState(false);
  const [removingPrinter, setRemovingPrinter] = useState<string | null>(null);
  const [readdingPrinter, setReaddingPrinter] = useState<string | null>(null);

  // Admin credentials state (embedded mode)
  const [showPassword, setShowPassword] = useState(false);

  // Reconnect form state (embedded mode, broken connection)
  const [reconnectUsername, setReconnectUsername] = useState('admin');
  const [reconnectPassword, setReconnectPassword] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');

  // Filter configuration states
  const [filterFields, setFilterFields] = useState<FilterField[]>([]);
  const [enabledFilters, setEnabledFilters] = useState<string[]>([]);
  const [savingFilters, setSavingFilters] = useState(false);

  // Dashboard display settings
  const [showSpoolLocation, setShowSpoolLocation] = useState(false);
  const [showPrinterFilamentReport, setShowPrinterFilamentReport] = useState(false);
  const [autoMappingEnabled, setAutoMappingEnabled] = useState(true);

  // QR base URL state
  const [qrBaseUrl, setQrBaseUrl] = useState('');
  const [savingQrUrl, setSavingQrUrl] = useState(false);

  // Alert configuration states
  const [alertConfig, setAlertConfig] = useState<AlertConfig>({
    enabled: false,
    thresholdType: 'percentage',
    thresholdValue: 10,
    groupingStrategy: 'material',
  });
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlert[]>([]);
  const [availableGroups, setAvailableGroups] = useState<AvailableGroup[]>([]);
  const [savingAlerts, setSavingAlerts] = useState(false);

  useEffect(() => {
    fetchSettings();

    // Handle OAuth callback messages
    const success = searchParams.get('success');
    const error = searchParams.get('error');

    if (success === 'ha_connected') {
      toast.success('Home Assistant connected successfully');
      window.history.replaceState({}, '', '/settings');
    } else if (error) {
      const errorMessages: Record<string, string> = {
        missing_params: 'OAuth callback missing parameters',
        invalid_state: 'Invalid OAuth state - please try again',
        token_exchange_failed: 'Failed to exchange authorization code',
        oauth_failed: 'OAuth authentication failed',
      };
      toast.error(errorMessages[error] || 'Authentication failed');
      window.history.replaceState({}, '', '/settings');
    }
  }, [searchParams]);

  // Fetch printers when HA is connected, and poll to stay in sync
  // with changes made directly in HA (e.g. printer added/removed in ha-bambulab)
  useEffect(() => {
    if (settings?.homeassistant?.connected) {
      fetchPrinters();
      const interval = setInterval(fetchPrinters, 10000);
      return () => clearInterval(interval);
    }
  }, [settings?.homeassistant?.connected]);

  // Fetch filter fields and alert config when Spoolman is connected
  useEffect(() => {
    if (settings?.spoolman) {
      fetchFilterFields();
      fetchAlertConfig();
    }
  }, [settings?.spoolman]);

  // Auto-refresh settings when in embedded mode and waiting for HA
  useEffect(() => {
    if (settings?.embeddedMode && !settings?.homeassistant && !loading) {
      const interval = setInterval(() => {
        fetchSettings();
      }, 3000); // Poll every 3 seconds
      return () => clearInterval(interval);
    }
  }, [settings?.embeddedMode, settings?.homeassistant, loading]);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);

      if (data.homeassistant) {
        setHaUrl(data.homeassistant.url);
      }
      if (data.spoolman) {
        setSpoolmanUrl(data.spoolman.url);
      }
      if (data.qrBaseUrl !== undefined) {
        setQrBaseUrl(data.qrBaseUrl);
      }
      if (data.showSpoolLocation !== undefined) {
        setShowSpoolLocation(data.showSpoolLocation);
      }
      if (data.showPrinterFilamentReport !== undefined) {
        setShowPrinterFilamentReport(data.showPrinterFilamentReport);
      }
      if (data.autoMappingEnabled !== undefined) {
        setAutoMappingEnabled(data.autoMappingEnabled);
      }
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const fetchPrinters = async () => {
    try {
      const res = await fetch('/api/printers/setup');
      if (res.ok) {
        const data = await res.json();
        setPrinters(data.entries || []);
        setHiddenPrinters(data.hiddenEntries || []);
      }
    } catch {
      // Silently fail - HA might not be connected yet
    }
  };

  const removePrinter = async (entryId: string) => {
    setRemovingPrinter(entryId);
    try {
      const res = await fetch('/api/printers/setup', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });

      if (!res.ok) {
        throw new Error('Failed to remove printer');
      }

      toast.success('Printer removed');
      fetchPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove printer');
    } finally {
      setRemovingPrinter(null);
    }
  };

  const readdPrinter = async (entryId: string) => {
    setReaddingPrinter(entryId);
    try {
      const res = await fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unhide', entryId }),
      });

      if (!res.ok) {
        throw new Error('Failed to re-add printer');
      }

      toast.success('Printer added back to SpoolmanSync');
      fetchPrinters();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to re-add printer');
    } finally {
      setReaddingPrinter(null);
    }
  };

  const connectHomeAssistant = async () => {
    if (!haUrl) {
      toast.error('Please enter your Home Assistant URL');
      return;
    }

    setConnecting(true);
    try {
      const res = await fetch(`/api/auth/ha?ha_url=${encodeURIComponent(haUrl)}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to start authentication');
      }

      window.location.href = data.authUrl;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect to Home Assistant');
      setConnecting(false);
    }
  };

  const disconnectHomeAssistant = async () => {
    setSaving('ha');
    try {
      const res = await fetch('/api/settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'homeassistant' }),
      });

      if (!res.ok) {
        throw new Error('Failed to disconnect');
      }

      toast.success('Home Assistant disconnected');
      setSettings(prev => prev ? { ...prev, homeassistant: null } : null);
      setHaUrl('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setSaving(null);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard`);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const reconnectHomeAssistant = async () => {
    if (!reconnectPassword) {
      toast.error('Please enter the Home Assistant password');
      return;
    }

    setReconnecting(true);
    setReconnectError('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'reconnect_ha',
          username: reconnectUsername,
          password: reconnectPassword,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reconnect');
      }

      toast.success('Reconnected to Home Assistant');
      setReconnectPassword('');
      setReconnectError('');
      fetchSettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reconnect';
      setReconnectError(message);
      toast.error(message);
    } finally {
      setReconnecting(false);
    }
  };

  const saveSpoolmanSettings = async () => {
    setSaving('spoolman');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'spoolman',
          url: spoolmanUrl,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }

      toast.success('Spoolman connected successfully');
      fetchSettings();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to connect to Spoolman');
    } finally {
      setSaving(null);
    }
  };

  const fetchFilterFields = async () => {
    try {
      const res = await fetch('/api/spools/extra-fields');
      if (res.ok) {
        const data = await res.json();
        setFilterFields(data.fields || []);
        setEnabledFilters(data.filterConfig || []);
      }
    } catch {
      // Silently fail - Spoolman might not be connected yet
    }
  };

  const saveFilterConfig = async (newConfig: string[]) => {
    setSavingFilters(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'filter_config',
          config: newConfig,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to save filter configuration');
      }

      setEnabledFilters(newConfig);
      toast.success('Filter settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save filter settings');
    } finally {
      setSavingFilters(false);
    }
  };

  const toggleFilter = (fieldKey: string) => {
    const newConfig = enabledFilters.includes(fieldKey)
      ? enabledFilters.filter((k) => k !== fieldKey)
      : [...enabledFilters, fieldKey];
    saveFilterConfig(newConfig);
  };

  const fetchAlertConfig = async () => {
    try {
      const res = await fetch('/api/alerts');
      if (res.ok) {
        const data = await res.json();
        if (data.config) setAlertConfig(data.config);
        if (data.alerts) setActiveAlerts(data.alerts);
        if (data.availableGroups) setAvailableGroups(data.availableGroups);
      }
    } catch {
      // Silently fail
    }
  };

  const fetchAvailableGroups = async (strategy: string) => {
    try {
      const res = await fetch(`/api/alerts?strategy=${encodeURIComponent(strategy)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.availableGroups) setAvailableGroups(data.availableGroups);
      }
    } catch {
      // Silently fail
    }
  };

  const saveAlertSettings = async () => {
    setSavingAlerts(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alertConfig),
      });

      if (!res.ok) {
        throw new Error('Failed to save alert settings');
      }

      const data = await res.json();
      if (data.alerts) setActiveAlerts(data.alerts);
      toast.success('Alert settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save alert settings');
    } finally {
      setSavingAlerts(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <h1 className="text-xl sm:text-2xl font-bold mb-6">Settings</h1>

        <div className="space-y-6">
          {/* Home Assistant Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${
                  settings?.homeassistant?.connected ? 'bg-green-500'
                    : settings?.homeassistant?.error ? 'bg-orange-500'
                    : 'bg-gray-300'
                }`} />
                <CardTitle>Home Assistant</CardTitle>
                {settings?.embeddedMode && (
                  <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                    Embedded
                  </span>
                )}
                {settings?.addonMode && (
                  <span className="text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 px-2 py-0.5 rounded">
                    Add-on
                  </span>
                )}
              </div>
              <CardDescription>
                {settings?.addonMode
                  ? 'Connected automatically via Home Assistant Supervisor.'
                  : settings?.embeddedMode
                    ? 'Home Assistant is bundled with SpoolmanSync and auto-configured.'
                    : 'Connect to your Home Assistant instance to discover Bambu Lab printers.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {settings?.addonMode ? (
                // Add-on mode - HA connection is automatic via Supervisor
                <div className="space-y-4">
                  {settings?.homeassistant ? (
                    <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div>
                        <p className="font-medium text-green-600 dark:text-green-400">Connected via Supervisor</p>
                        <p className="text-sm text-muted-foreground">
                          SpoolmanSync is running as a Home Assistant add-on with automatic API access.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                      <p className="font-medium text-yellow-700 dark:text-yellow-400">Connecting to Home Assistant...</p>
                      <p className="text-sm text-yellow-600 dark:text-yellow-500 mt-1">
                        The Supervisor connection is being established.
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    The Bambu Lab integration must be installed via HACS in your Home Assistant instance.
                    Add your printers in the Bambu Lab section below.
                  </p>
                </div>
              ) : settings?.embeddedMode ? (
                // Embedded mode - show status and admin credentials
                <div className="space-y-4">
                  {settings?.homeassistant?.connected ? (
                    // State 1: Connected
                    <>
                      <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                        <div>
                          <p className="font-medium text-green-600 dark:text-green-400">Connected</p>
                          <p className="text-sm text-muted-foreground">{settings.homeassistant.url}</p>
                        </div>
                      </div>

                      {/* Admin Credentials Section */}
                      {settings.homeassistant.adminCredentials && (
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg space-y-3">
                          <div>
                            <p className="font-medium text-blue-700 dark:text-blue-300">Home Assistant Login</p>
                            <p className="text-sm text-blue-600 dark:text-blue-400 mt-1">
                              Use these credentials to access Home Assistant directly at{' '}
                              <a
                                href="http://localhost:8123"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:no-underline"
                              >
                                localhost:8123
                              </a>
                            </p>
                          </div>

                          <div className="grid gap-2">
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                              <span className="text-sm text-muted-foreground">Username:</span>
                              <div className="flex items-center gap-2">
                                <code className="px-2 py-1 bg-background rounded text-sm truncate max-w-[150px] sm:max-w-none">
                                  {settings.homeassistant.adminCredentials.username}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 shrink-0"
                                  onClick={() => copyToClipboard(settings.homeassistant!.adminCredentials!.username, 'Username')}
                                >
                                  Copy
                                </Button>
                              </div>
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
                              <span className="text-sm text-muted-foreground">Password:</span>
                              <div className="flex items-center gap-2">
                                <code className="px-2 py-1 bg-background rounded text-sm font-mono truncate max-w-[150px] sm:max-w-none">
                                  {showPassword
                                    ? settings.homeassistant.adminCredentials.password
                                    : '••••••••••••'}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 shrink-0"
                                  onClick={() => setShowPassword(!showPassword)}
                                >
                                  {showPassword ? 'Hide' : 'Show'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 shrink-0"
                                  onClick={() => copyToClipboard(settings.homeassistant!.adminCredentials!.password, 'Password')}
                                >
                                  Copy
                                </Button>
                              </div>
                            </div>
                          </div>

                          <p className="text-xs text-muted-foreground pt-2 border-t border-blue-200 dark:border-blue-800">
                            If you change the password in Home Assistant, you can reconnect here using the new password.
                          </p>
                        </div>
                      )}
                    </>
                  ) : settings?.homeassistant?.error ? (
                    // State 3: Connection broken (token invalid, password may have changed)
                    <div className="p-4 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg space-y-3">
                      <div>
                        <p className="font-medium text-orange-700 dark:text-orange-400">Connection Lost</p>
                        <p className="text-sm text-orange-600 dark:text-orange-500 mt-1">
                          The Home Assistant connection token is no longer valid.
                          This usually happens after changing the HA password.
                          Enter your current Home Assistant credentials to reconnect.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="space-y-1">
                          <Label htmlFor="reconnect-username">Username</Label>
                          <Input
                            id="reconnect-username"
                            value={reconnectUsername}
                            onChange={(e) => setReconnectUsername(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="reconnect-password">Password</Label>
                          <Input
                            id="reconnect-password"
                            type="password"
                            value={reconnectPassword}
                            onChange={(e) => setReconnectPassword(e.target.value)}
                            placeholder="Enter your HA password"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') reconnectHomeAssistant();
                            }}
                          />
                        </div>
                        {reconnectError && (
                          <p className="text-sm text-red-600 dark:text-red-400">{reconnectError}</p>
                        )}
                        <Button
                          onClick={reconnectHomeAssistant}
                          disabled={reconnecting || !reconnectPassword}
                        >
                          {reconnecting ? 'Reconnecting...' : 'Reconnect'}
                        </Button>
                      </div>
                    </div>
                  ) : !settings?.homeassistant ? (
                    // State 2: HA still starting up (no connection yet)
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
                      <p className="font-medium text-yellow-700 dark:text-yellow-400">Connecting to Home Assistant...</p>
                      <p className="text-sm text-yellow-600 dark:text-yellow-500 mt-1">
                        Home Assistant is starting up and being configured automatically.
                        This may take up to a minute on first run.
                      </p>
                      <div className="flex items-center gap-2 mt-3">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-600" />
                        <Button variant="outline" size="sm" onClick={fetchSettings}>
                          Refresh Status
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    The embedded Home Assistant is pre-configured with HACS and the Bambu Lab integration.
                    Add your printers in the Bambu Lab section below.
                  </p>
                </div>
              ) : settings?.homeassistant ? (
                // External mode - connected
                <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <div>
                    <p className="font-medium">Connected</p>
                    <p className="text-sm text-muted-foreground">{settings.homeassistant.url}</p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={disconnectHomeAssistant}
                    disabled={saving === 'ha'}
                  >
                    {saving === 'ha' ? 'Disconnecting...' : 'Disconnect'}
                  </Button>
                </div>
              ) : (
                // External mode - not connected
                <>
                  <div className="space-y-2">
                    <Label htmlFor="ha-url">Home Assistant URL</Label>
                    <Input
                      id="ha-url"
                      placeholder="http://homeassistant.local:8123"
                      value={haUrl}
                      onChange={(e) => setHaUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter your Home Assistant URL, then click Connect to authorize.
                    </p>
                  </div>
                  <Button
                    onClick={connectHomeAssistant}
                    disabled={connecting || !haUrl}
                  >
                    {connecting ? 'Redirecting...' : 'Connect with Home Assistant'}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <Separator />

          {/* Bambu Lab Printers */}
          {settings?.homeassistant?.connected && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Bambu Lab Printers</CardTitle>
                    <CardDescription>
                      Configure your Bambu Lab printers to sync with Spoolman.
                    </CardDescription>
                  </div>
                  <Button onClick={() => setAddPrinterOpen(true)}>
                    Add Printer
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {printers.length === 0 && hiddenPrinters.length === 0 && (
                    <div className="text-center py-6 text-muted-foreground">
                      <p>No printers configured yet.</p>
                      <p className="text-sm mt-1">Click &quot;Add Printer&quot; to connect your Bambu Lab printer.</p>
                    </div>
                  )}
                  {printers.map((printer) => (
                    <div
                      key={printer.entry_id}
                      className="flex items-center justify-between p-3 bg-muted rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{printer.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {printer.state === 'loaded' ? (
                            <span className="text-green-600 dark:text-green-400">Connected</span>
                          ) : (
                            <span className="text-yellow-600 dark:text-yellow-400">{printer.state}</span>
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removePrinter(printer.entry_id)}
                        disabled={removingPrinter === printer.entry_id}
                      >
                        {removingPrinter === printer.entry_id ? 'Removing...' : 'Remove'}
                      </Button>
                    </div>
                  ))}
                  {hiddenPrinters.length > 0 && (
                    <div className={printers.length > 0 ? 'pt-2 border-t' : ''}>
                      <p className="text-xs text-muted-foreground mb-2">
                        Removed from SpoolmanSync (still in Home Assistant):
                      </p>
                      {hiddenPrinters.map((printer) => (
                        <div
                          key={printer.entry_id}
                          className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-dashed"
                        >
                          <div>
                            <p className="font-medium text-muted-foreground">{printer.title}</p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => readdPrinter(printer.entry_id)}
                            disabled={readdingPrinter === printer.entry_id}
                          >
                            {readdingPrinter === printer.entry_id ? 'Adding...' : 'Re-add'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {settings?.homeassistant?.connected && <Separator />}

          {/* Spoolman Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${settings?.spoolman ? 'bg-green-500' : 'bg-gray-300'}`} />
                <CardTitle>Spoolman</CardTitle>
              </div>
              <CardDescription>
                Connect to your Spoolman instance to manage filament spools.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="spoolman-url">Spoolman URL</Label>
                <Input
                  id="spoolman-url"
                  placeholder="http://localhost:7912"
                  value={spoolmanUrl}
                  onChange={(e) => setSpoolmanUrl(e.target.value)}
                />
              </div>
              <Button
                onClick={saveSpoolmanSettings}
                disabled={saving === 'spoolman' || !spoolmanUrl}
              >
                {saving === 'spoolman' ? 'Connecting...' : settings?.spoolman ? 'Update Connection' : 'Connect'}
              </Button>
            </CardContent>
          </Card>

          {/* Dashboard Display Settings */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <CardTitle>Dashboard Display</CardTitle>
                  <CardDescription>
                    Configure what information is shown on the dashboard spool cards.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="show-spool-location"
                      checked={showSpoolLocation}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setShowSpoolLocation(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'show_spool_location', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'Spool location enabled on dashboard' : 'Spool location hidden on dashboard');
                        } catch {
                          setShowSpoolLocation(!enabled);
                          toast.error('Failed to save setting');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="show-spool-location" className="text-sm font-medium cursor-pointer">
                        Show spool location
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Display the Spoolman location field on each spool card (e.g., shelf, dry box, bin number)
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-3 mt-4">
                    <Checkbox
                      id="show-printer-filament-report"
                      checked={showPrinterFilamentReport}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setShowPrinterFilamentReport(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'show_printer_filament_report', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(
                            enabled
                              ? 'Printer-reported filament shown on dashboard'
                              : 'Printer-reported filament hidden on dashboard',
                          );
                        } catch {
                          setShowPrinterFilamentReport(!enabled);
                          toast.error('Failed to save setting');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="show-printer-filament-report" className="text-sm font-medium cursor-pointer">
                        Show printer-reported name, type, and color
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        On each tray card, show the filament name, material type, and color as reported by the printer (from Home Assistant), alongside Spoolman data
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-3 mt-4">
                    <Checkbox
                      id="auto-mapping"
                      checked={autoMappingEnabled}
                      onCheckedChange={async (checked) => {
                        const enabled = checked === true;
                        setAutoMappingEnabled(enabled);
                        try {
                          const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'auto_mapping', enabled }),
                          });
                          if (!res.ok) throw new Error();
                          toast.success(enabled ? 'Auto filament mapping enabled' : 'Auto filament mapping disabled');
                        } catch {
                          setAutoMappingEnabled(!enabled);
                          toast.error('Failed to save setting');
                        }
                      }}
                    />
                    <div>
                      <Label htmlFor="auto-mapping" className="text-sm font-medium cursor-pointer">
                        Auto-create filament mappings
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        When you manually assign a spool to a tray that has no RFID tag, automatically remember this name/material/color combination for future auto-assignment
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {/* Spool Filter Configuration */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <CardTitle>Spool Filter Configuration</CardTitle>
                  <CardDescription>
                    Choose which fields appear as filter dropdowns when assigning spools to trays.
                    The search box always searches all fields regardless of this setting.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {filterFields.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Loading filter options...
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {/* Built-in fields */}
                      <div>
                        <h4 className="text-sm font-medium mb-2 text-muted-foreground">Built-in Fields</h4>
                        <div className="space-y-3">
                          {filterFields.filter(f => f.builtIn).map((field) => (
                            <div key={field.key} className="flex items-center space-x-3">
                              <Checkbox
                                id={`filter-${field.key}`}
                                checked={enabledFilters.includes(field.key)}
                                onCheckedChange={() => toggleFilter(field.key)}
                                disabled={savingFilters}
                              />
                              <div className="flex-1">
                                <Label
                                  htmlFor={`filter-${field.key}`}
                                  className="text-sm font-medium cursor-pointer"
                                >
                                  {field.name}
                                </Label>
                                {field.values.length > 0 ? (
                                  <p className="text-xs text-muted-foreground">
                                    {field.values.length} value{field.values.length !== 1 ? 's' : ''}: {field.values.slice(0, 3).join(', ')}{field.values.length > 3 ? '...' : ''}
                                  </p>
                                ) : (
                                  <p className="text-xs text-muted-foreground italic">
                                    No values set on any spools
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Extra fields (if any) */}
                      {filterFields.some(f => !f.builtIn) && (
                        <div>
                          <h4 className="text-sm font-medium mb-2 text-muted-foreground">Custom Extra Fields</h4>
                          <div className="space-y-3">
                            {filterFields.filter(f => !f.builtIn).map((field) => (
                              <div key={field.key} className="flex items-center space-x-3">
                                <Checkbox
                                  id={`filter-${field.key}`}
                                  checked={enabledFilters.includes(field.key)}
                                  onCheckedChange={() => toggleFilter(field.key)}
                                  disabled={savingFilters}
                                />
                                <div className="flex-1">
                                  <Label
                                    htmlFor={`filter-${field.key}`}
                                    className="text-sm font-medium cursor-pointer"
                                  >
                                    {field.name}
                                  </Label>
                                  {field.values.length > 0 ? (
                                    <p className="text-xs text-muted-foreground">
                                      {field.values.length} value{field.values.length !== 1 ? 's' : ''}: {field.values.slice(0, 3).join(', ')}{field.values.length > 3 ? '...' : ''}
                                    </p>
                                  ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                      No values set on any spools
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {enabledFilters.length === 0 && (
                        <p className="text-xs text-muted-foreground mt-2">
                          No filters enabled. Only the search box will be shown.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* Low Filament Alerts */}
          {settings?.spoolman && (
            <>
              <Separator />
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle>Low Filament Alerts</CardTitle>
                    {activeAlerts.length > 0 && (
                      <Badge variant="destructive">{activeAlerts.length}</Badge>
                    )}
                  </div>
                  <CardDescription>
                    Get notified when you&apos;re down to your last spool of a filament type and it&apos;s running low.
                    Alerts are checked after each print and sent as Home Assistant persistent notifications.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center space-x-3">
                    <Checkbox
                      id="alerts-enabled"
                      checked={alertConfig.enabled}
                      onCheckedChange={(checked) =>
                        setAlertConfig(prev => ({ ...prev, enabled: Boolean(checked) }))
                      }
                    />
                    <Label htmlFor="alerts-enabled" className="cursor-pointer">
                      Enable low filament alerts
                    </Label>
                  </div>

                  {alertConfig.enabled && (
                    <div className="space-y-4 pl-6">
                      {/* Threshold type */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Threshold type</Label>
                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="threshold-percentage"
                              name="thresholdType"
                              value="percentage"
                              checked={alertConfig.thresholdType === 'percentage'}
                              onChange={() => setAlertConfig(prev => ({ ...prev, thresholdType: 'percentage' }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="threshold-percentage" className="cursor-pointer text-sm">
                              Percentage remaining
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="threshold-grams"
                              name="thresholdType"
                              value="grams"
                              checked={alertConfig.thresholdType === 'grams'}
                              onChange={() => setAlertConfig(prev => ({ ...prev, thresholdType: 'grams' }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="threshold-grams" className="cursor-pointer text-sm">
                              Absolute weight (grams)
                            </Label>
                          </div>
                        </div>
                      </div>

                      {/* Threshold value */}
                      <div className="space-y-2">
                        <Label htmlFor="threshold-value" className="text-sm font-medium">
                          Alert when below {alertConfig.thresholdType === 'percentage' ? '(%)' : '(grams)'}
                        </Label>
                        <Input
                          id="threshold-value"
                          type="number"
                          min="0"
                          max={alertConfig.thresholdType === 'percentage' ? 100 : undefined}
                          value={alertConfig.thresholdValue}
                          onChange={(e) =>
                            setAlertConfig(prev => ({ ...prev, thresholdValue: Number(e.target.value) }))
                          }
                          className="w-32"
                        />
                      </div>

                      {/* Grouping strategy */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Group spools by</Label>
                        <div className="space-y-2">
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material"
                              name="groupingStrategy"
                              value="material"
                              checked={alertConfig.groupingStrategy === 'material'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material', monitoredGroups: undefined }));
                                fetchAvailableGroups('material');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material" className="cursor-pointer text-sm">
                                Material
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Alert when all PLA spools are low, all PETG spools are low, etc.
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material-color"
                              name="groupingStrategy"
                              value="material_name"
                              checked={alertConfig.groupingStrategy === 'material_name'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material_name', monitoredGroups: undefined }));
                                fetchAvailableGroups('material_name');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material-color" className="cursor-pointer text-sm">
                                Material + Name
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Alert per filament product (e.g. all HF Black PETG spools, all Matte White PLA spools).
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id="group-material-vendor-name"
                              name="groupingStrategy"
                              value="material_name_vendor"
                              checked={alertConfig.groupingStrategy === 'material_name_vendor'}
                              onChange={() => {
                                setAlertConfig(prev => ({ ...prev, groupingStrategy: 'material_name_vendor', monitoredGroups: undefined }));
                                fetchAvailableGroups('material_name_vendor');
                              }}
                              className="h-4 w-4 mt-0.5"
                            />
                            <div>
                              <Label htmlFor="group-material-vendor-name" className="cursor-pointer text-sm">
                                Material + Name + Vendor
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Like Material + Name, but distinguishes between vendors (e.g. Bambu Lab HF Black PETG vs Polymaker PolyLite Black PETG).
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Monitored groups */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Monitor</Label>
                        <div className="space-y-2">
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="monitor-all"
                              name="monitorMode"
                              checked={alertConfig.monitoredGroups === undefined}
                              onChange={() => setAlertConfig(prev => ({ ...prev, monitoredGroups: undefined }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="monitor-all" className="cursor-pointer text-sm">
                              All groups
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <input
                              type="radio"
                              id="monitor-selected"
                              name="monitorMode"
                              checked={alertConfig.monitoredGroups !== undefined}
                              onChange={() => setAlertConfig(prev => ({ ...prev, monitoredGroups: [] }))}
                              className="h-4 w-4"
                            />
                            <Label htmlFor="monitor-selected" className="cursor-pointer text-sm">
                              Selected groups only
                            </Label>
                          </div>
                        </div>

                        {alertConfig.monitoredGroups !== undefined && (
                          <div className="ml-6 space-y-2 pt-1">
                            {availableGroups.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic">No spool groups found.</p>
                            ) : (
                              availableGroups.map((group) => (
                                <div key={group.groupKey} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={`group-${group.groupKey}`}
                                    checked={alertConfig.monitoredGroups?.includes(group.groupKey) ?? false}
                                    onCheckedChange={(checked) => {
                                      setAlertConfig(prev => {
                                        const current = prev.monitoredGroups || [];
                                        const updated = checked
                                          ? [...current, group.groupKey]
                                          : current.filter(k => k !== group.groupKey);
                                        return { ...prev, monitoredGroups: updated };
                                      });
                                    }}
                                  />
                                  <div className="flex items-center gap-2">
                                    {(alertConfig.groupingStrategy === 'material_name' || alertConfig.groupingStrategy === 'material_name_vendor') && group.color_hex && (
                                      <span
                                        className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
                                        style={{ backgroundColor: `#${group.color_hex.replace('#', '')}` }}
                                      />
                                    )}
                                    <Label
                                      htmlFor={`group-${group.groupKey}`}
                                      className="cursor-pointer text-sm"
                                    >
                                      {group.groupLabel}
                                    </Label>
                                    <span className="text-xs text-muted-foreground">
                                      ({group.spoolCount} spool{group.spoolCount !== 1 ? 's' : ''})
                                    </span>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      <Button
                        onClick={saveAlertSettings}
                        disabled={savingAlerts}
                      >
                        {savingAlerts ? 'Saving...' : 'Save Alert Settings'}
                      </Button>
                    </div>
                  )}

                  {!alertConfig.enabled && (
                    <Button
                      onClick={saveAlertSettings}
                      disabled={savingAlerts}
                      variant="outline"
                      size="sm"
                    >
                      {savingAlerts ? 'Saving...' : 'Save'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* QR Code Base URL */}
          <Card>
            <CardHeader>
              <CardTitle>QR Code / NFC URL</CardTitle>
              <CardDescription>
                Override the base URL used in generated QR code labels and NFC tags.
                Leave empty to use the current browser URL automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="qrBaseUrl">Base URL</Label>
                <div className="flex gap-2">
                  <Input
                    id="qrBaseUrl"
                    value={qrBaseUrl}
                    onChange={(e) => setQrBaseUrl(e.target.value)}
                    placeholder="e.g., http://192.168.1.100:3000"
                  />
                  <Button
                    onClick={async () => {
                      setSavingQrUrl(true);
                      try {
                        const res = await fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ type: 'qr_base_url', url: qrBaseUrl }),
                        });
                        if (!res.ok) throw new Error();
                        toast.success(qrBaseUrl.trim() ? 'QR base URL saved' : 'QR base URL cleared');
                      } catch {
                        toast.error('Failed to save QR base URL');
                      } finally {
                        setSavingQrUrl(false);
                      }
                    }}
                    disabled={savingQrUrl}
                  >
                    {savingQrUrl ? 'Saving...' : 'Save'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Useful when accessing SpoolmanSync through a reverse proxy or custom domain.
                  QR codes will link to this URL instead of the browser address bar URL.
                </p>
              </div>
            </CardContent>
          </Card>

        </div>

        {/* Add Printer Dialog */}
        <AddPrinterDialog
          open={addPrinterOpen}
          onOpenChange={setAddPrinterOpen}
          onSuccess={fetchPrinters}
        />
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-2xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        </main>
      </div>
    }>
      <SettingsContent />
    </Suspense>
  );
}
