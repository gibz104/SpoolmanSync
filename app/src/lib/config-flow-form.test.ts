import { describe, expect, it } from 'vitest';
import {
  type FlowSchemaField,
  buildFlowUserInput,
  getFlowFieldPaths,
  getFlowFormDefaults,
} from './config-flow-form';

// ha-bambulab's `Lan` step as serialized by HA's config flow API (issue #82)
const lanSchema: FlowSchemaField[] = [
  { name: 'host', required: true, default: '', selector: { text: { type: 'text' } } },
  { name: 'serial', required: true, default: '', selector: { text: { type: 'text' } } },
  { name: 'access_code', required: true, default: '', selector: { text: { type: 'text' } } },
  { name: 'print_cache_count', optional: true, default: '100', selector: { text: { type: 'number' } } },
  { name: 'timelapse_cache_count', optional: true, default: '1', selector: { text: { type: 'number' } } },
  { name: 'usage_hours', optional: true, default: '0', selector: { text: { type: 'number' } } },
  {
    name: 'advanced',
    required: true,
    type: 'expandable',
    expanded: false,
    schema: [
      { name: 'disable_ssl_verify', required: true, default: false, selector: { boolean: {} } },
      { name: 'enable_firmware_update', required: true, default: false, selector: { boolean: {} } },
    ],
  },
];

describe('config flow sections (#82)', () => {
  it('always submits a section as a nested object, even untouched', () => {
    const values = {
      ...getFlowFormDefaults(lanSchema),
      host: '192.168.1.50',
      serial: '01P00A000000000',
      access_code: '12345678',
    };
    expect(buildFlowUserInput(lanSchema, values)).toEqual({
      host: '192.168.1.50',
      serial: '01P00A000000000',
      access_code: '12345678',
      print_cache_count: '100',
      timelapse_cache_count: '1',
      usage_hours: '0',
      advanced: { disable_ssl_verify: false, enable_firmware_update: false },
    });
  });

  it('submits section booleans the user toggled', () => {
    const values = { ...getFlowFormDefaults(lanSchema), 'advanced.disable_ssl_verify': true };
    expect(buildFlowUserInput(lanSchema, values).advanced).toEqual({
      disable_ssl_verify: true,
      enable_firmware_update: false,
    });
  });

  it('never submits the section as a string', () => {
    const values = { ...getFlowFormDefaults(lanSchema), advanced: 'anything' };
    expect(buildFlowUserInput(lanSchema, values).advanced).toEqual({
      disable_ssl_verify: false,
      enable_firmware_update: false,
    });
  });

  it('keys section field paths by section name', () => {
    expect(getFlowFieldPaths(lanSchema)).toContain('advanced.disable_ssl_verify');
    expect(getFlowFieldPaths(lanSchema)).not.toContain('advanced');
  });

  it('handles the re-shown form after a failed connection', () => {
    // ha-bambulab re-renders with `.get(..., '')` defaults inside the section
    const reshown = structuredClone(lanSchema);
    reshown[6].schema = reshown[6].schema!.map(f => ({ ...f, default: '' }));
    const values = { ...getFlowFormDefaults(reshown), host: 'h', serial: 's', access_code: 'a' };
    expect(buildFlowUserInput(reshown, values).advanced).toEqual({
      disable_ssl_verify: false,
      enable_firmware_update: false,
    });
  });
});

describe('config flow field conversion', () => {
  it('omits blank text so HA applies its default', () => {
    expect(buildFlowUserInput(lanSchema, { host: '  ', serial: '' })).not.toHaveProperty('host');
  });

  it('sends text as typed (passwords are not trimmed)', () => {
    const schema: FlowSchemaField[] = [{ name: 'password', required: true, selector: { text: { type: 'password' } } }];
    expect(buildFlowUserInput(schema, { password: ' secret ' })).toEqual({ password: ' secret ' });
  });

  it('does not submit an optional boolean trigger with no default (newCode)', () => {
    const schema: FlowSchemaField[] = [
      { name: 'newCode', optional: true, selector: { boolean: {} } },
      { name: 'verifyCode', optional: true, default: '', selector: { text: { type: 'text' } } },
    ];
    const values = { ...getFlowFormDefaults(schema), verifyCode: '123456', newCode: '' };
    expect(buildFlowUserInput(schema, values)).toEqual({ verifyCode: '123456' });
  });

  it('defaults required booleans without a default to false', () => {
    const schema: FlowSchemaField[] = [{ name: 'flag', required: true, selector: { boolean: {} } }];
    expect(buildFlowUserInput(schema, getFlowFormDefaults(schema))).toEqual({ flag: false });
  });

  it('sends number selectors as numbers', () => {
    const schema: FlowSchemaField[] = [{ name: 'port', required: true, selector: { number: { mode: 'box' } } }];
    expect(buildFlowUserInput(schema, { port: '7125' })).toEqual({ port: 7125 });
  });

  it('ignores values for fields not in the schema', () => {
    expect(buildFlowUserInput(lanSchema, { email: 'x@y.z' })).not.toHaveProperty('email');
  });

  it('builds the cloud auto-submit payload from defaults', () => {
    const cloudSchema: FlowSchemaField[] = [
      { name: 'host', optional: true, default: '10.0.0.5', selector: { text: { type: 'text' } } },
      { name: 'serial', required: true, default: 'ABC', selector: { select: { options: [] } } },
      { name: 'local_mqtt', optional: true, default: false, selector: { boolean: {} } },
      { name: 'skip_local_mqtt', optional: true, default: false, selector: { boolean: {} } },
      ...lanSchema.slice(2),
    ];
    const values = { ...getFlowFormDefaults(cloudSchema), skip_local_mqtt: true };
    const input = buildFlowUserInput(cloudSchema, values);
    expect(input).toMatchObject({
      host: '10.0.0.5',
      serial: 'ABC',
      local_mqtt: false,
      skip_local_mqtt: true,
      advanced: { disable_ssl_verify: false, enable_firmware_update: false },
    });
    // access_code default is '' and is left for HA to default
    expect(input).not.toHaveProperty('access_code');
  });
});
