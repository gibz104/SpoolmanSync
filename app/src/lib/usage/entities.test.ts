import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { EntitySubscription } from './entities';

/** Just enough of Home Assistant's WebSocket API: the login, and a result for every command. */
async function fakeHomeAssistant() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const clients = new Set<WebSocket>();
  let connections = 0;
  server.on('connection', socket => {
    connections++;
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }));
      else socket.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
    });
    socket.send(JSON.stringify({ type: 'auth_required' }));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections: () => connections,
    /** Drop every connection, as a restart of Home Assistant does. */
    restart: () => { for (const client of clients) client.terminate(); },
    close: () => {
      for (const client of clients) client.terminate();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function until(condition: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe('EntitySubscription', () => {
  it('reconnects when Home Assistant restarts after a reconnect from Settings', async () => {
    const ha = await fakeHomeAssistant();
    cleanup.push(ha.close);
    // Embedded mode: the tracker starts before Home Assistant is set up, so a
    // retry is waiting when setup saves the connection and reconnects it.
    let setUp = false;
    const statuses: boolean[] = [];
    const sub = new EntitySubscription({
      connect: async () => (setUp ? { url: ha.url, token: 'token' } : null),
      onChange: () => {},
      onStatus: connected => statuses.push(connected),
    });
    cleanup.push(() => sub.stop());
    sub.start();
    await until(() => statuses.length === 1);
    setUp = true;
    sub.stop();
    sub.start();
    await until(() => sub.connected);

    // Setup restarts Home Assistant to load the automations.
    ha.restart();
    await until(() => !sub.connected);
    await until(() => sub.connected);
    expect(ha.connections()).toBe(2);
    expect(statuses).toEqual([false, true, false, true]);
  }, 10_000);

  it('opens one connection when reconnected while the last connect was still starting', async () => {
    const ha = await fakeHomeAssistant();
    cleanup.push(ha.close);
    const lookups: Array<() => void> = [];
    const sub = new EntitySubscription({
      connect: () => new Promise(resolve => lookups.push(() => resolve({ url: ha.url, token: 'token' }))),
      onChange: () => {},
      onStatus: () => {},
    });
    cleanup.push(() => sub.stop());
    sub.start();
    sub.stop();
    sub.start();
    for (const resolve of lookups) resolve();
    await until(() => sub.connected);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(ha.connections()).toBe(1);
  });
});
