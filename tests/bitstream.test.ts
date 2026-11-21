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

  it('writing at a moved writePosition inserts like Lua bstream (no garbage growth)', () => {
    // Lua: bytes = before .. value .. after
    const bs = new BitStream().writeUInt8(1).writeUInt8(3);
    bs.setWritePosition(1);
    bs.writeUInt8(2);
    expect(bs.getBuffer().toString('hex')).toBe('010203');
  });

  it('writeBytes respects writePosition', () => {
    const bs = new BitStream().writeUInt8(9);
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

  it('many small writes stay fast (no O(n^2) realloc)', () => {
    const t = performance.now();
    const bs = new BitStream();
    for (let i = 0; i < 100_000; i++) bs.writeUInt8(i & 0xff);
    expect(bs.length).toBe(100_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
