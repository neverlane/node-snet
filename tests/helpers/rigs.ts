import { BitStream, Client, Server, SNET_PRIORITES } from '../../src';
import { LuaPeer } from './lua';
import {
  attachNodePeer, closeAll, collect, getPort, PKT, startLossyProxy,
  startNodeClient, startNodeServer, waitFor,
} from './net';

export type Impl = 'node' | 'lua';

/**
 * A pair where the side under our control is always node-snet ("local"), and the other side
 * ("remote") is either node-snet (with the same control handlers as peer.lua) or Lua SNET.
 */
export interface Rig {
  name: string;
  local: Server | Client;
  /** send from local to remote */
  send(id: number, bs: BitStream, priority: SNET_PRIORITES): void;
  inbox: ReturnType<typeof collect>;
  lua?: LuaPeer;
  proxy?: Awaited<ReturnType<typeof startLossyProxy>>;
  stop(): Promise<void>;
}

export interface RigOptions {
  /** which role the local node-snet side plays */
  localRole: 'server' | 'client';
  remote: Impl;
  /** drop rate of a proxy placed between client and server (0 = direct) */
  loss?: number;
  /** OS receive buffer of the lua peer (see LuaPeer.start) */
  luaRcvbuf?: number;
}

export const rigName = ({ localRole, remote, loss }: RigOptions) => {
  const server = localRole === 'server' ? 'node' : remote;
  const client = localRole === 'client' ? 'node' : remote;
  return `${server} server <-> ${client} client${loss ? ` (${loss * 100}% loss)` : ''}`;
};

export async function makeRig(opts: RigOptions): Promise<Rig> {
  const { localRole, remote, loss = 0, luaRcvbuf } = opts;
  const serverPort = getPort();
  const proxyPort = loss ? getPort() : serverPort;
  const name = rigName(opts);
  const toStop: Parameters<typeof closeAll> = [];

  let proxy: Rig['proxy'];
  if (loss) {
    proxy = await startLossyProxy(proxyPort, serverPort, loss);
  }

  try {
    if (localRole === 'client') {
      // remote server, local node client
      let lua: LuaPeer | undefined;
      let remoteServer: Server | undefined;
      if (remote === 'lua') lua = await LuaPeer.start('server', serverPort, { rcvbuf: luaRcvbuf });
      else attachNodePeer((remoteServer = await startNodeServer(serverPort)));

      const local = await startNodeClient(proxyPort);
      const inbox = collect(local);
      toStop.push(local, remoteServer, lua, proxy);
      return {
        name, local, inbox, lua, proxy,
        send: (id, bs, pr) => local.send(id, bs, pr),
        stop: () => closeAll(...toStop),
      };
    }

    // local node server, remote client
    const local = await startNodeServer(serverPort);
    const inbox = collect(local);
    let lua: LuaPeer | undefined;
    let remoteClient: Client | undefined;
    if (remote === 'lua') {
      lua = await LuaPeer.start('client', proxyPort, { rcvbuf: luaRcvbuf }); // lua client sends HELLO by itself
    } else {
      remoteClient = await startNodeClient(proxyPort);
      attachNodePeer(remoteClient);
      remoteClient.send(PKT.HELLO, new BitStream().writeBytes(Buffer.from('node')), SNET_PRIORITES.HIGH);
    }
    toStop.push(remoteClient, lua, local, proxy);

    // learn where the remote client is from its HELLO
    await waitFor(() => inbox.byId(PKT.HELLO).length > 0, 5000, `${name}: HELLO`);
    const { address, port } = inbox.byId(PKT.HELLO)[0];
    return {
      name, local, inbox, lua, proxy,
      send: (id, bs, pr) => local.send(id, bs, pr, address!, port!),
      stop: () => closeAll(...toStop),
    };
  } catch (e) {
    await closeAll(...toStop, proxy);
    throw e;
  }
}

/** Sends STATS until the reply stops changing (or matches `until`). */
export async function remoteStats(rig: Rig, until?: (s: { pending: number; loadUnique: number; loadTotal: number }) => boolean, timeout = 10000) {
  const start = Date.now();
  let last: { pending: number; loadUnique: number; loadTotal: number } | undefined;
  while (Date.now() - start < timeout) {
    const before = rig.inbox.byId(PKT.STATS_REPLY).length;
    rig.send(PKT.STATS, new BitStream(), SNET_PRIORITES.BYPASS);
    try {
      await waitFor(() => rig.inbox.byId(PKT.STATS_REPLY).length > before, 500);
    } catch { continue; } // stats request/reply itself can be lost
    const bs = BitStream.from(rig.inbox.byId(PKT.STATS_REPLY)[before].data);
    const s = { pending: bs.readUInt32(), loadUnique: bs.readUInt32(), loadTotal: bs.readUInt32() };
    if (until?.(s)) return s;
    if (!until && last && last.loadTotal === s.loadTotal && last.pending === s.pending) return s;
    last = s;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (last) return last;
  throw new Error(`${rig.name}: no STATS reply`);
}

export const pendingOf = (peer: Server | Client): number => peer.pendingCount;
