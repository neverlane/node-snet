import { BitStream } from './bitstream';
import type { SNetPacketStruct } from './net-utils';
import { Peer, type PeerOptions } from './peer';
import type { ITypedEmitter } from './typed-emitter';
import { SNET_BLOCK_PACKET, SNET_PRIORITIES, type SupportedEventNames } from './types';

export interface ServerOptions extends PeerOptions {
  /** client is dropped after this long without packets, ms */
  clientTimeout?: number;
  /** how often a blocked address is notified with SNET_BLOCK_PACKET, ms */
  blockPacketTimeout?: number;
}

export type ServerClientUpdateEvent = (address: string, port: number, type: 'connect' | 'timeout') => unknown;
export type ServerReceivePacketEvent = (packetId: number, bs: BitStream, address: string, port: number, client: ServerClient) => unknown;

const serverReceivePacketEvents: SupportedEventNames<'receivePacket'>[] = ['receivePacket', 'onReceivePacket'];
const serverClientUpdateEvents: SupportedEventNames<'clientUpdate'>[] = ['clientUpdate', 'onClientUpdate'];

export interface ServerEvents
  extends Record<SupportedEventNames<'clientUpdate'>, ServerClientUpdateEvent>,
  Record<SupportedEventNames<'receivePacket'>, ServerReceivePacketEvent> {
  ready: () => unknown;
  close: () => unknown;
  error: (err: Error) => unknown;
  connect: (client: ServerClient) => unknown;
  timeout: (client: ServerClient) => unknown;
  packetLost: (packetId: number, uniqueId: number, priority: SNET_PRIORITIES, address: string, port: number) => unknown;
}

/** a remote client as seen by the server */
export class ServerClient {
  public readonly connectedAt = Date.now();
  public lastSeen = Date.now();

  constructor(private server: Server, public readonly address: string, public readonly port: number) {}

  get key() { return `${this.address}:${this.port}`; }

  send(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES = SNET_PRIORITIES.BYPASS) {
    return this.server.send(packetId, bs, priority, this.address, this.port);
  }

  sendAsync(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES = SNET_PRIORITIES.HIGH) {
    return this.server.sendAsync(packetId, bs, priority, this.address, this.port);
  }

  /** forget the client (no event); it reconnects on its next packet */
  kick() { this.server.dropClient(this); }
}

export class Server extends (Peer as unknown as abstract new (opts?: PeerOptions) => Peer & ITypedEmitter<ServerEvents>) {
  public clientTimeout: number;
  public blockPacketTimeout: number;
  /** connected clients by `address:port` */
  public clients = new Map<string, ServerClient>();
  /** blocked address -> next time it is notified */
  public blacklist = new Map<string, number>();

  constructor(opts: ServerOptions = {}) {
    super(opts);
    this.clientTimeout = opts.clientTimeout ?? 60_000;
    this.blockPacketTimeout = opts.blockPacketTimeout ?? 60_000;
    this.socket.on('listening', () => {
      this.startTickLoop();
      this.emit('ready');
    });
  }

  public listen(port?: number, address?: string): Promise<void> {
    this.port = port ?? this.port;
    this.address = address ?? this.address;
    return new Promise<void>((res, rej) => {
      const onError = (err: Error) => rej(err);
      this.socket.once('error', onError);
      this.socket.bind(this.port, this.address, () => {
        this.socket.off('error', onError);
        res();
      });
    });
  }

  public stop(): Promise<void> {
    return this.closeSocket();
  }

  // ------------------------------------------------------------ blacklist

  public isBlacklisted(address: string): boolean {
    return this.blacklist.has(address);
  }

  public blockAddress(address: string): boolean {
    if (this.blacklist.has(address)) return false;
    this.blacklist.set(address, 0);
    for (const c of [...this.clients.values()]) if (c.address === address) this.dropClient(c);
    return true;
  }

  public unblockAddress(address: string): boolean {
    return this.blacklist.delete(address);
  }

  // ------------------------------------------------------------ sending

  /** returns the uniqueId of the packet */
  public send(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES, address: string, port: number): number {
    return this.sendTo(packetId, bs, priority, address, port);
  }

  /** resolves when the client confirms the packet (immediately for BYPASS), rejects with PacketLostError */
  public sendAsync(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES, address: string, port: number): Promise<void> {
    return this.sendToAsync(packetId, bs, priority, address, port);
  }

  public sendAll(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES, except?: ServerClient | ServerClient[]) {
    const skip = new Set(Array.isArray(except) ? except : except ? [except] : []);
    for (const client of this.clients.values()) {
      if (!skip.has(client)) this.send(packetId, bs, priority, client.address, client.port);
    }
  }

  public getClient(address: string, port: number): ServerClient | undefined {
    return this.clients.get(`${address}:${port}`);
  }

  public parseAddress(addressAndPort: string): [string, number] | null {
    const matched = addressAndPort.match(/^\[?(.+?)\]?:(\d+)$/);
    return matched ? [matched[1], +matched[2]] : null;
  }

  /** @internal */
  public dropClient(client: ServerClient) {
    if (this.clients.get(client.key) !== client) return;
    this.clients.delete(client.key);
    this.forgetRemote(client.address, client.port);
  }

  // ------------------------------------------------------------ peer hooks

  protected override accept(address: string, port: number): boolean {
    if (!this.blacklist.has(address)) return true;
    const now = Date.now();
    if (now >= this.blacklist.get(address)!) {
      this.blacklist.set(address, now + this.blockPacketTimeout);
      this.send(SNET_BLOCK_PACKET, new BitStream(), SNET_PRIORITIES.BYPASS, address, port);
    }
    return false;
  }

  protected override touch(address: string, port: number) {
    const key = `${address}:${port}`;
    const existing = this.clients.get(key);
    if (existing) {
      existing.lastSeen = Date.now();
      return;
    }
    const client = new ServerClient(this, address, port);
    this.clients.set(key, client);
    for (const event of serverClientUpdateEvents) this.emit(event, address, port, 'connect');
    this.emit('connect', client);
  }

  protected override isRemoteAlive(address: string, port: number) {
    return this.clients.has(`${address}:${port}`);
  }

  protected override onTick(now: number) {
    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeen < this.clientTimeout) continue;
      this.dropClient(client);
      for (const event of serverClientUpdateEvents) this.emit(event, client.address, client.port, 'timeout');
      this.emit('timeout', client);
    }
  }

  protected override onPacket(packet: SNetPacketStruct, address: string, port: number) {
    const client = this.clients.get(`${address}:${port}`)!;
    for (const event of serverReceivePacketEvents) {
      if (this.listenerCount(event)) this.emit(event, packet.packetId, BitStream.from(packet.payload), address, port, client);
    }
  }
}
