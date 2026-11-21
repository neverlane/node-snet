import { BitStream } from './bitstream';
import { encodePacket, type SNetPacketStruct } from './net-utils';
import { Peer, type PeerOptions } from './peer';
import type { ITypedEmitter } from './typed-emitter';
import { SNET_BLOCK_PACKET, SNET_PRIORITIES, SNET_STATUSES } from './types';

export interface ClientOptions extends PeerOptions {
  /** no packets from the server for this long -> status DISCONNECTED + 'timeout' event, ms */
  timeout?: number;
}

export type ClientReceivePacketEvent = (packetId: number, bs: BitStream) => unknown;
const clientReceivePacketEvents = ['receivePacket', 'onReceivePacket'] as const;

export interface ClientEvents {
  receivePacket: ClientReceivePacketEvent;
  /** alias of receivePacket (Lua SNET name) */
  onReceivePacket: ClientReceivePacketEvent;
  ready: () => unknown;
  close: () => unknown;
  error: (err: Error) => unknown;
  /** server answered for the first time (or again after a timeout) */
  connected: () => unknown;
  /** no packets from the server for `timeout` ms */
  timeout: () => unknown;
  /** server blacklisted us (SNET_BLOCK_PACKET) */
  blocked: () => unknown;
  /** a reliable packet was dropped after all resends */
  packetLost: (packetId: number, uniqueId: number, priority: SNET_PRIORITIES) => unknown;
}

export class Client extends (Peer as unknown as abstract new (opts?: PeerOptions) => Peer & ITypedEmitter<ClientEvents>) {
  public status: SNET_STATUSES = SNET_STATUSES.DISCONNECTED;
  public timeout: number;
  /** last time anything came from the server */
  public lastReceived = 0;

  constructor(opts: ClientOptions = {}) {
    super(opts);
    this.timeout = opts.timeout ?? 60_000;
    this.socket.on('connect', () => {
      this.startTickLoop();
      this.emit('ready');
    });
  }

  public connect(port?: number, address?: string): Promise<void> {
    this.port = port ?? this.port;
    this.address = address ?? this.address;
    return new Promise<void>((res, rej) => {
      const onError = (err: Error) => rej(err);
      this.socket.once('error', onError);
      this.socket.connect(this.port, this.address, () => {
        this.socket.off('error', onError);
        res();
      });
    });
  }

  public disconnect(): Promise<void> {
    this.status = SNET_STATUSES.DISCONNECTED;
    return this.closeSocket();
  }

  /** returns the uniqueId of the packet */
  public send(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES = SNET_PRIORITIES.BYPASS): number {
    return this.sendTo(packetId, bs, priority, this.address, this.port);
  }

  /** resolves when the server confirms the packet (immediately for BYPASS), rejects with PacketLostError */
  public sendAsync(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES = SNET_PRIORITIES.HIGH): Promise<void> {
    return this.sendToAsync(packetId, bs, priority, this.address, this.port);
  }

  protected override writeDatagram(uniqueId: number, packetId: number, priority: SNET_PRIORITIES, payload: Uint8Array) {
    // connected socket: no address
    this.socket.send(encodePacket(uniqueId, packetId, priority, payload, this.legacyTerminator));
  }

  protected override touch() {
    this.lastReceived = Date.now();
    if (this.status !== SNET_STATUSES.CONNECTED) {
      this.status = SNET_STATUSES.CONNECTED;
      this.emit('connected');
    }
  }

  protected override isRemoteAlive() {
    return this.status === SNET_STATUSES.CONNECTED;
  }

  protected override onTick(now: number) {
    if (this.status === SNET_STATUSES.CONNECTED && now - this.lastReceived >= this.timeout) {
      this.status = SNET_STATUSES.DISCONNECTED;
      this.forgetRemote(this.address, this.port);
      this.emit('timeout');
    }
  }

  protected override onPacket(packet: SNetPacketStruct) {
    if (packet.packetId === SNET_BLOCK_PACKET) {
      this.emit('blocked');
      return;
    }
    for (const event of clientReceivePacketEvents) {
      if (this.listenerCount(event)) this.emit(event, packet.packetId, BitStream.from(packet.payload));
    }
  }
}
