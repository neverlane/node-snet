import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { BitStream } from './bitstream';
import { decodePacket, encodePacket, type SNetPacketStruct } from './net-utils';
import {
  SNET_CONFIRM_PRIORITY, SNET_PRIORITIES, SNET_RESEND_LIMITS, type IpVersion,
} from './types';

export interface PeerOptions {
  address?: string;
  port?: number;
  ipVersion?: IpVersion;
  /** max payload size in bytes (incoming bigger packets are dropped, outgoing throw) */
  maxTransferBytes?: number;
  /** internal loop interval, ms */
  tickTimeout?: number;
  /** delay before an unconfirmed packet is re-sent, ms */
  resendInterval?: number;
  /** OS socket buffers, bytes (capped by the OS, e.g. net.core.rmem_max) */
  recvBufferSize?: number;
  sendBufferSize?: number;
  /** how long a received uniqueId is remembered to drop duplicates, ms */
  dedupTtl?: number;
  /** max remembered uniqueIds per remote */
  dedupSize?: number;
  /** talk to SLMP-Team SNET / node-snet 1.x (trailing 0x00 after every packet) */
  legacyTerminator?: boolean;
}

export interface PendingPacket {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITIES;
  payload: Buffer;
  address: string;
  port: number;
  /** times re-sent */
  times: number;
  lastTime: number;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

export class PacketLostError extends Error {
  constructor(public packet: Readonly<PendingPacket>) {
    super(`snet: packet ${packet.packetId} (uniqueId ${packet.uniqueId}) was not confirmed`);
    this.name = 'PacketLostError';
  }
}

/** remembers recently seen uniqueIds of one remote */
class DedupWindow {
  private seen = new Map<number, number>();
  constructor(private ttl: number, private size: number) {}

