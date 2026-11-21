/**
 * SNET wire format (RazorRw/SNET @19aecbe):
 *   [0x00][u32 LE uniqueId][u32 LE packetId][u8 priority][payload...]
 *
 * SLMP-Team SNET and node-snet <= 1.x appended a trailing 0x00 and node-snet 1.x also
 * stripped the last byte on receive. Set `legacyTerminator` to talk to those.
 */
import type { Socket } from 'node:dgram';
import { BitStream } from './bitstream';
import type { SNET_PRIORITIES } from './types';

export const SNET_HEADER_SIZE = 10;

export interface SNetPacketStruct {
  uniqueId: number;
  packetId: number;
  priority: SNET_PRIORITIES;
  /** payload bytes (a view into the datagram) */
  payload: Buffer;
  /** @deprecated use payload; kept for v1 code */
  data: BitStream;
}

export const encodePacket = (
  uniqueId: number, packetId: number, priority: SNET_PRIORITIES,
  payload: Uint8Array, legacyTerminator = false,
): Buffer => {
  const out = Buffer.allocUnsafe(SNET_HEADER_SIZE + payload.length + (legacyTerminator ? 1 : 0));
  out[0] = 0;
  out.writeUInt32LE(uniqueId >>> 0, 1);
  out.writeUInt32LE(packetId >>> 0, 5);
  out.writeUInt8(priority & 0xff, 9);
  out.set(payload, SNET_HEADER_SIZE);
  if (legacyTerminator) out[out.length - 1] = 0;
  return out;
};

export const decodePacket = (datagram: Buffer, legacyTerminator = false): SNetPacketStruct | null => {
  if (datagram.length < SNET_HEADER_SIZE || datagram[0] !== 0) return null;
  let end = datagram.length;
  if (legacyTerminator && end > SNET_HEADER_SIZE && datagram[end - 1] === 0) end--;
  const payload = datagram.subarray(SNET_HEADER_SIZE, end);
  return {
    uniqueId: datagram.readUInt32LE(1),
    packetId: datagram.readUInt32LE(5),
    priority: datagram[9],
    payload,
    get data() { return BitStream.from(payload); },
  };
};

/** @deprecated v1 name, returns false instead of null */
export const getPacket = (buffer: Buffer, legacyTerminator = false): SNetPacketStruct | false =>
  decodePacket(buffer, legacyTerminator) ?? false;

export const sendPacket = (
  socket: Socket, uniqueId: number, packetId: number, priority: SNET_PRIORITIES,
  bs: BitStream | Uint8Array, address?: string, port?: number, legacyTerminator = false,
) => {
  const payload = bs instanceof BitStream ? bs.getBuffer() : bs;
  const bytes = encodePacket(uniqueId, packetId, priority, payload, legacyTerminator);
  if (address === undefined || port === undefined) socket.send(bytes);
  else socket.send(bytes, port, address);
};
