import { createSocket, Socket } from 'dgram';
import { TypedEmitter } from 'tiny-typed-emitter';
import { BitStream } from './bitstream';
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

  private sendPacket(uniqueId: number, packetId: number, priority: SNET_PRIORITES, bs: BitStream) {
    const data = new BitStream();
    data.writeUInt32(uniqueId);
    data.writeUInt32(packetId);
    data.writeUInt8(priority);
    const EMPTY = Buffer.from([0x0]);
    const bytes = Buffer.concat([EMPTY, data.getBuffer(), bs.getBuffer(), EMPTY]);
    this.socket.send(bytes, this.port, this.address);
  }

  public send(packetId: number, bs: BitStream, priority: SNET_PRIORITES) {
    const uniqueId = this.uniqueId;
    this.uniqueId++;
    if (this.uniqueId >= 4294967295) {
      this.uniqueId = 0;
    }
    this.sendPacket(uniqueId, packetId, priority, bs);
    if (priority > 0) {
      this.packets.push({
        uniqueId, packetId,
        priority, bs,
        times: 0, lastTime: Date.now()
      });
    }
  }

  private receivePacket(buffer: Buffer) {
    if (buffer[0] !== 0x0) return false;
    const data = Uint8Array.prototype.slice.call(buffer, 1);
    
    let offset = 0;
    const uniqueId = data.readUInt32LE(offset);
    offset += 4;
    const packetId = data.readUInt32LE(offset);
    offset += 4;
    const priority = data.readUInt8(offset);
    const cleanData = Uint8Array.prototype.slice.call(data, 9);
    
    if (priority > 0) {
      const newBs = new BitStream();
      newBs.writeUInt32(uniqueId);
      this.send(SNET_CONFIRM_PRIORITY, newBs, SNET_PRIORITES.BYPASS);
    }
    if (this.lastIds.includes(uniqueId)) return false;
  
    if (this.lastIds.length >= 10) this.lastIds.shift();
    this.lastIds.push(uniqueId);

    this.status = SNET_STATUSES.CONNECTED;
    this.emit('onReceivePacket', packetId, BitStream.from(cleanData));

    if (packetId === SNET_CONFIRM_PRIORITY) {
      const confBs = BitStream.from(cleanData);
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

        this.sendPacket(v.uniqueId, v.packetId, v.priority, v.bs);

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