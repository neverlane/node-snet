/** BitStream semantics. Where Lua bstream defines behaviour, node-snet must match it. */
import { describe, expect, it } from 'vitest';
import { BitStream } from '../src';
import { decodeTyped, encodeTyped, SAMPLE_TYPED } from './helpers/net';

describe('BitStream', () => {
  it('roundtrips all types (little-endian)', () => {
    const bs = encodeTyped(SAMPLE_TYPED);
    expect(bs.getBuffer().subarray(0, 4).toString('hex')).toBe('fa9ce8fd'); // u8 250, i8 -100, u16 65000
    expect(decodeTyped(BitStream.from(bs))).toEqual(SAMPLE_TYPED);
  });

  it('writeString uses byte length for utf8', () => {
    const bs = new BitStream().writeString('привет', 'utf8');
    expect(bs.length).toBe(Buffer.byteLength('привет'));
    expect(bs.toString('utf8')).toBe('привет');
  });

  it('writePosition tracks bytes for utf8 strings', () => {
    const bs = new BitStream().writeString('ы', 'utf8').writeUInt8(1);
    expect(bs.getBuffer().toString('hex')).toBe('d18b01');
  });

  it('writeUInt8/writeInt8 reject out-of-range values like 16/32-bit writers do', () => {
    expect(() => new BitStream().writeUInt8(300)).toThrow(RangeError);
    expect(() => new BitStream().writeInt8(200)).toThrow(RangeError);
    expect(() => new BitStream().writeUInt16(70000)).toThrow(RangeError);
  });

  it('writing at a moved writePosition overwrites in place (RakNet style, no garbage growth)', () => {
    const bs = new BitStream().writeUInt8(1).writeUInt8(9).writeUInt8(3);
    bs.setWritePosition(1);
    bs.writeUInt8(2);
    expect(bs.getBuffer().toString('hex')).toBe('010203');
  });

  it('writeBytes respects writePosition', () => {
    const bs = new BitStream().writeUInt8(9).writeUInt8(9);
    bs.setWritePosition(0);
    bs.writeBytes(Buffer.from([7]));
    expect(bs.getBuffer().toString('hex')).toBe('0709');
  });

  it('reading past the end throws', () => {
    expect(() => new BitStream().writeUInt8(1).readUInt16()).toThrow();
  });

  it('from(BitStream) copies the buffer', () => {
    const a = new BitStream().writeUInt8(1);
    const b = BitStream.from(a);
    b.getBuffer()[0] = 2;
    expect(a.getBuffer()[0]).toBe(1);
  });

  it('bit packing is MSB-first like RakNet', () => {
    const bs = new BitStream().writeBits(0b101, 3).writeBit(true).writeBits(0, 4);
    expect(bs.getBuffer().toString('hex')).toBe('b0');
    expect(bs.toBinaryString()).toBe('10110000');
  });

  it('bits roundtrip across byte boundaries', () => {
    const bs = new BitStream();
    const values: [number, number][] = [[1, 1], [5, 3], [1023, 10], [0, 7], [0xffffffff, 32], [123456, 17], [3, 2]];
    for (const [v, n] of values) bs.writeBits(v, n);
    expect(bs.bitLength).toBe(72);
    expect(bs.length).toBe(9);
    for (const [v, n] of values) expect(bs.readBits(n)).toBe(v);
  });

  it('byte values at unaligned offsets roundtrip', () => {
    const bs = new BitStream().writeBit(true).writeUInt32(0xdeadbeef).writeFloat(1.5).writeInt16(-2)
      .writeString8('ёж').writeDouble(Math.PI).writeInt64(-5n).writeBoolean(true).writeBytes(Buffer.from([1, 2]));
    expect(bs.readBit()).toBe(true);
    expect(bs.readUInt32()).toBe(0xdeadbeef);
    expect(bs.readFloat()).toBe(1.5);
    expect(bs.readInt16()).toBe(-2);
    expect(bs.readString8()).toBe('ёж');
    expect(bs.readDouble()).toBe(Math.PI);
    expect(bs.readInt64()).toBe(-5n);
    expect(bs.readBoolean()).toBe(true);
    expect([...bs.readBytes(2)]).toEqual([1, 2]);
    expect(bs.unreadBits).toBe(0);
  });

  it('aligned byte writes match Lua bstream layout exactly', () => {
    const bs = new BitStream().writeUInt8(1).writeUInt16(0x0302).writeUInt32(0x07060504).writeBoolean(true).writeString('ab');
    expect(bs.getBuffer().toString('hex')).toBe('0102030405060701' + '6162');
  });

  it('alignWrite / alignRead pad to byte boundary', () => {
    const bs = new BitStream().writeBit(true).alignWrite().writeUInt8(0xaa);
    expect(bs.getBuffer().toString('hex')).toBe('80aa');
    expect(bs.readBit()).toBe(true);
    expect(bs.alignRead().readUInt8()).toBe(0xaa);
  });

  it('signed bits, ranged ints and varints', () => {
    const bs = new BitStream().writeSignedBits(-3, 4).writeRangedInt(7, 5, 10).writeVarUInt(300).writeVarInt(-12345)
      .writeVarUInt(Number.MAX_SAFE_INTEGER);
    expect(bs.readSignedBits(4)).toBe(-3);
    expect(bs.readRangedInt(5, 10)).toBe(7);
    expect(bs.readVarUInt()).toBe(300);
    expect(bs.readVarInt()).toBe(-12345);
    expect(bs.readVarUInt()).toBe(Number.MAX_SAFE_INTEGER);
    expect(new BitStream().writeVarUInt(300).getBuffer().toString('hex')).toBe('ac02');
  });

  it('quantized floats, vectors and quaternions are close', () => {
    const bs = new BitStream().writeRangedFloat(12.34, 0, 100, 16).writeNormVector(0.6, -0.8, 0)
      .writeQuat(0.7071, 0, 0.7071, 0);
    expect(bs.readRangedFloat(0, 100, 16)).toBeCloseTo(12.34, 2);
    const [x, y, z] = bs.readNormVector();
    expect(x).toBeCloseTo(0.6, 3); expect(y).toBeCloseTo(-0.8, 3); expect(z).toBeCloseTo(0, 3);
    const [w, qx, qy, qz] = bs.readQuat();
    expect(w).toBeCloseTo(0.7071, 3); expect(qx).toBeCloseTo(0, 3); expect(qy).toBeCloseTo(0.7071, 3); expect(qz).toBeCloseTo(0, 3);
    expect(bs.bitLength).toBe(16 + 48 + 2 + 45);
  });

  it('writeBitStream appends bits of another stream', () => {
    const inner = new BitStream().writeBits(0b11, 2);
    const bs = new BitStream().writeBit(false).writeBitStream(inner).writeBits(0b10101, 5);
    expect(bs.toBinaryString()).toBe('01110101');
  });

  it('bit write range is checked', () => {
    expect(() => new BitStream().writeBits(8, 3)).toThrow(RangeError);
    expect(() => new BitStream().writeBits(1, 33)).toThrow(RangeError);
    expect(() => new BitStream().writeBit(true).readBits(2)).toThrow(RangeError);
  });

  it('many small writes stay fast (no O(n^2) realloc)', () => {
    const t = performance.now();
    const bs = new BitStream();
    for (let i = 0; i < 100_000; i++) bs.writeUInt8(i & 0xff);
    expect(bs.length).toBe(100_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
