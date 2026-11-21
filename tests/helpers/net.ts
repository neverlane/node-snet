import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { BitStream, Client, Server, SNET_PRIORITES } from '../../src';

let nextPort = 20000 + Math.floor(Math.random() * 20000);
/** Unique-ish UDP port per test (vitest runs files in separate workers, so randomize base). */
export const getPort = () => nextPort++;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeout = 3000, what = 'condition') {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

// ---- control packets understood by tests/lua/peer.lua (and mirrored by nodePeer below) ----
export const PKT = {
  HELLO: 1,
  ECHO: 100, ECHO_REPLY: 101,
  TYPED: 110, TYPED_REPLY: 111,
  BURST: 120, BURST_ITEM: 121,
  LOAD: 122,
  STATS: 130, STATS_REPLY: 131,
  SEND: 140,
} as const;

export interface Typed {
  u8: number; i8: number; u16: number; i16: number;
  u32: number; i32: number; f: number; b: boolean; str: string;
}

export const SAMPLE_TYPED: Typed = {
  u8: 250, i8: -100, u16: 65000, i16: -32000,
  u32: 4000000000, i32: -2000000000, f: 3.5, b: true, str: 'snet',
};

export function encodeTyped(t: Typed) {
  const str = Buffer.from(t.str, 'utf8');
  return new BitStream()
    .writeUInt8(t.u8).writeInt8(t.i8)
    .writeUInt16(t.u16).writeInt16(t.i16)
    .writeUInt32(t.u32).writeInt32(t.i32)
    .writeFloat(t.f).writeBoolean(t.b)
    .writeUInt8(str.length).writeBytes(str);
}

export function decodeTyped(bs: BitStream): Typed {
  const u8 = bs.readUInt8(), i8 = bs.readInt8();
  const u16 = bs.readUInt16(), i16 = bs.readInt16();
  const u32 = bs.readUInt32(), i32 = bs.readInt32();
  const f = bs.readFloat(), b = bs.readBoolean();
  const str = bs.readBytes(bs.readUInt8()).toString('utf8');
  return { u8, i8, u16, i16, u32, i32, f, b, str };
}

export const echoPacket = (payload: Buffer, priority: SNET_PRIORITES) =>
  new BitStream().writeUInt8(priority).writeBytes(payload);

export const burstPacket = (count: number, priority: SNET_PRIORITES, size: number) =>
  new BitStream().writeUInt32(count).writeUInt8(priority).writeUInt16(size);


export function parseStats(bs: BitStream) {
  return { pending: bs.readUInt32(), loadUnique: bs.readUInt32(), loadTotal: bs.readUInt32() };
}

/** Same control behaviour as peer.lua, but implemented with node-snet (for node<->node baselines). */
export function attachNodePeer(peer: Server | Client) {
  const state = { loadSeen: new Set<number>(), loadTotal: 0 };
  const reply = (id: number, bs: BitStream, pr: SNET_PRIORITES, address: string, port: number) =>
    peer instanceof Server ? peer.send(id, bs, pr, address, port) : peer.send(id, bs, pr);

  (peer as Server).on('receivePacket', (id: number, bs: BitStream, address: string, port: number) => {
    bs = BitStream.from(bs); // own read position
    switch (id) {
      case PKT.ECHO: {
        const pr = bs.readUInt8();
        reply(PKT.ECHO_REPLY, BitStream.from(bs.sliceBuffer(1)), pr, address, port);
        break;
      }
      case PKT.TYPED:
        reply(PKT.TYPED_REPLY, encodeTyped(decodeTyped(bs)), SNET_PRIORITES.HIGH, address, port);
        break;
      case PKT.BURST: {
        const count = bs.readUInt32(), pr = bs.readUInt8(), size = bs.readUInt16();
        for (let seq = 0; seq < count; seq++) {
          const out = new BitStream().writeUInt32(seq);
          if (size > 4) out.writeBytes(Buffer.alloc(size - 4, seq % 256));
          reply(PKT.BURST_ITEM, out, pr, address, port);
        }
        break;
      }
      case PKT.LOAD:
        state.loadTotal++;
        state.loadSeen.add(bs.readUInt32());
        break;
      case PKT.STATS:
        reply(PKT.STATS_REPLY, new BitStream()
          .writeUInt32(peer.pendingCount)
          .writeUInt32(state.loadSeen.size)
          .writeUInt32(state.loadTotal), SNET_PRIORITES.BYPASS, address, port);
        break;
    }
  });
  return state;
}

/** Collects packets received by a node-snet peer, each with its own copy of the stream. */
export function collect(peer: Server | Client) {
  const got: { id: number; data: Buffer; address?: string; port?: number }[] = [];
  (peer as Server).on('receivePacket', (id: number, bs: BitStream, address?: string, port?: number) => {
    got.push({ id, data: Buffer.from(bs.getBuffer()), address, port });
  });
  const byId = (id: number) => got.filter((g) => g.id === id);
  const next = async (id: number, timeout = 3000) => {
    const before = byId(id).length;
    await waitFor(() => byId(id).length > before, timeout, `packet ${id}`);
    return byId(id)[before].data;
  };
  const first = async (id: number, timeout = 3000) => {
    await waitFor(() => byId(id).length > 0, timeout, `packet ${id}`);
    return byId(id)[0].data;
  };
  return { got, byId, next, first };
}

/**
 * UDP proxy between clients and an upstream server that drops a share of datagrams
 * (both directions) using a seeded PRNG, so loss tests are reproducible.
 */
export async function startLossyProxy(listenPort: number, upstreamPort: number, lossRate: number, seed = 1) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  const stats = { forwarded: 0, dropped: 0 };
  const front = createSocket('udp4');
  const upstreams = new Map<string, Socket>();

  front.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let up = upstreams.get(key);
    if (!up) {
      up = createSocket('udp4');
      up.on('message', (back: Buffer) => {
        if (rand() < lossRate) return void stats.dropped++;
        stats.forwarded++;
        front.send(back, rinfo.port, rinfo.address);
      });
      upstreams.set(key, up);
    }
    if (rand() < lossRate) return void stats.dropped++;
    stats.forwarded++;
    up.send(msg, upstreamPort, '127.0.0.1');
  });
  await new Promise<void>((r) => front.bind(listenPort, '127.0.0.1', r));

  return {
    stats,
    close: () => {
      for (const u of upstreams.values()) u.close();
      front.close();
    },
  };
}

