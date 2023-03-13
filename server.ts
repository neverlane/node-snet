import { createSocket, Socket } from 'dgram';
import { TypedEmitter } from 'tiny-typed-emitter';
import { BitStream } from './bitstream';
import { SNET_BLOCK_PACKET, SNET_CONFIRM_PRIORITY, SNET_PRIORITES } from './types';

export interface ServerOptions {
  address?: string;
  port?: number;
}

export interface SNetServerEvents {
  'onReceivePacket': (packetId: number, bs: BitStream, address: string, port: number) => unknown;
  'onClientUpdate': (address: string, port: number, type: 'connect' | 'timeout') => unknown;
  'ready': () => unknown;
}

export interface SNetServerPacket {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITES;
  bs: BitStream;
  lastTime: number;
  times: number;
  address: string;
  port: number;
}

export class SNetServer extends TypedEmitter<SNetServerEvents> {
  public address: string = '0.0.0.0';
  public port: number = 13322;
  private uniqueId: number = 0;
  private lastIds: Record<string, number[]> = {};
  private packets: SNetServerPacket[] = [];
  private socket: Socket;
  public clients: Record<string, number> = {};
  public blacklist: [string, number][] = [];

  constructor({ address, port }: ServerOptions) {
    super();
    if (address) this.address = address;
    if (port) this.port = port;
    this.socket = createSocket('udp4');
    this.socket.bind(this.port, this.address, () => this.emit('ready'));
    this.socket.on('message', (buffer, rinfo) => this.receivePacket(buffer, rinfo.address, rinfo.port));
    const tick = () => setTimeout(() => {
      this.tick();
      tick();
    }, 50);
    tick();
  }

  private tick() {
    for (const [k, v] of Object.entries(this.clients)) {
      if (Date.now() - v >= 60000) {
        delete this.clients[k];
        delete this.lastIds[k];
        const [address, port] = k.split(':');
        this.emit('onClientUpdate', address, +port, 'timeout');
      }
    }
    this.resendPackets();
  }

  public isBlacklisted(address: string): [true, number] | [false] {
    const index = this.blacklist.findIndex(v => v[0] === address);
    if (index > -1) return [true, index];
    return [false];
  }

  public blockAddress(address: string) {
    if (this.isBlacklisted(address)[0]) return false;
    this.blacklist.push([address, 0]);
    return true;
  }

  public unblockAddress(address: string) {
    if (!this.isBlacklisted(address)[0]) return false;
    this.blacklist = this.blacklist.filter(v => v[0] !== address);
    return true;
  }

  private sendPacket(uniqueId: number, packetId: number, priority: SNET_PRIORITES, bs: BitStream, address: string, port: number) {
    const data = new BitStream();
    data.writeUInt32(uniqueId);
    data.writeUInt32(packetId);
    data.writeUInt8(priority);
    const EMPTY = Buffer.from([0x0]);
    const bytes = Buffer.concat([EMPTY, data.getBuffer(), bs.getBuffer(), EMPTY]);
    this.socket.send(bytes, port, address);
  }

  public send(packetId: number, bs: BitStream, priority: SNET_PRIORITES, address: string, port: number) {
    const uniqueId = this.uniqueId;
    this.uniqueId++;
    if (this.uniqueId >= 4294967295) {
      this.uniqueId = 0;
    }
    this.sendPacket(uniqueId, packetId, priority, bs, address, port);
    if (priority > 0) {
      this.packets.push({
        uniqueId, packetId,
        priority, bs,
        times: 0, lastTime: Date.now(),
        address, port
      });
    }
  }
  
  public sendAll(packetId: number, bs: BitStream, priority: SNET_PRIORITES) {
    for (const addressAndPort of Object.keys(this.clients)) {
      const [address, port] = addressAndPort.split(':');
      this.send(packetId, bs, priority, address, +port);
    }
  }

  private receivePacket(buffer: Buffer, address: string, port: number) {
    const [isBlocked, index] = this.isBlacklisted(address);

    if (isBlocked) { 
      if (Date.now() >= this.blacklist[index][1]) {
        this.blacklist[index][1] = Date.now() + 60000;
        this.send(SNET_BLOCK_PACKET, new BitStream(), SNET_PRIORITES.BYPASS, address, port);
      }
      return false;
    }

    if (buffer[0] !== 0x0) return false;
    const data = <Buffer> Uint8Array.prototype.slice.call(buffer, 1);
    
    let offset = 0;
    const uniqueId = data.readUInt32LE(offset);
    offset += 4;
    const packetId = data.readUInt32LE(offset);
    offset += 4;
    const priority = data.readUInt8(offset);
    const cleanData = <Buffer> Uint8Array.prototype.slice.call(data, 9);
    
    if (priority > 0) {
      const newBs = new BitStream();
      newBs.writeUInt32(uniqueId);
      this.send(SNET_CONFIRM_PRIORITY, newBs, SNET_PRIORITES.BYPASS, address, port);
    }
    
    const addressAndPort = address + ':' + port;

    if (!(addressAndPort in this.lastIds)) {
      this.lastIds[addressAndPort] = [];
    }
    if (this.lastIds[addressAndPort].includes(uniqueId)) return false;
  
    if (this.lastIds[addressAndPort].length >= 10) this.lastIds[addressAndPort].shift();
    this.lastIds[addressAndPort].push(uniqueId);

    if (!(addressAndPort in this.clients)) {
      this.emit('onClientUpdate', address, port, 'connect');      
    }
    this.clients[addressAndPort] = Date.now();

    this.emit('onReceivePacket', packetId, BitStream.from(cleanData), address, port);

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
    const _packets: SNetServerPacket[] = [];
    for (let i = this.packets.length; i >= 0; i--) {
      const v = this.packets[i];
      if (!v) continue;
      if (Date.now() - v.lastTime >= 500) {
        v.lastTime = Date.now();
        v.times++;

        this.sendPacket(v.uniqueId, v.packetId, v.priority, v.bs, v.address, v.port);

        if (v.priority === SNET_PRIORITES.SYSTEM && !((v.address + ':' + v.port) in this.clients))
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