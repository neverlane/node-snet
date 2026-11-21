/**
 * Light load + packet loss tests across the node/lua matrix.
 * Each scenario prints a summary line; assertions encode what the protocol promises:
 *   - reliable priorities (LOW..SYSTEM) on a clean link: every packet exactly once
 *   - BYPASS on localhost: loss should be ~0 (it is UDP, but loopback shouldn't drop bursts)
 *   - with a lossy link: HIGH still delivers everything (20 resends), duplicates are not delivered
 *   - after everything is ACKed, resend queues are empty (no memory growth)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BitStream, SNET_PRIORITES } from '../src';
import { hasLua } from './helpers/lua';
import { burstPacket, closeAll, getPort, PKT, sleep, startNodeClient, startNodeServer, waitFor } from './helpers/net';
import { makeRig, pendingOf, remoteStats, rigName, type RigOptions } from './helpers/rigs';

const lua = hasLua();
const cleanup: Parameters<typeof closeAll> = [];
afterEach(async () => { await closeAll(...cleanup.splice(0)); });

const PAIRS: RigOptions[] = [
  { localRole: 'server', remote: 'node' },
  { localRole: 'client', remote: 'node' },
  { localRole: 'server', remote: 'lua' },
  { localRole: 'client', remote: 'lua' },
];

interface Scenario { name: string; count: number; size: number; priority: SNET_PRIORITES; loss?: number; maxLoss: number; timeout: number }

const SCENARIOS: Scenario[] = [
  { name: 'burst 1000 x 64B BYPASS', count: 1000, size: 64, priority: SNET_PRIORITES.BYPASS, maxLoss: 0.01, timeout: 5000 },
  { name: 'burst 500 x 256B HIGH', count: 500, size: 256, priority: SNET_PRIORITES.HIGH, maxLoss: 0, timeout: 15000 },
  { name: 'burst 200 x 500B LOW', count: 200, size: 500, priority: SNET_PRIORITES.LOW, maxLoss: 0, timeout: 15000 },
  { name: '200 x 32B HIGH over 10% loss', count: 200, size: 32, priority: SNET_PRIORITES.HIGH, loss: 0.1, maxLoss: 0, timeout: 40000 },
];

const report = (what: string, sent: number, unique: number, total: number, ms: number) => {
  const lost = sent - unique;
  console.log(`[load] ${what}: sent=${sent} unique=${unique} dup=${total - unique} lost=${lost} (${((lost / sent) * 100).toFixed(1)}%) in ${ms}ms`);
};

describe.each(PAIRS)('load: $localRole node-snet vs $remote', (pair) => {
  const skip = pair.remote === 'lua' && !lua;

  for (const sc of SCENARIOS) {
    // measure node-snet, not Razor's default socket buffer (see 'lua defaults' below)
    const opts: RigOptions = { ...pair, loss: sc.loss, luaRcvbuf: 4 * 1024 * 1024 };

    it.skipIf(skip)(`${rigName(opts)}: remote -> node, ${sc.name}`, async () => {
      const rig = await makeRig(opts);
      cleanup.push(rig);
      const t = Date.now();
      // ask remote to burst; command itself goes reliable so it survives the lossy link
      rig.send(PKT.BURST, burstPacket(sc.count, sc.priority, sc.size), SNET_PRIORITES.HIGH);

      const items = () => rig.inbox.byId(PKT.BURST_ITEM);
      const unique = () => new Set(items().map((i) => i.data.readUInt32LE(0))).size;
      await waitFor(() => unique() >= sc.count, sc.timeout, 'burst').catch(() => {});
      await sleep(sc.priority === SNET_PRIORITES.BYPASS ? 100 : 1500); // let late duplicates arrive
      report(`${rig.name} remote->node ${sc.name}`, sc.count, unique(), items().length, Date.now() - t);

      for (const it of items()) expect(it.data.length).toBe(sc.size);
      expect(sc.count - unique(), 'lost').toBeLessThanOrEqual(Math.floor(sc.count * sc.maxLoss));
      if (sc.priority !== SNET_PRIORITES.BYPASS) {
        expect(items().length - unique(), 'duplicates delivered to node user').toBe(0);
        await waitFor(() => pendingOf(rig.local) === 0, 5000, 'local queue drained').catch(() => {});
        expect(pendingOf(rig.local), 'local resend queue after ACKs').toBe(0);
      }
    }, sc.timeout + 20000);

    it.skipIf(skip)(`${rigName(opts)}: node -> remote, ${sc.name}`, async () => {
      const rig = await makeRig(opts);
      cleanup.push(rig);
      const t = Date.now();
      const filler = Buffer.alloc(Math.max(0, sc.size - 4), 0x5a);
      for (let seq = 0; seq < sc.count; seq++) {
        rig.send(PKT.LOAD, new BitStream().writeUInt32(seq).writeBytes(filler), sc.priority);
      }

      const stats = await remoteStats(rig, (s) => s.loadUnique >= sc.count, sc.timeout).catch(() => remoteStats(rig));
      await sleep(sc.priority === SNET_PRIORITES.BYPASS ? 0 : 1500);
      const final = await remoteStats(rig).catch(() => stats);
      report(`${rig.name} node->remote ${sc.name}`, sc.count, final.loadUnique, final.loadTotal, Date.now() - t);

      expect(sc.count - final.loadUnique, 'lost').toBeLessThanOrEqual(Math.floor(sc.count * sc.maxLoss));
      if (sc.priority !== SNET_PRIORITES.BYPASS) {
        await waitFor(() => pendingOf(rig.local) === 0, 5000, 'local queue drained').catch(() => {});
        expect(pendingOf(rig.local), 'local resend queue after ACKs').toBe(0);
        if (pair.remote === 'node') {
          expect(final.loadTotal - final.loadUnique, 'duplicates delivered to node user').toBe(0);
        }
      }
    }, sc.timeout + 20000);
  }
});

describe.skipIf(!lua)('lua defaults (upstream limitation, report only)', () => {
  it.each(['server', 'client'] as const)('lua %s with default OS buffer: node -> lua 1000 x 64B BYPASS', async (luaRole) => {
    const rig = await makeRig({ localRole: luaRole === 'server' ? 'client' : 'server', remote: 'lua' });
    cleanup.push(rig);
    const t = Date.now();
    for (let seq = 0; seq < 1000; seq++) rig.send(PKT.LOAD, new BitStream().writeUInt32(seq).writeBytes(Buffer.alloc(60)), SNET_PRIORITES.BYPASS);
    const s = await remoteStats(rig);
    report(`${rig.name} (lua default rcvbuf) node->lua BYPASS`, 1000, s.loadUnique, s.loadTotal, Date.now() - t);
    expect(s.loadUnique).toBeGreaterThan(0);
  });
});

describe('memory: expired packets leave the resend queue', () => {
  // nobody listens on the port -> nothing is ever ACKed. Lua drops LOW after 5 resends, MEDIUM after 10,
  // and SYSTEM as soon as the peer is not connected.
  it.each([
    ['LOW (5 resends)', SNET_PRIORITES.LOW, 6_000],
    ['MEDIUM (10 resends)', SNET_PRIORITES.MEDIUM, 12_000],
    ['SYSTEM while never connected', SNET_PRIORITES.SYSTEM, 2_000],
  ] as const)('%s', async (_, priority, within) => {
    const client = await startNodeClient(getPort());
    cleanup.push(client);
    for (let i = 0; i < 100; i++) client.send(1, new BitStream().writeUInt32(i), priority);
    expect(pendingOf(client)).toBe(100);
    await waitFor(() => pendingOf(client) === 0, within, 'queue drained');
  }, 20_000);

  it('server drops queued packets for a client that never ACKs', async () => {
    const server = await startNodeServer(getPort());
    cleanup.push(server);
    for (let i = 0; i < 100; i++) server.send(1, new BitStream().writeUInt32(i), SNET_PRIORITES.LOW, '127.0.0.1', getPort());
    await waitFor(() => pendingOf(server) === 0, 6_000, 'queue drained');
  }, 20_000);
});
