/**
 * node-snet <-> Lua SNET (RazorRw/SNET @19aecbe) interop scenarios.
 * Needs: luajit + luasocket + pinned Lua SNET -> run `pnpm test:setup` once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BitStream, SNET_BLOCK_PACKET, SNET_PRIORITES } from '../src';
import { hasLua, LuaPeer } from './helpers/lua';
import {
  closeAll, collect, decodeTyped, echoPacket, encodeTyped, getPort, PKT, SAMPLE_TYPED,
  sleep, startNodeClient, startNodeServer, waitFor, type Typed,
} from './helpers/net';
import { makeRig, pendingOf, remoteStats, rigName, type RigOptions } from './helpers/rigs';

const lua = hasLua();
if (!lua) console.warn('[interop] Lua SNET not available, lua tests skipped. Run: pnpm test:setup');

const cleanup: Parameters<typeof closeAll> = [];
afterEach(async () => { await closeAll(...cleanup.splice(0)); });

const PAIRS: RigOptions[] = [
  { localRole: 'server', remote: 'node' },
  { localRole: 'client', remote: 'node' },
  { localRole: 'server', remote: 'lua' },
  { localRole: 'client', remote: 'lua' },
];

const PAYLOADS: [string, Buffer][] = [
  ['ascii', Buffer.from('hello world maaan')],
  ['ends with 0x00', Buffer.from([1, 2, 3, 0])],
  ['only zeros', Buffer.alloc(8)],
  ['single byte', Buffer.from([0xff])],
  ['binary 0..255', Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
  ['utf8', Buffer.from('привет, snet 👋', 'utf8')],
  ['max size (511 + 1 byte echo prefix = 512)', Buffer.alloc(511, 0xab)],
];

const UTF8_TYPED: Typed = { u8: 0, i8: -1, u16: 1, i16: -1, u32: 0, i32: 1, f: -0.25, b: false, str: 'ёжик' };

describe.each(PAIRS)('$localRole node-snet vs $remote', (opts) => {
  const skip = opts.remote === 'lua' && !lua;

  it.skipIf(skip).each(PAYLOADS)(`${rigName(opts)}: echo exact payload [%s]`, async (_, payload) => {
    const rig = await makeRig(opts);
    cleanup.push(rig);
    rig.send(PKT.ECHO, echoPacket(payload, SNET_PRIORITES.HIGH), SNET_PRIORITES.HIGH);
    const back = await rig.inbox.first(PKT.ECHO_REPLY);
    // what the remote side actually got (catches errors that cancel out in a roundtrip)
    if (rig.lua) {
      const seen = await rig.lua.waitRecv(PKT.ECHO);
      expect(seen.subarray(1).toString('hex'), 'payload as seen by lua').toBe(payload.toString('hex'));
    }
    expect(back.toString('hex'), 'payload echoed back').toBe(payload.toString('hex'));
  });

  it.skipIf(skip)(`${rigName(opts)}: echo empty payload`, async () => {
    const rig = await makeRig(opts);
    cleanup.push(rig);
    rig.send(PKT.ECHO, echoPacket(Buffer.alloc(0), SNET_PRIORITES.HIGH), SNET_PRIORITES.HIGH);
    expect((await rig.inbox.first(PKT.ECHO_REPLY)).length).toBe(0);
  });

  it.skipIf(skip).each([
    ['bypass', SNET_PRIORITES.BYPASS], ['low', SNET_PRIORITES.LOW], ['medium', SNET_PRIORITES.MEDIUM],
    ['high', SNET_PRIORITES.HIGH], ['system', SNET_PRIORITES.SYSTEM],
  ] as const)(`${rigName(opts)}: echo with priority %s`, async (_, pr) => {
    const rig = await makeRig(opts);
    cleanup.push(rig);
    rig.send(PKT.ECHO, echoPacket(Buffer.from('p'), pr), pr);
    expect((await rig.inbox.first(PKT.ECHO_REPLY)).toString()).toBe('p');
  });

  it.skipIf(skip).each([['sample', SAMPLE_TYPED], ['utf8/negative', UTF8_TYPED]] as const)(
    `${rigName(opts)}: typed fields decode and re-encode identically [%s]`, async (_, typed) => {
      const rig = await makeRig(opts);
      cleanup.push(rig);
      const encoded = encodeTyped(typed);
      rig.send(PKT.TYPED, encoded, SNET_PRIORITES.HIGH);
      const back = await rig.inbox.first(PKT.TYPED_REPLY);
      if (rig.lua) {
        const line = await rig.lua.waitLine((l) => l.startsWith('TYPED '));
        const [, u8, i8, u16, i16, u32, i32, f, b, strHex] = line.split(' ');
        expect({
          u8: +u8, i8: +i8, u16: +u16, i16: +i16, u32: +u32, i32: +i32, f: +f, b: b === 'true',
          str: Buffer.from(strHex ?? '', 'hex').toString('utf8'),
        }).toEqual(typed);
      }
      expect(back.toString('hex'), 'remote encoding == node encoding').toBe(encoded.getBuffer().toString('hex'));
      expect(decodeTyped(BitStream.from(back))).toEqual(typed);
    });

  it.skipIf(skip)(`${rigName(opts)}: reliable packets are ACKed on both sides (queues drain)`, async () => {
    const rig = await makeRig(opts);
    cleanup.push(rig);
    for (let i = 0; i < 20; i++) rig.send(PKT.ECHO, echoPacket(Buffer.from([i]), SNET_PRIORITES.HIGH), SNET_PRIORITES.HIGH);
    await waitFor(() => rig.inbox.byId(PKT.ECHO_REPLY).length >= 20, 5000, 'echo replies');
    await waitFor(() => pendingOf(rig.local) === 0, 3000, 'local resend queue empty');
    const stats = await remoteStats(rig, (s) => s.pending === 0, 5000);
    expect(stats.pending, 'remote resend queue').toBe(0);
    expect(rig.inbox.byId(PKT.ECHO_REPLY)).toHaveLength(20); // and no duplicates
  });
});

// ---------------------------------------------------------------------------------------
// multi-peer topologies
// ---------------------------------------------------------------------------------------

describe.skipIf(!lua)('topologies', () => {
  it('test 1: node server + node client + lua client', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const inbox = collect(server);
    const updates: string[] = [];
    server.on('clientUpdate', (_a, _p, type) => updates.push(type));
    cleanup.push(server);

    const nodeClient = await startNodeClient(port);
    const nodeInbox = collect(nodeClient);
    cleanup.push(nodeClient);
    nodeClient.send(PKT.HELLO, new BitStream().writeBytes(Buffer.from('node')), SNET_PRIORITES.HIGH);

    const luaClient = await LuaPeer.start('client', port);
    cleanup.push(luaClient);

    await waitFor(() => inbox.byId(PKT.HELLO).length >= 2, 3000, 'two HELLOs');
    expect(inbox.byId(PKT.HELLO).map((h) => h.data.toString()).sort()).toEqual(['lua', 'node']);
    expect(updates).toEqual(['connect', 'connect']);
    expect(Object.keys(server.clients)).toHaveLength(2);

    // broadcast reaches both, byte-exact
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    server.sendAll(77, new BitStream().writeBytes(payload), SNET_PRIORITES.HIGH);
    expect((await luaClient.waitRecv(77)).toString('hex')).toBe(payload.toString('hex'));
    expect((await nodeInbox.first(77)).toString('hex')).toBe(payload.toString('hex'));

    // server can address the lua client individually
    const luaHello = inbox.byId(PKT.HELLO).find((h) => h.data.toString() === 'lua')!;
    server.send(PKT.ECHO, echoPacket(Buffer.from('only-lua'), SNET_PRIORITES.HIGH), SNET_PRIORITES.HIGH, luaHello.address!, luaHello.port!);
    await waitFor(() => inbox.byId(PKT.ECHO_REPLY).length > 0);
    expect(inbox.byId(PKT.ECHO_REPLY)[0].data.toString()).toBe('only-lua');
    expect(inbox.byId(PKT.ECHO_REPLY)[0].port).toBe(luaHello.port);
    expect(nodeInbox.byId(PKT.ECHO)).toHaveLength(0);
  });

  it('test 2: node client + lua server (server sees connect, node gets replies)', async () => {
    const port = getPort();
    const luaServer = await LuaPeer.start('server', port);
    cleanup.push(luaServer);
    const client = await startNodeClient(port);
    const inbox = collect(client);
    cleanup.push(client);

    client.send(PKT.HELLO, new BitStream().writeBytes(Buffer.from('node')), SNET_PRIORITES.HIGH);
    await luaServer.waitLine((l) => l.startsWith('CLIENT ') && l.endsWith(' connected'));
    expect((await luaServer.waitRecv(PKT.HELLO)).toString()).toBe('node');

    client.send(PKT.ECHO, echoPacket(Buffer.from('pong'), SNET_PRIORITES.MEDIUM), SNET_PRIORITES.MEDIUM);
    expect((await inbox.first(PKT.ECHO_REPLY)).toString()).toBe('pong');
  });

  it('test 3: lua server + node client + lua client (server routes to each client)', async () => {
    const port = getPort();
    const luaServer = await LuaPeer.start('server', port);
    cleanup.push(luaServer);
    const luaClient = await LuaPeer.start('client', port);
    cleanup.push(luaClient);
    const client = await startNodeClient(port);
    const inbox = collect(client);
    cleanup.push(client);

    client.send(PKT.HELLO, new BitStream().writeBytes(Buffer.from('node')), SNET_PRIORITES.HIGH);
    await waitFor(() => luaServer.lines.filter((l) => l.startsWith('CLIENT ')).length >= 2, 3000, 'two clients on lua server');

    client.send(PKT.ECHO, echoPacket(Buffer.from('n'), SNET_PRIORITES.HIGH), SNET_PRIORITES.HIGH);
    expect((await inbox.first(PKT.ECHO_REPLY)).toString()).toBe('n');
    await sleep(200);
    expect(luaClient.received(PKT.ECHO_REPLY)).toHaveLength(0);
  });

  it('test 4: node server + 2 lua clients + 2 node clients, broadcast', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const inbox = collect(server);
    cleanup.push(server);
    const luas = [await LuaPeer.start('client', port), await LuaPeer.start('client', port)];
    cleanup.push(...luas);
    const nodes = [await startNodeClient(port), await startNodeClient(port)];
    cleanup.push(...nodes);
    const nodeInboxes = nodes.map(collect);
    nodes.forEach((c) => c.send(PKT.HELLO, new BitStream().writeBytes(Buffer.from('node')), SNET_PRIORITES.HIGH));

    await waitFor(() => Object.keys(server.clients).length === 4, 3000, '4 clients');
    for (let i = 0; i < 10; i++) server.sendAll(50 + i, new BitStream().writeUInt32(i), SNET_PRIORITES.HIGH);
    for (const l of luas) await l.waitRecv(59);
    for (const ni of nodeInboxes) await ni.first(59);
    for (const l of luas) for (let i = 0; i < 10; i++) expect(l.received(50 + i)).toHaveLength(1);
    for (const ni of nodeInboxes) for (let i = 0; i < 10; i++) expect(ni.byId(50 + i)).toHaveLength(1);
    expect(inbox.got.filter((g) => g.id === PKT.HELLO)).toHaveLength(4);
  });

  it('lua server <-> lua client baseline (harness sanity)', async () => {
    const port = getPort();
    const luaServer = await LuaPeer.start('server', port);
    cleanup.push(luaServer);
    const luaClient = await LuaPeer.start('client', port);
    cleanup.push(luaClient);
    expect((await luaServer.waitRecv(PKT.HELLO)).toString()).toBe('lua');
  });

  it('blacklisted lua client receives SNET_BLOCK_PACKET and is ignored', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const inbox = collect(server);
    cleanup.push(server);
    server.blockAddress('127.0.0.1');
    const luaClient = await LuaPeer.start('client', port);
    cleanup.push(luaClient);
    await luaClient.waitRecv(SNET_BLOCK_PACKET);
    await sleep(200);
    expect(inbox.got).toHaveLength(0);
    expect(luaClient.received(SNET_BLOCK_PACKET)).toHaveLength(1); // rate-limited, not per packet
  });

  it('node client handles SNET_BLOCK_PACKET from lua-compatible server', async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    cleanup.push(server);
    server.blockAddress('127.0.0.1');
    const client = await startNodeClient(port);
    const inbox = collect(client);
    cleanup.push(client);
    client.send(PKT.HELLO, new BitStream(), SNET_PRIORITES.BYPASS);
    await waitFor(() => inbox.byId(SNET_BLOCK_PACKET).length > 0);
    expect(inbox.byId(SNET_BLOCK_PACKET)[0].data.length).toBe(0);
  });
});
