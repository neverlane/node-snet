/** v2 node-snet features (not part of the Lua protocol, no wire changes). */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BitStream, Client, convertClientConnectionString, decodePacket, encodePacket,
  PacketLostError, SNET_PRIORITIES, SNET_STATUSES,
} from '../src';
import { buildDatagram, closeAll, collect, getPort, rawSocket, sleep, startNodeClient, startNodeServer, waitFor } from './helpers/net';

const cleanup: Parameters<typeof closeAll> = [];
afterEach(async () => { await closeAll(...cleanup.splice(0)); });

describe('sendAsync / packetLost', () => {
  it('resolves after the server confirms', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const client = await startNodeClient(port);
    cleanup.push(client, server);
    await client.sendAsync(1, new BitStream().writeUInt8(1), SNET_PRIORITIES.HIGH);
    expect(client.pendingCount).toBe(0);
  });

  it('rejects with PacketLostError and emits packetLost when nobody confirms', async () => {
    const client = await startNodeClient(getPort(), { resendInterval: 20 });
    cleanup.push(client);
    const lost: number[] = [];
    client.on('packetLost', (packetId) => lost.push(packetId));
    await expect(client.sendAsync(9, new BitStream(), SNET_PRIORITIES.LOW)).rejects.toBeInstanceOf(PacketLostError);
    expect(lost).toEqual([9]);
  });

  it('server.sendAsync to a specific client', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const client = await startNodeClient(port);
    const inbox = collect(client);
    cleanup.push(client, server);
    let remote: import('../src').ServerClient | undefined;
    server.on('connect', (c) => (remote = c));
    client.send(1, new BitStream(), SNET_PRIORITIES.BYPASS);
    await waitFor(() => !!remote);
    await remote!.sendAsync(5, new BitStream().writeString8('hi'));
    expect(BitStream.from(await inbox.first(5)).readString8()).toBe('hi');
  });
});

describe('limits', () => {
  it('send throws when payload exceeds maxTransferBytes', async () => {
    const client = await startNodeClient(getPort(), { maxTransferBytes: 8 });
    cleanup.push(client);
    expect(() => client.send(1, Buffer.alloc(9))).toThrow(RangeError);
    expect(() => client.send(-1, Buffer.alloc(1))).toThrow(RangeError);
  });

  it('uses big OS socket buffers by default', async () => {
    const client = await startNodeClient(getPort());
    cleanup.push(client);
    expect(client.socket.getRecvBufferSize()).toBeGreaterThan(100_000);
  });
});

describe('timeouts', () => {
  it('client goes DISCONNECTED after silence and emits timeout', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const client = await startNodeClient(port, { timeout: 300 });
    cleanup.push(client, server);
    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('timeout', () => events.push('timeout'));
    client.send(1, new BitStream(), SNET_PRIORITIES.HIGH); // server ACK -> connected
    await waitFor(() => client.status === SNET_STATUSES.CONNECTED);
    await waitFor(() => client.status === SNET_STATUSES.DISCONNECTED, 2000);
    expect(events).toEqual(['connected', 'timeout']);
  });

  it('server drops a silent client and its SYSTEM packets', async () => {
    const port = getPort();
    const server = await startNodeServer(port, { clientTimeout: 300 });
    cleanup.push(server);
    const raw = await rawSocket();
    cleanup.push(raw);
    const updates: string[] = [];
    server.on('clientUpdate', (_a, _p, t) => updates.push(t));
    await raw.send(buildDatagram(0, 1, 0, Buffer.alloc(0)), port);
    await waitFor(() => server.clients.size === 1);
    server.sendAll(2, new BitStream(), SNET_PRIORITIES.SYSTEM); // raw socket never ACKs
    expect(server.pendingCount).toBe(1);
    await waitFor(() => server.clients.size === 0, 2000);
    expect(updates).toEqual(['connect', 'timeout']);
    expect(server.pendingCount).toBe(0);
  });

  it('a duplicate retransmission is ACKed again but delivered once', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const inbox = collect(server);
    cleanup.push(server);
    const raw = await rawSocket();
    cleanup.push(raw);
    // ids far apart in time / many packets in between still dedup (v1 window was 10)
    await raw.send(buildDatagram(1, 5, SNET_PRIORITIES.HIGH, Buffer.from('a')), port);
    for (let i = 2; i < 100; i++) await raw.send(buildDatagram(i, 6, SNET_PRIORITIES.HIGH, Buffer.alloc(0)), port);
    await raw.send(buildDatagram(1, 5, SNET_PRIORITIES.HIGH, Buffer.from('a')), port);
    await waitFor(() => raw.got.length >= 100);
    await sleep(50);
    expect(inbox.byId(5)).toHaveLength(1);
  });
});

describe('legacy terminator (SLMP SNET / node-snet 1.x)', () => {
  it('encodes and decodes a trailing 0x00', () => {
    const dg = encodePacket(1, 2, 3, Buffer.from('ab'), true);
    expect(dg.toString('hex')).toBe(buildDatagram(1, 2, 3, Buffer.from('ab'), true).toString('hex'));
    expect(decodePacket(dg, true)!.payload.toString()).toBe('ab');
    expect(decodePacket(dg, false)!.payload.toString('hex')).toBe('616200');
  });

  it('legacy client <-> legacy server roundtrip', async () => {
    const port = getPort();
    const server = await startNodeServer(port, { legacyTerminator: true });
    const inbox = collect(server);
    const client = await startNodeClient(port, { legacyTerminator: true });
    cleanup.push(client, server);
    await client.sendAsync(3, Buffer.from('xyz'), SNET_PRIORITIES.HIGH);
    expect((await inbox.first(3)).toString()).toBe('xyz');
  });
});

describe('connection string', () => {
  it('parses host, port and params', () => {
    expect(convertClientConnectionString('snet://example.com:5000?mtb=1024&tick=20')).toEqual({
      address: 'example.com', ipVersion: 'v4', port: 5000, maxTransferBytes: 1024, tickTimeout: 20,
    });
  });

  it('strips IPv6 brackets and detects v6', () => {
    const opts = convertClientConnectionString(new URL('snet://[::1]:13322'));
    expect(opts.address).toBe('::1');
    expect(opts.ipVersion).toBe('v6');
    expect(() => new Client(opts).socket.close()).not.toThrow();
  });

  it('rejects bad values', () => {
    expect(() => convertClientConnectionString('http://x')).toThrow(TypeError);
    expect(() => convertClientConnectionString('snet://x?mtb=abc')).toThrow(TypeError);
    expect(() => convertClientConnectionString('snet://x?ipv=v5')).toThrow(TypeError);
  });

  it('legacy flag', () => {
    expect(convertClientConnectionString('snet://x?legacy=1').legacyTerminator).toBe(true);
  });
});
