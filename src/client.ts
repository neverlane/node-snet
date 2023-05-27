import { createSocket, Socket } from 'dgram';
import { TypedEmitter } from './typed-emitter';
import { BitStream } from './bitstream';
import { getPacket, sendPacket } from './net-utils';
import { SNET_CONFIRM_PRIORITY, SNET_PRIORITES, SNET_STATUSES } from './types';

export interface ClientOptions {
  address?: string;
  port?: number;
  maxTransferBytes?: number;
}

export interface ClientEvents {
  'onReceivePacket': (packetId: number, bs: BitStream) => unknown;
  'ready': () => unknown;
  'close': () => unknown;
  'error': (err: Error) => unknown;
}

export interface ClientPacket {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITES;
  bs: BitStream;
  lastTime: number;
  times: number;
}

export class Client extends TypedEmitter<ClientEvents> {
  public address: string = '127.0.0.1';
  public port: number = 13322;
  public maxTransferBytes: number = 512;
  public status: SNET_STATUSES = SNET_STATUSES.DISCONNECTED;
  private uniqueId: number = 0;
  private lastIds: number[] = [];
  private packets: ClientPacket[] = [];
  public socket: Socket;

  constructor({ address, port, maxTransferBytes }: ClientOptions = {}) {
    super();
    if (address) this.address = address;
    if (port) this.port = port;
    if (maxTransferBytes) this.maxTransferBytes = maxTransferBytes;
    this.socket = createSocket({
      type: 'udp4',
      // TODO: try fix this
      recvBufferSize: this.maxTransferBytes,
      sendBufferSize: this.maxTransferBytes
    });
    this.socket.on('connect', () => this.emit('ready'));
    this.socket.on('message', (buffer) => this.receivePacket(buffer));
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));
    const tick = () => setTimeout(() => {
      this.tick();
      tick();
    }, 50);
    tick();
  }

  public connect(): Promise<void>
  public connect(port: number): Promise<void>
  public connect(port: number, address: string): Promise<void>
  public connect(port?: number, address?: string): Promise<void> {
    return new Promise<void>((res) => {
      this.port = port ?? this.port;
      this.address = address ?? this.address;
      this.socket.connect(this.port, this.address, res);
    });
  }

  public disconnect() {
    return new Promise<void>(res => this.socket.close(res));
  }

  private tick() {
    this.resendPackets();
  }

  public send(packetId: number, bs: BitStream, priority: SNET_PRIORITES) {
    if (bs.length > this.maxTransferBytes) return;
    const uniqueId = this.uniqueId;
    this.uniqueId++;
    if (this.uniqueId >= 4294967295) {
      this.uniqueId = 0;
    }
    sendPacket(this.socket, uniqueId, packetId, priority, bs, this.address, this.port);
    if (priority > 0) {
      this.packets.push({
        uniqueId, packetId,
        priority, bs,
        times: 0, lastTime: Date.now()
      });
    }
  }

  private receivePacket(buffer: Buffer) {
    const packet = getPacket(buffer);
    if (packet === false) return false;
    const { uniqueId, packetId, priority, data } = packet;
    if (data.length > this.maxTransferBytes) return;
    if (priority > 0) {
      const newBs = new BitStream();
      newBs.writeUInt32(uniqueId);
      this.send(SNET_CONFIRM_PRIORITY, newBs, SNET_PRIORITES.BYPASS);
    }
    if (this.lastIds.includes(uniqueId)) return false;
  
    if (this.lastIds.length >= 10) this.lastIds.shift();
    this.lastIds.push(uniqueId);

    this.status = SNET_STATUSES.CONNECTED;
    this.emit('onReceivePacket', packetId, BitStream.from(data));

    if (packetId === SNET_CONFIRM_PRIORITY) {
      const confBs = BitStream.from(data);
      const confId = confBs.readUInt32();
      const idx = this.packets.findIndex((v) => v.uniqueId === confId);
      if (idx > -1) {
        const before = this.packets.slice(0, idx);
        const after = this.packets.slice(idx+1);
        this.packets = [...before, ...after];
      }
    }
  }

  private resendPackets() {
    const _packets: ClientPacket[] = [];
    for (let i = this.packets.length; i >= 0; i--) {
      const v = this.packets[i];
      if (!v) continue;
      if (Date.now() - v.lastTime >= 500) {
        v.lastTime = Date.now();
        v.times++;

        sendPacket(this.socket, v.uniqueId, v.packetId, v.priority, v.bs, this.address, this.port);

        if (v.priority === SNET_PRIORITES.SYSTEM && this.status !== SNET_STATUSES.CONNECTED)
          continue;
        else if (v.priority === SNET_PRIORITES.HIGH && v.times >= 20)
          continue;
        else if (v.priority === SNET_PRIORITES.MEDIUM && v.times >= 10)
          continue;
        else if (v.priority === SNET_PRIORITES.LOW && v.times >= 5)
          continue;        
      }
      _packets.push(v);
    }
    this.packets = _packets;
  }
}