  /** true if already seen */
  check(id: number, now: number): boolean {
    for (const [k, t] of this.seen) {
      if (now - t < this.ttl && this.seen.size <= this.size) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

const DEFAULTS = {
  port: 13322,
  maxTransferBytes: 1400,
  tickTimeout: 50,
  resendInterval: 500,
  recvBufferSize: 4 * 1024 * 1024,
  sendBufferSize: 4 * 1024 * 1024,
  dedupTtl: 60_000,
  dedupSize: 4096,
};

const MAX_UNIQUE_ID = 0xFFFFFFFF;

/** shared reliability layer of Client and Server */
export abstract class Peer extends EventEmitter {
  public address: string;
  public port: number;
  public ipVersion: IpVersion;
  public maxTransferBytes: number;
  public tickTimeout: number;
  public resendInterval: number;
  public legacyTerminator: boolean;
  public socket: Socket;

  protected uniqueId = 0;
  /** unconfirmed packets by uniqueId */
  protected pending = new Map<number, PendingPacket>();
  private dedup = new Map<string, DedupWindow>();
  private dedupTtl: number;
  private dedupSize: number;
  private tickLoop?: NodeJS.Timeout;

  constructor(opts: PeerOptions = {}) {
    super();
    this.ipVersion = opts.ipVersion ?? (opts.address?.includes(':') ? 'v6' : 'v4');
    this.address = opts.address || (this.ipVersion === 'v4' ? '127.0.0.1' : '::1');
    this.port = opts.port ?? DEFAULTS.port;
    this.maxTransferBytes = opts.maxTransferBytes ?? DEFAULTS.maxTransferBytes;
    this.tickTimeout = opts.tickTimeout ?? DEFAULTS.tickTimeout;
    this.resendInterval = opts.resendInterval ?? DEFAULTS.resendInterval;
    this.legacyTerminator = opts.legacyTerminator ?? false;
    this.dedupTtl = opts.dedupTtl ?? DEFAULTS.dedupTtl;
    this.dedupSize = opts.dedupSize ?? DEFAULTS.dedupSize;

    this.socket = createSocket({
      type: this.ipVersion === 'v4' ? 'udp4' : 'udp6',
      recvBufferSize: opts.recvBufferSize ?? DEFAULTS.recvBufferSize,
      sendBufferSize: opts.sendBufferSize ?? DEFAULTS.sendBufferSize,
    });
    this.socket.on('message', (buf, rinfo) => this.onDatagram(buf, rinfo.address, rinfo.port));
    this.socket.on('close', () => {
      this.stopTickLoop();
      this.failAllPending();
      this.emit('close');
    });
    this.socket.on('error', (err: NodeJS.ErrnoException) => {
      // ICMP "port unreachable" on a connected UDP socket is normal for UDP, not fatal
      if (err.code === 'ECONNREFUSED') return;
      this.emit('error', err);
    });
  }

  /** unconfirmed packets count */
  get pendingCount(): number { return this.pending.size; }
  /** @deprecated v1 internal, use pendingCount */
  get packets(): PendingPacket[] { return [...this.pending.values()]; }

  // ------------------------------------------------------------ to implement

  /** called for every valid non-duplicate packet that is not a confirmation */
  protected abstract onPacket(packet: SNetPacketStruct, address: string, port: number): void;
  /** called before parsing; return false to drop */
  protected accept(_address: string, _port: number): boolean { return true; }
  /** called each tick */
  protected onTick(_now: number): void {}
  /** may the SYSTEM packet still be re-sent */
  protected abstract isRemoteAlive(address: string, port: number): boolean;

  // ------------------------------------------------------------ sending

  protected nextUniqueId(): number {
    const id = this.uniqueId;
    this.uniqueId = id + 1 >= MAX_UNIQUE_ID ? 0 : id + 1;
    return id;
  }

  protected writeDatagram(uniqueId: number, packetId: number, priority: SNET_PRIORITIES, payload: Uint8Array, address: string, port: number) {
    this.socket.send(encodePacket(uniqueId, packetId, priority, payload, this.legacyTerminator), port, address);
  }

  protected sendTo(
    packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES, address: string, port: number,
    track?: Pick<PendingPacket, 'resolve' | 'reject'>,
  ): number {
    checkPacketId(packetId);
    checkPriority(priority);
    const payload = Buffer.from(bs instanceof BitStream ? bs.getBuffer() : bs);
    if (payload.length > this.maxTransferBytes) {
      throw new RangeError(`snet: payload is ${payload.length} bytes, maxTransferBytes is ${this.maxTransferBytes}`);
    }
    const uniqueId = this.nextUniqueId();
    this.writeDatagram(uniqueId, packetId, priority, payload, address, port);
    if (priority > SNET_PRIORITIES.BYPASS) {
      this.pending.set(uniqueId, {
        uniqueId, packetId, priority, payload, address, port,
        times: 0, lastTime: Date.now(), ...track,
      });
      this.ensureTickLoop();
    } else {
      track?.resolve?.();
    }
    return uniqueId;
  }

  protected sendToAsync(packetId: number, bs: BitStream | Uint8Array, priority: SNET_PRIORITIES, address: string, port: number) {
    return new Promise<void>((resolve, reject) => {
      try {
        this.sendTo(packetId, bs, priority, address, port, { resolve, reject });
      } catch (e) {
        reject(e);
      }
    });
  }

  private confirm(uniqueId: number, address: string, port: number) {
    const ack = Buffer.allocUnsafe(4);
    ack.writeUInt32LE(uniqueId >>> 0);
    this.writeDatagram(this.nextUniqueId(), SNET_CONFIRM_PRIORITY, SNET_PRIORITIES.BYPASS, ack, address, port);
  }

  // ------------------------------------------------------------ receiving

  private onDatagram(buf: Buffer, address: string, port: number) {
    if (!this.accept(address, port)) return;
    const packet = decodePacket(buf, this.legacyTerminator);
    if (!packet || packet.payload.length > this.maxTransferBytes) return;
    this.touch(address, port);

    if (packet.packetId === SNET_CONFIRM_PRIORITY) {
      if (packet.payload.length >= 4) {
        const id = packet.payload.readUInt32LE(0);
        const p = this.pending.get(id);
        if (p && p.port === port && sameAddress(p.address, address)) {
          this.pending.delete(id);
          p.resolve?.();
        }
      }
      return;
    }

    if (packet.priority > SNET_PRIORITIES.BYPASS) {
      // always confirm, even duplicates: the previous confirmation may have been lost
      this.confirm(packet.uniqueId, address, port);
      if (this.dedupFor(address, port).check(packet.uniqueId, Date.now())) return;
    }

    this.onPacket(packet, address, port);
  }

  /** remote sent something (used for timeouts) */
  protected touch(_address: string, _port: number) {}

  private dedupFor(address: string, port: number) {
    const key = `${address}:${port}`;
    let w = this.dedup.get(key);
    if (!w) this.dedup.set(key, (w = new DedupWindow(this.dedupTtl, this.dedupSize)));
    return w;
  }

  protected forgetRemote(address: string, port: number) {
    this.dedup.delete(`${address}:${port}`);
    for (const [id, p] of this.pending) {
      if (p.port === port && sameAddress(p.address, address) && p.priority === SNET_PRIORITIES.SYSTEM) {
        this.pending.delete(id);
        this.lost(p);
      }
    }
  }

  // ------------------------------------------------------------ loop

  protected ensureTickLoop() {
    if (this.tickLoop) return;
    this.tickLoop = setInterval(() => this.tick(), this.tickTimeout);
    this.tickLoop.unref?.();
  }

  protected startTickLoop() {
    this.ensureTickLoop();
    this.tickLoop?.ref?.();
  }

  protected stopTickLoop() {
    if (this.tickLoop) clearInterval(this.tickLoop);
    this.tickLoop = undefined;
  }

  private tick() {
    const now = Date.now();
    this.onTick(now);
    this.resendPackets(now);
  }

  private resendPackets(now: number) {
    for (const [id, p] of this.pending) {
      if (now - p.lastTime < this.resendInterval) continue;
      if (p.priority === SNET_PRIORITIES.SYSTEM && !this.isRemoteAlive(p.address, p.port)) {
        this.pending.delete(id);
        this.lost(p);
        continue;
      }
      p.lastTime = now;
      p.times++;
      this.writeDatagram(p.uniqueId, p.packetId, p.priority, p.payload, p.address, p.port);
      if (p.times >= (SNET_RESEND_LIMITS[p.priority] ?? SNET_RESEND_LIMITS[SNET_PRIORITIES.HIGH])) {
        this.pending.delete(id);
        this.lost(p);
      }
    }
  }

  private lost(p: PendingPacket) {
    this.emit('packetLost', p.packetId, p.uniqueId, p.priority, p.address, p.port);
    p.reject?.(new PacketLostError(p));
  }

  private failAllPending() {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject?.(new PacketLostError(p));
  }

  protected closeSocket(): Promise<void> {
    return new Promise((res) => {
      try {
        this.socket.close(() => res());
      } catch {
        res(); // already closed
      }
    });
  }
}

const sameAddress = (a: string, b: string) => a === b || a.replace(/^::ffff:/, '') === b.replace(/^::ffff:/, '');

const checkPacketId = (id: number) => {
  if (!Number.isInteger(id) || id < 0 || id > 0xFFFFFFFF) throw new RangeError(`snet: invalid packet id ${id}`);
};
const checkPriority = (p: number) => {
  if (!Number.isInteger(p) || p < 0 || p > 0xff) throw new RangeError(`snet: invalid priority ${p}`);
};
