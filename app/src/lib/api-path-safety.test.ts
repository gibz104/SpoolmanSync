import { describe, it, expect, vi, afterEach } from 'vitest';
import { HomeAssistantClient } from './api/homeassistant';
import { SpoolmanClient } from './api/spoolman';

/**
 * Values from a request that end up in a Home Assistant or Spoolman URL path
 * (CodeQL js/request-forgery). Printer setup used to pass the browser's
 * flowId straight into a POST that carries SpoolmanSync's Home Assistant
 * token, so "../../../services/lock/unlock" called any service.
 */

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Home Assistant paths built from request values', () => {
  const ha = () => new HomeAssistantClient('http://ha.test:8123', 'token');

  it('refuses a config flow ID that leads to another endpoint, before sending anything', async () => {
    const fetchMock = stubFetch();
    await expect(ha().continueConfigFlow('../../../services/lock/unlock', { entity_id: 'lock.front_door' }))
      .rejects.toThrow('Invalid config flow ID');
    await expect(ha().deleteConfigFlow('..')).rejects.toThrow('Invalid config flow ID');
    await expect(ha().getConfigFlow('a/b')).rejects.toThrow('Invalid config flow ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks entity IDs, services, events, webhooks and config entries too', async () => {
    const fetchMock = stubFetch();
    await expect(ha().getState('../config')).rejects.toThrow('Invalid entity ID');
    await expect(ha().callService('lock', 'unlock/../../x')).rejects.toThrow('Invalid service');
    await expect(ha().fireEvent('../x', {})).rejects.toThrow('Invalid event type');
    await expect(ha().callWebhook('../x', {})).rejects.toThrow('Invalid webhook ID');
    await expect(ha().deleteConfigEntry('../entry')).rejects.toThrow('Invalid config entry ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends real IDs where they belong', async () => {
    const fetchMock = stubFetch();
    await ha().continueConfigFlow('01JC3Q5Z8YB6V2N8K4M7P9R1ST', {});
    await ha().getState('sensor.x1c_ams_1_tray_3');
    await ha().callService('persistent_notification', 'create', {});
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      'http://ha.test:8123/api/config/config_entries/flow/01JC3Q5Z8YB6V2N8K4M7P9R1ST',
      'http://ha.test:8123/api/states/sensor.x1c_ams_1_tray_3',
      'http://ha.test:8123/api/services/persistent_notification/create',
    ]);
  });
});

describe('Spoolman paths built from request values', () => {
  const sm = () => new SpoolmanClient('http://spoolman.test');

  it('take only positive whole spool IDs', async () => {
    const fetchMock = stubFetch();
    await expect(sm().getSpool('1/../../vendor/1' as unknown as number)).rejects.toThrow('Invalid spool ID');
    await expect(sm().useWeight(-1, 5)).rejects.toThrow('Invalid spool ID');
    await expect(sm().unlinkTagUid(1.5, '04AABB')).rejects.toThrow('Invalid spool ID');
    expect(fetchMock).not.toHaveBeenCalled();
    await sm().getSpool(7);
    expect(fetchMock.mock.calls[0][0]).toBe('http://spoolman.test/api/v1/spool/7');
  });
});
