import { Socket } from 'dgram';
import { BitStream } from './bitstream';
import { SNET_PRIORITES } from './types';

export interface SNetPacketStruct {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITES;
  data: BitStream;
}

export const EMPTY_BYTE = Buffer.from([0x0]);

export const getPacket = (buffer: Buffer): SNetPacketStruct | false => {
  if (buffer[0] !== 0x0) return false;
  const data = <Buffer> Uint8Array.prototype.slice.call(buffer, 1, -1);
  try {
    let offset = 0;
    const uniqueId = data.readUInt32LE(offset);
    if (uniqueId < 0) return false;
    offset += 4;
    const packetId = data.readUInt32LE(offset);
    if (packetId < 0) return false;
    offset += 4;
    const priority = data.readUInt8(offset);
    if (priority < 0) return false;
    const cleanData = <Buffer> Uint8Array.prototype.slice.call(data, 9);
    return {
      uniqueId,
      packetId,
      priority,
      data: BitStream.from(cleanData)
    };
  } catch (error) {
    return false;
  }
};

export const sendPacket = (socket: Socket, uniqueId: number, packetId: number, priority: SNET_PRIORITES, bs: BitStream, address: string, port: number) => {
  const data = new BitStream();
  data.writeUInt32(uniqueId);
  data.writeUInt32(packetId);
  data.writeUInt8(priority);
  const bytes = Buffer.concat([EMPTY_BYTE, data.getBuffer(), bs.getBuffer(), EMPTY_BYTE]);
  socket.send(bytes, port, address);
};