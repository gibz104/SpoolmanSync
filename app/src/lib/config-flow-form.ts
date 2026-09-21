/**
 * Helpers for rendering and submitting Home Assistant config flow forms.
 *
 * HA serializes a flow step's `data_schema` as a flat field list. Two shapes
 * matter beyond plain text inputs:
 *
 * - Selectors (`{ selector: { boolean: {} } }`, `{ selector: { text: {...} } }`, ...)
 * - Sections (`{ type: 'expandable', schema: [...] }`), a collapsible group whose
 *   values must be submitted as a nested object under the section's name. HA
 *   rejects the step with "required key not provided" if the object is missing
 *   (issue #82: ha-bambulab's LAN step wraps `disable_ssl_verify` and
 *   `enable_firmware_update` in a required `advanced` section).
 *
 * Form values are kept in a flat map keyed by field path (`advanced.disable_ssl_verify`)
 * so the dialog can hold them in one piece of state, and are reassembled into
 * HA's nested shape by `buildFlowUserInput()`.
 */

export interface FlowSchemaField {
  name: string;
  type?: string;
  required?: boolean;
  optional?: boolean;
  default?: unknown;
  /** Present on `type: 'expandable'` sections */
  schema?: FlowSchemaField[];
  expanded?: boolean;
  selector?: {
    select?: {
      options: Array<{ value: string; label: string } | string>;
      translation_key?: string;
      mode?: string;
    };
    text?: { type?: string };
    boolean?: Record<string, unknown>;
    number?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export type FlowFormValue = string | boolean;
export type FlowFormValues = Record<string, FlowFormValue>;

export function isSectionField(field: FlowSchemaField): boolean {
  return field.type === 'expandable' && Array.isArray(field.schema);
}

export function isBooleanField(field: FlowSchemaField): boolean {
  return !!field.selector?.boolean || field.type === 'boolean';
}

export function isNumberSelectorField(field: FlowSchemaField): boolean {
  return !!field.selector?.number || field.type === 'integer' || field.type === 'float';
}

export function fieldPath(name: string, prefix?: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

/**
 * Initial form values from a schema's defaults, keyed by field path.
 * Booleans keep their boolean default; everything else is stringified for inputs.
 * Fields without a default are left out, except required booleans which start
 * as `false`. An optional boolean without a default (ha-bambulab's `newCode`
 * resend trigger) must not be submitted unless set.
 */
export function getFlowFormDefaults(schema?: FlowSchemaField[], prefix?: string): FlowFormValues {
  const values: FlowFormValues = {};
  for (const field of schema ?? []) {
    const path = fieldPath(field.name, prefix);
    if (isSectionField(field)) {
      Object.assign(values, getFlowFormDefaults(field.schema, path));
      continue;
    }
    if (field.default === undefined || field.default === null) {
      // A required boolean always has a value (an unticked box is `false`), matching HA's own form
      if (isBooleanField(field) && field.required) values[path] = false;
      continue;
    }
    values[path] = isBooleanField(field) ? field.default === true || field.default === 'true' : String(field.default);
  }
  return values;
}

/**
 * Collect every field path in a schema (including fields nested in sections).
 */
export function getFlowFieldPaths(schema?: FlowSchemaField[], prefix?: string): string[] {
  const paths: string[] = [];
  for (const field of schema ?? []) {
    const path = fieldPath(field.name, prefix);
    if (isSectionField(field)) {
      paths.push(...getFlowFieldPaths(field.schema, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function toBoolean(value: FlowFormValue): boolean {
  return value === true || value === 'true';
}

/**
 * Build the user_input payload HA expects for a flow step.
 *
 * - Only fields in the schema are sent.
 * - Sections are always sent as a nested object (HA requires the key even when
 *   every field inside falls back to its default).
 * - Booleans are sent as real booleans; unset booleans are omitted.
 * - Number selectors are sent as numbers; text-like fields as strings (as typed),
 *   omitted when blank so HA applies its own default.
 */
export function buildFlowUserInput(
  schema: FlowSchemaField[] | undefined,
  values: FlowFormValues,
  prefix?: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of schema ?? []) {
    const path = fieldPath(field.name, prefix);

    if (isSectionField(field)) {
      input[field.name] = buildFlowUserInput(field.schema, values, path);
      continue;
    }

    const value = values[path];
    if (value === undefined || value === '') continue;

    if (isBooleanField(field)) {
      input[field.name] = toBoolean(value);
      continue;
    }

    const text = String(value);
    if (text.trim() === '') continue;

    if (isNumberSelectorField(field)) {
      const num = Number(text);
      input[field.name] = Number.isFinite(num) ? num : text;
    } else {
      input[field.name] = text;
    }
  }
  return input;
}
