import { createSocket, Socket } from 'dgram';
import { TypedEmitter } from './typed-emitter';
import { BitStream } from './bitstream';
import { getPacket, sendPacket } from './net-utils';
import { SNET_CONFIRM_PRIORITY, SNET_PRIORITES, SNET_STATUSES } from './types';

export interface ClientOptions {
  address?: string;
  port?: number;
}

export interface SNetClientEvents {
  'onReceivePacket': (packetId: number, bs: BitStream) => unknown;
  'ready': () => unknown;
}

export interface SNetClientPacket {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITES;
  bs: BitStream;
  lastTime: number;
  times: number;
}

export class SNetClient extends TypedEmitter<SNetClientEvents> {
  public address: string = '127.0.0.1';
  public port: number = 13322;
  public status: SNET_STATUSES = SNET_STATUSES.DISCONNECTED;
  private uniqueId: number = 0;
  private lastIds: number[] = [];
  private packets: SNetClientPacket[] = [];
  private socket: Socket;

  constructor({ address, port }: ClientOptions) {
    super();
    if (address) this.address = address;
    if (port) this.port = port;
    this.socket = createSocket('udp4');
    this.socket.connect(this.port, this.address);
    this.socket.on('message', (buffer) => this.receivePacket(buffer));
    this.socket.on('connect', () => this.emit('ready'));
    const tick = () => setTimeout(() => {
      this.tick();
      tick();
    }, 50);
    tick();
  }

  private tick() {
    this.resendPackets();
  }

  public send(packetId: number, bs: BitStream, priority: SNET_PRIORITES) {
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
    const _packets: SNetClientPacket[] = [];
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