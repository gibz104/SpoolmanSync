'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import {
  type FlowFormValue,
  type FlowFormValues,
  type FlowSchemaField,
  buildFlowUserInput,
  fieldPath,
  getFlowFieldPaths,
  getFlowFormDefaults,
  isBooleanField,
  isSectionField,
} from '@/lib/config-flow-form';

interface ConfigFlowResult {
  flow_id: string;
  type: 'form' | 'create_entry' | 'abort' | 'external' | 'external_done' | 'menu';
  handler: string;
  step_id: string;
  data_schema?: FlowSchemaField[];
  errors?: Record<string, string>;
  description_placeholders?: Record<string, string>;
  title?: string;
  menu_options?: string[];
  reason?: string; // Abort reason when type is 'abort'
}

type PrinterBrand = 'bambu_lab' | 'creality';

interface AddPrinterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type ConnectionMode = 'cloud' | 'lan' | null;

export function AddPrinterDialog({ open, onOpenChange, onSuccess }: AddPrinterDialogProps) {
  const [step, setStep] = useState<'brand' | 'select' | 'flow'>('brand');
  const [selectedBrand, setSelectedBrand] = useState<PrinterBrand | null>(null);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(null);
  const [flowState, setFlowState] = useState<ConfigFlowResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Form inputs for different steps
  const [formData, setFormData] = useState<FlowFormValues>({});

  // Resend verification code cooldown (60 seconds)
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup cooldown timer on unmount
  useEffect(() => {
    return () => {
      if (cooldownIntervalRef.current) {
        clearInterval(cooldownIntervalRef.current);
      }
    };
  }, []);

  // Start cooldown timer
  const startResendCooldown = () => {
    setResendCooldown(60);
    if (cooldownIntervalRef.current) {
      clearInterval(cooldownIntervalRef.current);
    }
    cooldownIntervalRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) {
          if (cooldownIntervalRef.current) {
            clearInterval(cooldownIntervalRef.current);
            cooldownIntervalRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const resetDialog = () => {
    setStep('brand');
    setSelectedBrand(null);
    setConnectionMode(null);
    setFlowState(null);
    setFormData({});
    setLoading(false);
    setResendCooldown(0);
    if (cooldownIntervalRef.current) {
      clearInterval(cooldownIntervalRef.current);
      cooldownIntervalRef.current = null;
    }
  };

  const handleClose = () => {
    // Abort any in-progress flow (but not completed ones)
    if (flowState?.flow_id && flowState.type !== 'create_entry' && flowState.type !== 'abort') {
      fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort', flowId: flowState.flow_id }),
      }).catch(() => {});
    }
    resetDialog();
    onOpenChange(false);
  };

  const handleBrandSelect = (brand: PrinterBrand) => {
    setSelectedBrand(brand);
    if (brand === 'creality') {
      // Creality is local-only (mDNS/IP), skip cloud/LAN choice
      startFlow(null, brand);
    } else {
      setStep('select');
    }
  };

  const startFlow = async (mode: ConnectionMode, brand?: PrinterBrand) => {
    const targetBrand = brand || selectedBrand || 'bambu_lab';
    const domain = targetBrand === 'creality' ? 'ha_creality_ws' : 'bambu_lab';
    setConnectionMode(mode);
    setLoading(true);

    try {
      // Start the config flow
      const res = await fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', domain }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start setup');
      }

      let result: ConfigFlowResult = await res.json();

      // If we get a menu, select the appropriate option
      if (result.type === 'menu' && result.menu_options) {
        const menuChoice = mode === 'cloud' ? 'cloud' : 'lan';
        const continueRes = await fetch('/api/printers/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'continue',
            flowId: result.flow_id,
            userInput: { next_step_id: menuChoice },
          }),
        });

        if (!continueRes.ok) {
          throw new Error('Failed to select connection mode');
        }

        result = await continueRes.json();
      }

      // If we get a form with printer_mode selector, auto-submit based on selected mode
      if (result.type === 'form' && result.data_schema) {
        const printerModeField = result.data_schema.find(f => f.name === 'printer_mode');
        if (printerModeField?.selector?.select) {
          // Auto-submit the printer mode
          const printerModeValue = mode === 'cloud' ? 'bambu' : 'lan';
          const continueRes = await fetch('/api/printers/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'continue',
              flowId: result.flow_id,
              userInput: { printer_mode: printerModeValue },
            }),
          });

          if (!continueRes.ok) {
            throw new Error('Failed to select printer mode');
          }

          result = await continueRes.json();
        }
      }

      // Handle immediate abort (e.g., no printers found right after login)
      if (result.type === 'abort') {
        const abortMessage = getAbortMessage(result.reason, mode);
        toast.error(abortMessage.title, {
          description: abortMessage.description,
          duration: 10000,
        });
        resetDialog();
        return;
      }

      setFlowState(result);
      setFormData(getFlowFormDefaults(result.data_schema));
      setStep('flow');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start printer setup');
    } finally {
      setLoading(false);
    }
  };

  const continueFlow = async () => {
    if (!flowState?.flow_id) return;

    setLoading(true);

    try {
      // Only send fields in the current form's data_schema, with sections
      // nested as objects and booleans as real booleans (see config-flow-form.ts)
      const userInput = buildFlowUserInput(flowState.data_schema, formData);

      const res = await fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'continue',
          flowId: flowState.flow_id,
          userInput,
        }),
      });

      let result: ConfigFlowResult;

      if (!res.ok) {
        // Try to get error details from response
        try {
          result = await res.json();
          if (result.errors && Object.keys(result.errors).length > 0) {
            const baseError = result.errors['base'];
            if (baseError) {
              throw new Error(translateErrorCode(baseError));
            } else {
              const errorMessages = Object.entries(result.errors)
                .map(([field, msg]) => {
                  const translatedMsg = translateErrorCode(msg);
                  return `${formatFieldName(field)}: ${translatedMsg}`;
                })
                .join('\n');
              throw new Error(errorMessages || 'Validation failed');
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Failed to continue setup') {
            throw e; // Re-throw if we successfully parsed an error
          }
        }
        throw new Error('Failed to continue setup');
      }

      result = await res.json();

      // Check for validation errors - only show on SAME step or synthetic error responses
      // Don't show errors when successfully transitioning to a new step
      const hasErrors = result.errors && Object.keys(result.errors).length > 0;
      const isSameStep = result.step_id === flowState.step_id;
      const isSyntheticError = result.step_id === 'error';

      // Special case: 'verifyCode' base error means we're transitioning to verification phase
      // This is NOT an error - it's a signal that credentials were valid and 2FA code is needed
      const isVerificationPhaseTransition = result.errors?.base === 'verifyCode';

      // Also check if the form schema changed (different fields = different phase)
      const previousFieldNames = getFlowFieldPaths(flowState.data_schema).sort().join(',');
      const currentFieldNames = getFlowFieldPaths(result.data_schema).sort().join(',');
      const formSchemaChanged = previousFieldNames !== currentFieldNames;

      const shouldShowErrors = hasErrors && (isSyntheticError || isSameStep) && !isVerificationPhaseTransition && !formSchemaChanged;

      if (shouldShowErrors) {
        // Handle "base" errors specially (general errors not tied to a field)
        const baseError = result.errors!['base'];
        if (baseError) {
          const translatedError = translateErrorCode(baseError);
          toast.error(translatedError);
        } else {
          const errorMessages = Object.entries(result.errors!)
            .map(([field, msg]) => {
              const translatedMsg = translateErrorCode(msg);
              return `${formatFieldName(field)}: ${translatedMsg}`;
            })
            .join('\n');
          toast.error(errorMessages || 'Validation failed');
        }
        // For synthetic error responses (step_id='error'), keep current form but update errors
        // For HA 200 responses with errors on same step, use the full result
        if (isSyntheticError) {
          setFlowState({ ...flowState, errors: result.errors });
        } else {
          setFlowState(result);
        }
        return;
      }

      // Handle different result types
      if (result.type === 'create_entry') {
        toast.success(`Printer "${result.title || 'Printer'}" added successfully!`);
        onSuccess();
        // Don't call handleClose() - it would try to abort the completed flow
        resetDialog();
        onOpenChange(false);
      } else if (result.type === 'abort') {
        // Show helpful error message based on abort reason
        const abortMessage = getAbortMessage(result.reason, connectionMode, selectedBrand);
        toast.error(abortMessage.title, {
          description: abortMessage.description,
          duration: 10000, // Show for longer since it contains troubleshooting info
        });
        handleClose();
      } else if (result.type === 'form') {
        // Check if this is a transition to verification code form
        // (has newCode trigger field and verifyCode input field)
        const hasNewCodeField = result.data_schema?.some(
          (f: { name: string }) => f.name.toLowerCase() === 'newcode'
        );
        const hasVerifyCodeField = result.data_schema?.some(
          (f: { name: string }) => f.name.toLowerCase() === 'verifycode'
        );
        const isVerificationForm = hasNewCodeField && hasVerifyCodeField;

        // If transitioning TO verification form, just show the form
        // The Bambu Cloud automatically sends the verification email when it returns the verifyCode error
        // We don't need to explicitly request it (doing so causes double emails)
        if (isVerificationForm && isVerificationPhaseTransition) {
          setFlowState({ ...result, errors: {} });
          setFormData({});
          startResendCooldown(); // Start 60 second cooldown for resend button
          toast.success('Verification code sent to your email');
          return;
        }

        // In cloud mode, auto-submit the printer config form if it has pre-filled values
        // This form has fields like host, access_code, local_mqtt, etc. that the cloud already filled in
        if (connectionMode === 'cloud' && result.data_schema) {
          const hasHostField = result.data_schema.some(
            (f: { name: string; default?: unknown }) => f.name === 'host' && f.default
          );
          const hasAccessCodeField = result.data_schema.some(
            (f: { name: string; default?: unknown }) => f.name === 'access_code' && f.default
          );

          // If we have pre-filled host and access_code, auto-submit with defaults
          if (hasHostField && hasAccessCodeField) {
            const autoValues = getFlowFormDefaults(result.data_schema);
            if (result.data_schema.some(f => f.name === 'skip_local_mqtt')) {
              // In cloud mode, skip local MQTT connection test (it often times out)
              autoValues.skip_local_mqtt = true;
            }
            const autoInput = buildFlowUserInput(result.data_schema, autoValues);

            const autoRes = await fetch('/api/printers/setup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'continue',
                flowId: result.flow_id,
                userInput: autoInput,
              }),
            });

            if (autoRes.ok) {
              const autoResult = await autoRes.json();

              if (autoResult.type === 'create_entry') {
                toast.success(`Printer "${autoResult.title || 'Bambu Lab'}" added successfully!`);
                onSuccess();
                // Don't call handleClose() - it would try to abort the completed flow
                resetDialog();
                onOpenChange(false);
                return;
              } else if (autoResult.type === 'form' && autoResult.step_id !== 'error') {
                // If there's another valid form, show it
                setFlowState({ ...autoResult, errors: {} });
                setFormData(getFlowFormDefaults(autoResult.data_schema));
                return;
              }
              // If step_id is 'error', fall through to show the original config form
            }
            // If auto-submit fails, fall through to show the original config form manually
          }
        }

        // If form has no fields or only optional fields with defaults, auto-continue
        const hasRequiredFields = result.data_schema?.some(
          (f: { required?: boolean; default?: unknown }) => f.required && f.default === undefined
        );
        if (result.data_schema && result.data_schema.length === 0) {
          // Auto-submit empty form
          const emptyRes = await fetch('/api/printers/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'continue',
              flowId: result.flow_id,
              userInput: {},
            }),
          });

          if (emptyRes.ok) {
            const emptyResult = await emptyRes.json();
            if (emptyResult.type === 'create_entry') {
              toast.success(`Printer "${emptyResult.title || 'Bambu Lab'}" added successfully!`);
              onSuccess();
              // Don't call handleClose() - it would try to abort the completed flow
              resetDialog();
              onOpenChange(false);
              return;
            }
          }
        }

        // Move to next form step - clear errors
        setFlowState({ ...result, errors: {} });

        // Initialize form data with defaults from new schema
        // Preserve existing values for fields that exist in new schema (for multi-phase forms)
        const newDefaults = getFlowFormDefaults(result.data_schema);
        setFormData(prev => {
          const newData: FlowFormValues = { ...newDefaults };
          // Keep values for fields that exist in new schema
          for (const path of getFlowFieldPaths(result.data_schema)) {
            const value = prev[path];
            if (typeof value === 'boolean' || (value !== undefined && value.trim() !== '')) {
              newData[path] = value;
            }
          }
          return newData;
        });
      } else if (result.type === 'menu') {
        setFlowState(result);
        setFormData({});
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to continue setup');
    } finally {
      setLoading(false);
    }
  };

  // Helper to check if a field is the "request new code" trigger field
  // This is a BOOLEAN field in HA - any value triggers requesting a new code
  const isNewCodeTriggerField = (name: string) => {
    const lower = name.toLowerCase();
    return lower === 'newcode' || lower === 'new_code';
  };

  // Helper to check if a field is the actual verification code input field
  const isVerifyCodeField = (name: string) => {
    const lower = name.toLowerCase();
    return lower === 'verifycode' || lower === 'verify_code';
  };

  const handleInputChange = (name: string, value: FlowFormValue) => {
    setFormData((prev) => {
      const updated = { ...prev, [name]: value };
      // If user is typing in the verifyCode field, make sure newCode stays empty
      // (newCode is a trigger to request a NEW code, not to verify one)
      if (isVerifyCodeField(name) && flowState?.data_schema) {
        flowState.data_schema.forEach(f => {
          if (isNewCodeTriggerField(f.name)) {
            updated[f.name] = ''; // Keep newCode empty so we don't trigger a new code request
          }
        });
      }
      return updated;
    });
  };

  // Resend verification code by setting the newCode trigger field
  const handleResendCode = async () => {
    if (!flowState?.flow_id || !flowState.data_schema) return;

    // Find the newCode trigger field name
    const newCodeField = flowState.data_schema.find(f => isNewCodeTriggerField(f.name));
    if (!newCodeField) return;

    setLoading(true);
    try {
      // Submit with ONLY the newCode field set to trigger a resend
      // Don't include verifyCode or other fields
      const res = await fetch('/api/printers/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'continue',
          flowId: flowState.flow_id,
          userInput: { [newCodeField.name]: true },
        }),
      });

      if (res.ok) {
        const result = await res.json();
        // Update flow state but keep the form showing
        if (result.type === 'form') {
          setFlowState({ ...result, errors: {} });
          setFormData({}); // Clear form data for fresh code entry
        }
        startResendCooldown(); // Restart cooldown
        toast.success('New verification code sent to your email');
      } else {
        toast.error('Failed to resend verification code');
      }
    } catch (error) {
      toast.error('Failed to resend verification code');
    } finally {
      setLoading(false);
    }
  };

  const renderFormFields = () => {
    if (!flowState?.data_schema) return null;

    // Check if this is a verification code form (has newCode trigger and verifyCode input)
    const hasNewCodeTrigger = flowState.data_schema.some(f => isNewCodeTriggerField(f.name));
    const hasVerifyCodeField = flowState.data_schema.some(f => isVerifyCodeField(f.name));
    const isVerificationForm = hasNewCodeTrigger && hasVerifyCodeField;

    const renderError = (name: string) =>
      flowState.errors?.[name] && (
        <p className="text-sm text-destructive">{translateErrorCode(flowState.errors[name])}</p>
      );

    const renderField = (field: FlowSchemaField, prefix?: string): ReactNode => {
      const path = fieldPath(field.name, prefix);

      // Hide the newCode field - it's a trigger for requesting new codes, not user input
      // We only show the verifyCode field for entering the actual code
      if (!prefix && isNewCodeTriggerField(field.name)) {
        return null;
      }

      // Sections (HA `type: 'expandable'`): a collapsible group submitted as a nested object
      if (isSectionField(field)) {
        return (
          <details key={path} open={field.expanded} className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">{formatFieldName(field.name)}</summary>
            <div className="space-y-4 pt-3">
              {field.schema!.map((child) => renderField(child, path))}
            </div>
            {renderError(field.name)}
          </details>
        );
      }

      // Boolean fields render as checkboxes and submit real booleans
      if (isBooleanField(field)) {
        return (
          <div key={path} className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={path}
                checked={formData[path] === true}
                onCheckedChange={(checked) => handleInputChange(path, checked === true)}
              />
              <Label htmlFor={path} className="font-normal">
                {formatFieldName(field.name)}
              </Label>
            </div>
            {renderError(field.name)}
          </div>
        );
      }

      // Handle select fields
      if (field.selector?.select) {
        const options = field.selector.select.options.map((opt) =>
          typeof opt === 'string' ? { value: opt, label: opt } : opt
        );
        return (
          <div key={path} className="space-y-2">
            <Label htmlFor={path}>
              {formatFieldName(field.name)}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <select
              id={path}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={String(formData[path] ?? field.default ?? '')}
              onChange={(e) => handleInputChange(path, e.target.value)}
            >
              <option value="">Select...</option>
              {options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label || formatFieldName(opt.value)}
                </option>
              ))}
            </select>
            {renderError(field.name)}
          </div>
        );
      }

      // Handle text fields
      const isCodeField = isVerificationForm && isVerifyCodeField(field.name);
      const label = isCodeField ? 'Email Verification Code' : formatFieldName(field.name);
      const placeholder = isCodeField
        ? 'Enter the code sent to your email'
        : getPlaceholder(field.name);

      return (
        <div key={path} className="space-y-2">
          <Label htmlFor={path}>
            {label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <Input
            id={path}
            type={field.name.includes('password') ? 'password' : 'text'}
            value={String(formData[path] ?? '')}
            onChange={(e) => handleInputChange(path, e.target.value)}
            placeholder={placeholder}
          />
          {renderError(field.name)}
        </div>
      );
    };

    return flowState.data_schema.map((field) => renderField(field));
  };

  const renderMenuOptions = () => {
    if (!flowState?.menu_options) return null;

    return (
      <div className="space-y-2">
        {flowState.menu_options.map((option) => (
          <Button
            key={option}
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setFormData({ next_step_id: option });
              continueFlow();
            }}
            disabled={loading}
          >
            {formatFieldName(option)}
          </Button>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === 'brand'
              ? 'Add Printer'
              : step === 'select'
                ? 'Add Bambu Lab Printer'
                : getStepTitle(flowState?.step_id, selectedBrand)}
          </DialogTitle>
          <DialogDescription>
            {step === 'brand'
              ? 'Select your printer brand'
              : step === 'select'
                ? 'Choose how to connect your printer'
                : getStepDescription(flowState?.step_id, connectionMode, selectedBrand)}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'brand' ? (
            <div className="space-y-3 px-4">
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-start gap-1"
                onClick={() => handleBrandSelect('bambu_lab')}
                disabled={loading}
              >
                <span className="font-medium">Bambu Lab</span>
                <span className="text-xs text-muted-foreground font-normal">
                  X1C, P1S, A1, H2D and other Bambu Lab printers
                </span>
              </Button>
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-start gap-1"
                onClick={() => handleBrandSelect('creality')}
                disabled={loading}
              >
                <span className="font-medium">Creality</span>
                <span className="text-xs text-muted-foreground font-normal">
                  K1, K2, Ender 3 V3 and other Creality printers
                </span>
              </Button>
            </div>
          ) : step === 'select' ? (
            <div className="space-y-3 px-4">
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-start gap-1"
                onClick={() => startFlow('cloud')}
                disabled={loading}
              >
                <span className="font-medium">Bambu Lab Cloud</span>
                <span className="text-xs text-muted-foreground font-normal">
                  Sign in with your Bambu Lab account (recommended)
                </span>
              </Button>
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-start gap-1"
                onClick={() => startFlow('lan')}
                disabled={loading}
              >
                <span className="font-medium">LAN Mode</span>
                <span className="text-xs text-muted-foreground font-normal">
                  Connect directly using IP address and access code
                </span>
              </Button>
            </div>
          ) : flowState?.type === 'menu' ? (
            renderMenuOptions()
          ) : flowState?.type === 'form' ? (
            <form
              id="printer-setup-form"
              onSubmit={(e) => {
                e.preventDefault();
                continueFlow();
              }}
              className="space-y-4"
            >
              {renderFormFields()}
              {/* Show resend button on verification code form */}
              {flowState.data_schema?.some(f => isNewCodeTriggerField(f.name)) &&
               flowState.data_schema?.some(f => isVerifyCodeField(f.name)) && (
                <div className="pt-2 border-t">
                  <p className="text-sm text-muted-foreground mb-2">
                    Didn&apos;t receive the code?
                  </p>
                  {resendCooldown > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      You can resend in {resendCooldown} seconds
                    </p>
                  ) : (
                    <Button
                      type="button"
                      variant="link"
                      className="p-0 h-auto text-sm"
                      onClick={handleResendCode}
                      disabled={loading}
                    >
                      Resend verification code
                    </Button>
                  )}
                </div>
              )}
            </form>
          ) : (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          )}
        </div>

        <DialogFooter className={step === 'brand' ? 'sm:justify-center' : ''}>
          <Button variant="outline" onClick={step === 'brand' ? handleClose : step === 'select' ? () => { setStep('brand'); setSelectedBrand(null); } : handleClose} disabled={loading}>
            {step === 'select' ? 'Back' : 'Cancel'}
          </Button>
          {step === 'flow' && flowState?.type === 'form' && (
            <Button type="submit" form="printer-setup-form" disabled={loading}>
              {loading ? 'Processing...' : 'Continue'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Helper functions
function formatFieldName(name: string): string {
  // Special case mappings for better UX
  const specialCases: Record<string, string> = {
    'NewCode': 'Verification Code',
    'VerifyCode': 'Confirm Code',
    'email': 'Email',
    'password': 'Password',
    'access_code': 'Access Code',
    'disable_ssl_verify': 'Disable SSL Verification',
  };

  if (specialCases[name]) {
    return specialCases[name];
  }

  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function translateErrorCode(errorCode: string): string {
  const translations: Record<string, string> = {
    'cannot_connect': 'Unable to connect. Please check your credentials and try again.',
    'invalid_auth': 'Invalid email or password. Please try again.',
    'invalid_credentials': 'Invalid email or password. Please try again.',
    'unknown': 'An unknown error occurred. Please try again.',
    'verifyCode': 'Verification code is required',
    'NewCode': 'Verification code is required',
    'required': 'This field is required',
    'value_error': 'Invalid value',
    // ha-bambulab local (LAN) MQTT connection test failures
    'cannot_connect_local_timeout': 'Timed out connecting to the printer. Check the host/IP address and that LAN mode is enabled on the printer.',
    'cannot_connect_local_access_denied': 'The printer rejected the access code. Check the access code shown in the printer\'s network settings.',
    'cannot_connect_local_incorrect_serial': 'The serial number does not match this printer.',
    'cannot_connect_local_incorrect_address': 'Connection refused. Check the host/IP address and that LAN mode is enabled on the printer.',
    'cannot_connect_local_address_unreachable': 'The printer address is unreachable from Home Assistant.',
    'cannot_connect_local_unknown': 'Could not connect to the printer. Check the host, serial and access code. If the printer uses a certificate Home Assistant does not trust, try enabling "Disable SSL Verification" under Advanced.',
  };

  // Check for region validation error pattern
  if (errorCode.includes("value must be one of")) {
    return 'Please select a region';
  }

  return translations[errorCode] || errorCode;
}

function getPlaceholder(fieldName: string): string {
  const placeholders: Record<string, string> = {
    email: 'your@email.com',
    username: 'your@email.com',
    password: 'Your Bambu Lab password',
    host: '192.168.1.100',
    serial: 'Printer serial number',
    access_code: '8-digit access code from printer settings',
    NewCode: 'Code from email (e.g., 123456)',
    VerifyCode: 'Re-enter verification code',
    print_cache_count: '50 (optional)',
    timelapse_cache_count: '10 (optional)',
    usage_hours: '0 (optional)',
  };
  return placeholders[fieldName] || '';
}

function getStepTitle(stepId?: string, brand?: PrinterBrand | null): string {
  if (brand === 'creality') {
    const titles: Record<string, string> = {
      user: 'Creality Printer Setup',
      confirm: 'Confirm Printer',
    };
    return titles[stepId || ''] || 'Creality Printer Setup';
  }
  const titles: Record<string, string> = {
    cloud: 'Sign in to Bambu Lab',
    lan: 'LAN Connection',
    user: 'Sign In',
    printer: 'Select Printer',
  };
  return titles[stepId || ''] || 'Printer Setup';
}

function getStepDescription(stepId?: string, mode?: ConnectionMode, brand?: PrinterBrand | null): string {
  if (brand === 'creality') {
    return 'Enter your printer\'s IP address or hostname. Make sure ha_creality_ws is installed in Home Assistant.';
  }
  if (mode === 'cloud') {
    if (stepId === 'user' || stepId === 'Bambu') {
      return 'Your credentials are securely stored in Home Assistant and never leave your local network';
    }
    if (stepId === 'tfa' || stepId === 'auth_code' || stepId === 'Tfa') {
      return 'Check your email for a verification code from Bambu Lab';
    }
    if (stepId === 'printer') {
      return 'Select which printer to add';
    }
    return 'Sign in to access your printers';
  }
  if (mode === 'lan') {
    return 'Enter your printer\'s network details and access code (found in printer settings)';
  }
  return 'Configure your printer connection';
}

function getAbortMessage(reason?: string, mode?: ConnectionMode, brand?: PrinterBrand | null): { title: string; description: string } {
  // Common abort reasons from printer integrations
  const messages: Record<string, { title: string; description: string }> = {
    // No printers found in Bambu Cloud account
    'no_printers': {
      title: 'No printers found',
      description: 'No printers were found in your Bambu Cloud account. Make sure your printer is powered on, connected to the internet, and linked to your Bambu account in Bambu Studio or Bambu Handy.',
    },
    // Already configured
    'already_configured': {
      title: 'Printer already configured',
      description: 'This printer is already set up in Home Assistant.',
    },
    // Connection issues
    'cannot_connect': {
      title: 'Cannot connect to printer',
      description: 'Unable to establish a connection. If using cloud mode, your printer may have limited MQTT connection slots (try restarting the printer). For LAN mode, verify the IP address and that the printer is on the same network.',
    },
    // Authentication failed
    'invalid_auth': {
      title: 'Authentication failed',
      description: 'Invalid credentials. Please check your email and password.',
    },
    // Reauth required
    'reauth_successful': {
      title: 'Reauthentication successful',
      description: 'Your credentials have been updated.',
    },
  };

  // Check for specific reason
  if (reason && messages[reason]) {
    return messages[reason];
  }

  // Check for "no printer" type reasons (various formats from different versions)
  if (reason && (
    reason.toLowerCase().includes('no_printer') ||
    reason.toLowerCase().includes('printer count') ||
    reason.toLowerCase().includes('no printers')
  )) {
    return messages['no_printers'];
  }

  // Default message based on connection mode
  if (mode === 'cloud') {
    return {
      title: 'Setup failed',
      description: 'Could not complete printer setup. Please verify your Bambu Cloud account credentials and that your printer is connected to the cloud. If you recently connected via MQTT Explorer or another tool, try restarting your printer to free up connection slots.',
    };
  }

  if (mode === 'lan') {
    return {
      title: 'Setup failed',
      description: 'Could not connect to the printer via LAN. Verify the IP address, access code, and that the printer is powered on and connected to your network.',
    };
  }

  return {
    title: 'Setup was aborted',
    description: reason || 'An unknown error occurred during setup.',
  };
}