/** Raw UDP socket for sending garbage / hand-built datagrams. */
export async function rawSocket() {
  const sock = createSocket('udp4');
  const got: Buffer[] = [];
  sock.on('message', (m) => got.push(m));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return {
    sock, got,
    send: (buf: Buffer, port: number) => new Promise<void>((r) => sock.send(buf, port, '127.0.0.1', () => r())),
    close: () => sock.close(),
  };
}

/** Hand-builds a datagram in Razor (no trailing \0) or legacy (trailing \0) format. */
export function buildDatagram(uniqueId: number, packetId: number, priority: number, payload: Buffer, trailingZero = false) {
  const h = Buffer.alloc(10);
  h[0] = 0;
  h.writeUInt32LE(uniqueId, 1);
  h.writeUInt32LE(packetId, 5);
  h.writeUInt8(priority, 9);
  return Buffer.concat([h, payload, trailingZero ? Buffer.from([0]) : Buffer.alloc(0)]);
}

export async function startNodeServer(port: number, opts: ConstructorParameters<typeof Server>[0] = {}) {
  const server = new Server({ port, ipVersion: 'v4', address: '127.0.0.1', ...opts });
  await server.listen();
  return server;
}

export async function startNodeClient(port: number, opts: ConstructorParameters<typeof Client>[0] = {}) {
  const client = new Client({ port, ipVersion: 'v4', address: '127.0.0.1', ...opts });
  await client.connect();
  return client;
}

export async function closeAll(...things: ({ stop(): Promise<void> } | { disconnect(): Promise<void> } | { close(): void } | undefined)[]) {
  for (const t of things) {
    if (!t) continue;
    try {
      if ('stop' in t) await t.stop();
      else if ('disconnect' in t) await t.disconnect();
      else t.close();
    } catch { /* already closed */ }
  }
}
