'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '@/components/nav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

interface PrinterRegistration {
  prefix: string;
  name: string;
  trayIds: string[];
}

interface MissingEntityReport {
  prefix: string;
  name: string;
  missing: string[];
  breaksUsageTracking: boolean;
}

interface AutomationData {
  trayCount: number;
  printerCount: number;
  automationsYaml: string;
  configurationYaml: string;
  printerRegistrations: PrinterRegistration[];
  missingEntities?: MissingEntityReport[];
}

interface RegisteredAutomation {
  id: string;
  haAutomationId: string;
  trayId: string;
  printerId: string;
  createdAt: string;
}

/**
 * Printer-level entities discovery couldn't find.
 *
 * A missing `print_weight` silently disables all weight deduction for that
 * printer, so this has to be visible in EVERY deployment mode — add-on mode is
 * the primary install path and never sees the generated YAML.
 */
function MissingEntitiesAlert({ reports }: { reports: MissingEntityReport[] }) {
  if (reports.length === 0) return null;

  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p className="font-medium">Some Home Assistant entities could not be found.</p>
        <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
          {reports.map((report) => (
            <li key={report.prefix}>
              <strong>{report.name || report.prefix}</strong>: missing{' '}
              <code>{report.missing.join(', ')}</code>
              {report.breaksUsageTracking && (
                <span className="block ml-5">
                  Filament usage will <strong>not</strong> be deducted for this printer.
                  Spool assignment and tray-change detection still work.
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm">
          This usually means your printer or integration version doesn&apos;t expose these
          sensors. Please{' '}
          <a
            href="https://github.com/gibz104/SpoolmanSync/issues"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            open an issue
          </a>{' '}
          with your printer model so support can be added.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export default function AutomationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [automationData, setAutomationData] = useState<AutomationData | null>(null);
  const [registeredAutomations, setRegisteredAutomations] = useState<RegisteredAutomation[]>([]);
  const [haConnected, setHaConnected] = useState(false);
  const [embeddedMode, setEmbeddedMode] = useState(false);
  const [addonMode, setAddonMode] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedAutomations, setCopiedAutomations] = useState(false);
  const [printerCount, setPrinterCount] = useState<number | null>(null);
  const [checkingPrinters, setCheckingPrinters] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Printer-level entities discovery couldn't find. Surfaced because a missing
  // print_weight silently disables all weight deduction for that printer.
  const [missingEntities, setMissingEntities] = useState<MissingEntityReport[]>([]);

  useEffect(() => {
    fetchRegistered();
    // Initialize webhook URL with a sensible default
    // Replace 0.0.0.0 with localhost as a starting point
    const origin = window.location.origin.replace('0.0.0.0', 'localhost');
    setWebhookUrl(origin);
  }, []);

  // Check for printers when HA is connected in embedded or addon mode
  useEffect(() => {
    if ((embeddedMode || addonMode) && haConnected && printerCount === null) {
      checkForPrinters();
    }
  }, [embeddedMode, addonMode, haConnected, printerCount]);

  const checkForPrinters = async () => {
    setCheckingPrinters(true);
    try {
      const res = await fetch('/api/printers');
      const data = await res.json();
      setPrinterCount(data.printers?.length || 0);
    } catch (err) {
      console.error('Failed to check printers:', err);
      setPrinterCount(0);
    } finally {
      setCheckingPrinters(false);
    }
  };

  const fetchRegistered = async () => {
    try {
      const res = await fetch('/api/automations');
      const data = await res.json();
      setRegisteredAutomations(data.automations || []);
      setHaConnected(data.haConnected);
      setEmbeddedMode(data.embeddedMode || false);
      setAddonMode(data.addonMode || false);
      setConfigured(data.configured || false);
    } catch (err) {
      console.error('Failed to fetch automations:', err);
    }
  };

  // Auto-configure for embedded mode
  const autoConfigure = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'auto-configure',
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to configure automations');
      }

      setConfigured(true);
      setMissingEntities(data.missingEntities || []);
      fetchRegistered();

      if (data.needsRestart) {
        setShowRestartModal(true);
      } else {
        toast.success(data.message || `Configured ${data.trayCount} trays successfully`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to configure');
    } finally {
      setLoading(false);
    }
  };

  const restartHA = async () => {
    setRestarting(true);
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart-ha' }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to restart Home Assistant');
      }

      setShowRestartModal(false);
      toast.success('Home Assistant is restarting. This may take a minute.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restart');
    } finally {
      setRestarting(false);
    }
  };

  // Generate config for manual mode
  const generateConfig = async () => {
    if (!webhookUrl.trim()) {
      toast.error('Please enter the SpoolmanSync URL');
      return;
    }
    setLoading(true);
    try {
      // Append /api/webhook to the base URL
      const baseUrl = webhookUrl.trim().replace(/\/+$/, ''); // Remove trailing slashes
      const fullWebhookUrl = `${baseUrl}/api/webhook`;

      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'discover',
          webhookUrl: fullWebhookUrl,
        }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to generate config');
      }

      const data = await res.json();
      setAutomationData(data);
      setMissingEntities(data.missingEntities || []);
      toast.success(`Found ${data.trayCount} trays to monitor`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate config');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string, type: 'config' | 'automations') => {
    try {
      // Try using the Clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (like HTTP)
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }

      if (type === 'config') {
        setCopiedConfig(true);
        setTimeout(() => setCopiedConfig(false), 2000);
      } else {
        setCopiedAutomations(true);
        setTimeout(() => setCopiedAutomations(false), 2000);
      }
      toast.success(`${type === 'config' ? 'Configuration' : 'Automations'} copied to clipboard`);
    } catch (err) {
      toast.error('Failed to copy to clipboard');
    }
  };

  const registerAutomations = async () => {
    if (!automationData) return;

    setLoading(true);
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          printerRegistrations: automationData.printerRegistrations,
        }),
      });

      if (!res.ok) throw new Error('Failed to register automations');

      toast.success('Automations marked as configured');
      fetchRegistered();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to register');
    } finally {
      setLoading(false);
    }
  };

  // Embedded/Addon mode UI - simplified auto-configure
  if (embeddedMode || addonMode) {
    return (
      <div className="min-h-screen bg-background">
        <Nav />
        <main className="w-full max-w-4xl mx-auto py-6 px-3 sm:px-4 md:px-6">
          <h1 className="text-xl sm:text-2xl font-bold mb-6">Automations</h1>

          <div className="space-y-6">
            <MissingEntitiesAlert reports={missingEntities} />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Spool Tracking Automations
                  <Badge variant="secondary">{addonMode ? 'Add-on Mode' : 'Embedded Mode'}</Badge>
                </CardTitle>
                <CardDescription>
                  SpoolmanSync automatically tracks filament usage and syncs with Spoolman when prints complete or trays change.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <div className={`h-3 w-3 rounded-full ${haConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span>Home Assistant: {haConnected ? 'Connected' : 'Waiting for connection...'}</span>
                </div>

                {configured ? (
                  <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg border border-green-200 dark:border-green-800">
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="font-medium">Automations Configured</span>
                    </div>
                    <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                      SpoolmanSync is actively tracking your printer trays. When you change filaments or finish a print,
                      the usage will be automatically synced with Spoolman.
                    </p>
                  </div>
                ) : printerCount === 0 ? (
                  <div className="p-4 bg-amber-50 dark:bg-amber-950 rounded-lg border border-amber-200 dark:border-amber-800">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 mb-2">
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="font-medium">No Printer Found</span>
                    </div>
                    <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">
                      You need to add a Bambu Lab printer before configuring automations.
                      Go to the Settings page and click &quot;Add Printer&quot; to connect your printer via Bambu Cloud or LAN mode.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => router.push('/settings')}
                    >
                      Go to Settings
                    </Button>
                  </div>
                ) : checkingPrinters ? (
                  <div className="p-4 bg-muted rounded-lg flex items-center gap-3">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
                    <span className="text-sm text-muted-foreground">Checking for printers...</span>
                  </div>
                ) : (
                  <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg border border-blue-200 dark:border-blue-800">
                    <p className="text-sm text-blue-700 dark:text-blue-300 mb-3">
                      Click the button below to automatically configure Home Assistant to track your printer&apos;s filament usage.
                      This will:
                    </p>
                    <ul className="list-disc list-inside text-sm text-blue-600 dark:text-blue-400 space-y-1 mb-4">
                      <li>Create automations to detect tray changes</li>
                      <li>Track filament usage during prints</li>
                      <li>Sync usage data with Spoolman when prints complete</li>
                    </ul>
                    <Button
                      onClick={autoConfigure}
                      disabled={loading || !haConnected || printerCount === 0}
                      size="lg"
                    >
                      {loading ? 'Configuring...' : 'Configure Automations'}
                    </Button>
                  </div>
                )}

                {configured && (
                  <div className="pt-4 border-t">
                    <Button
                      variant="outline"
                      onClick={autoConfigure}
                      disabled={loading}
                    >
                      {loading ? 'Reconfiguring...' : 'Reconfigure Automations'}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-2">
                      Use this if you&apos;ve added new printers or need to update the configuration.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Registered Automations */}
            {registeredAutomations.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Configured Tracking</CardTitle>
                  <CardDescription>
                    These printers and trays are being monitored
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {registeredAutomations.map((auto) => (
                      <div
                        key={auto.id}
                        className="flex items-center justify-between p-3 bg-muted rounded"
                      >
                        <div>
                          <div className="font-medium">{auto.printerId}</div>
                          <div className="text-sm text-muted-foreground">
                            {auto.trayId.split(',').length} tray(s) monitored
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(auto.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Restart Required Modal */}
          <Dialog open={showRestartModal} onOpenChange={setShowRestartModal}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Home Assistant Restart Required</DialogTitle>
                <DialogDescription>
                  The automation configuration has been written successfully. Home Assistant needs to restart to load the new configuration (helper entities, templates, and automations).
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <Button
                  onClick={restartHA}
                  disabled={restarting}
                  className="flex-1"
                >
                  {restarting ? 'Restarting...' : 'Restart Now'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowRestartModal(false)}
                  disabled={restarting}
                  className="flex-1"
                >
                  Restart Later
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                If you choose to restart later, you can restart Home Assistant from its own Settings page when convenient.
              </p>
            </DialogContent>
          </Dialog>
        </main>
      </div>
    );
  }

  // External/Manual mode UI - shows YAML config
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="w-full max-w-4xl mx-auto py-6 px-3 sm:px-4 md:px-6">
        <h1 className="text-xl sm:text-2xl font-bold mb-6">Automations Setup</h1>

        <div className="space-y-6">
          {/* Status Card */}
          <Card>
            <CardHeader>
              <CardTitle>Home Assistant Automations</CardTitle>
              <CardDescription>
                Configure Home Assistant to automatically sync tray changes with Spoolman
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className={`h-3 w-3 rounded-full ${haConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span>Home Assistant: {haConnected ? 'Connected' : 'Not configured'}</span>
              </div>

              {registeredAutomations.length > 0 && (
                <div className="flex items-center gap-4">
                  <Badge variant="secondary">{registeredAutomations.length} automations registered</Badge>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="webhookUrl" className="text-sm font-medium">
                  SpoolmanSync URL
                </label>
                <input
                  id="webhookUrl"
                  type="text"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="http://192.168.1.100:3000"
                  className="w-full px-3 py-2 border rounded-md bg-background text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  The URL where Home Assistant can reach this SpoolmanSync instance.
                  {webhookUrl.includes('localhost') && (
                    <span className="text-amber-600 dark:text-amber-400 block mt-1">
                      Note: &quot;localhost&quot; only works if Home Assistant is on the same machine.
                      Use your machine&apos;s IP address (e.g., 192.168.x.x) if HA is elsewhere.
                    </span>
                  )}
                </p>
              </div>

              <Button onClick={generateConfig} disabled={loading || !haConnected || !webhookUrl.trim()}>
                {loading ? 'Generating...' : 'Generate Configuration'}
              </Button>
            </CardContent>
          </Card>

          <MissingEntitiesAlert reports={missingEntities} />

          {/* Generated Config */}
          {automationData && (
            <>
              {/* Configuration.yaml Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>configuration.yaml</span>
                    <Badge>{automationData.printerCount} printer(s)</Badge>
                  </CardTitle>
                  <CardDescription>
                    Add this to your Home Assistant <code>configuration.yaml</code> file
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative">
                    <pre className="p-4 bg-muted rounded-lg overflow-x-auto text-xs max-h-96">
                      {automationData.configurationYaml}
                    </pre>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="absolute top-2 right-2"
                      onClick={() => copyToClipboard(automationData.configurationYaml, 'config')}
                    >
                      {copiedConfig ? 'Copied!' : 'Copy'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Automations.yaml Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>automations.yaml</span>
                    <Badge>{automationData.trayCount} trays</Badge>
                  </CardTitle>
                  <CardDescription>
                    Add this to your Home Assistant <code>automations.yaml</code> file
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative">
                    <pre className="p-4 bg-muted rounded-lg overflow-x-auto text-xs max-h-96">
                      {automationData.automationsYaml}
                    </pre>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="absolute top-2 right-2"
                      onClick={() => copyToClipboard(automationData.automationsYaml, 'automations')}
                    >
                      {copiedAutomations ? 'Copied!' : 'Copy'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Setup Instructions */}
              <Card>
                <CardHeader>
                  <CardTitle>Setup Instructions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ol className="list-decimal list-inside space-y-2 text-sm">
                    <li>Copy the <strong>configuration.yaml</strong> content above and add it to your Home Assistant <code>configuration.yaml</code> file</li>
                    <li>Copy the <strong>automations.yaml</strong> content above and add it to your Home Assistant <code>automations.yaml</code> file</li>
                    <li>
                      <strong>Fully restart Home Assistant</strong> (Developer Tools → YAML → Restart Home Assistant,
                      or Settings → System → Restart)
                    </li>
                    <li>Click &quot;Mark as Configured&quot; below</li>
                  </ol>

                  <Alert>
                    <AlertDescription>
                      A full restart is required — <strong>reloading automations is not enough</strong>. The
                      <code className="mx-1">input_number</code>, <code className="mx-1">utility_meter</code>,
                      <code className="mx-1">template</code> and <code className="mx-1">rest_command</code> entries
                      above are only created on restart. Without it the automations load but no filament weight is
                      ever deducted.
                    </AlertDescription>
                  </Alert>

                  <Button onClick={registerAutomations} disabled={loading}>
                    Mark as Configured
                  </Button>
                </CardContent>
              </Card>
            </>
          )}

          {/* Registered Automations */}
          {registeredAutomations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Registered Automations</CardTitle>
                <CardDescription>
                  These printers and trays are being monitored
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {registeredAutomations.map((auto) => (
                    <div
                      key={auto.id}
                      className="flex items-center justify-between p-3 bg-muted rounded"
                    >
                      <div>
                        <div className="font-medium">{auto.printerId}</div>
                        <div className="text-sm text-muted-foreground">
                          {auto.trayId.split(',').length} tray(s) monitored
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(auto.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
