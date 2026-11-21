/**
 * Bit-level stream in the spirit of RakNet's BitStream.
 *
 * - Offsets are tracked in bits. Byte-sized values written at a byte boundary produce exactly
 *   the same bytes as Lua SNET's bstream (little-endian, no padding), so byte-only code stays
 *   wire compatible with Lua.
 * - Bits are packed MSB-first inside each byte (RakNet order): writeBits(0b101, 3) -> 0b1010_0000.
 * - Multi-byte numbers are little-endian. When written at a non-aligned offset, their LE bytes
 *   are written bit by bit (like RakNet does), no implicit alignment.
 * - Writing at an offset inside already written data overwrites it.
 */

const scratch = Buffer.alloc(8);

const checkInt = (value: number, min: number, max: number, type: string) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`BitStream: ${type} value out of range (${min}..${max}): ${value}`);
  }
};

const checkBigInt = (value: bigint, min: bigint, max: bigint, type: string) => {
  if (value < min || value > max) {
    throw new RangeError(`BitStream: ${type} value out of range (${min}..${max}): ${value}`);
  }
};

/** Number of bits needed to store values 0..n */
export const bitsFor = (n: number) => (n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1);

export type BitStreamSource = number[] | Buffer | Uint8Array | ArrayBuffer | BitStream;

export class BitStream {
  private buffer: Buffer;
  /** number of meaningful bits in the stream */
  private bitsUsed = 0;
  /** read offset in bits */
  public readOffset = 0;
  /** write offset in bits */
  public writeOffset = 0;

  constructor(initialCapacity = 32) {
    this.buffer = Buffer.alloc(Math.max(1, initialCapacity));
  }

  static from(value: BitStreamSource): BitStream {
    if (value instanceof BitStream) {
      const bs = new BitStream(value.length);
      value.buffer.copy(bs.buffer, 0, 0, value.length);
      bs.bitsUsed = value.bitsUsed;
      bs.writeOffset = value.bitsUsed;
      return bs;
    }
    const bytes = value instanceof ArrayBuffer ? Buffer.from(new Uint8Array(value)) : Buffer.from(value as Uint8Array);
    const bs = new BitStream(bytes.length);
    bytes.copy(bs.buffer);
    bs.bitsUsed = bytes.length * 8;
    bs.writeOffset = bs.bitsUsed;
    return bs;
  }

  // ------------------------------------------------------------------ sizes & offsets

  /** bytes used (rounded up) */
  get length(): number { return (this.bitsUsed + 7) >>> 3; }
  /** bits used */
  get bitLength(): number { return this.bitsUsed; }
  /** bits left to read */
  get unreadBits(): number { return Math.max(0, this.bitsUsed - this.readOffset); }
  /** whole bytes left to read */
  get unreadBytes(): number { return this.unreadBits >>> 3; }

  /** read position in bytes (floor of bit offset) */
  get readPosition(): number { return this.readOffset >>> 3; }
  set readPosition(v: number) { this.setReadPosition(v); }
  /** write position in bytes (floor of bit offset) */
  get writePosition(): number { return this.writeOffset >>> 3; }
  set writePosition(v: number) { this.setWritePosition(v); }

  public setReadPosition(bytes: number): this { return this.setReadOffset(bytes * 8); }
  public setWritePosition(bytes: number): this { return this.setWriteOffset(bytes * 8); }

  public setReadOffset(bits: number): this {
    if (!Number.isInteger(bits) || bits < 0 || bits > this.bitsUsed) throw new RangeError('BitStream: read offset out of bounds');
    this.readOffset = bits;
    return this;
  }
  public setWriteOffset(bits: number): this {
    if (!Number.isInteger(bits) || bits < 0) throw new RangeError('BitStream: write offset out of bounds');
    this.ensure(bits);
    this.writeOffset = bits;
    return this;
  }

  public ignoreReadPosition(bytes: number): this { return this.setReadOffset(this.readOffset + bytes * 8); }
  public ignoreWritePosition(bytes: number): this { return this.setWriteOffset(this.writeOffset + bytes * 8); }
  public ignoreReadBits(bits: number): this { return this.setReadOffset(this.readOffset + bits); }
  public ignoreWriteBits(bits: number): this { return this.setWriteOffset(this.writeOffset + bits); }

  public resetReadPosition(): this { this.readOffset = 0; return this; }
  public resetWritePosition(): this { this.writeOffset = 0; return this; }
  /** drop all data */
  public reset(): this { this.bitsUsed = this.readOffset = this.writeOffset = 0; this.buffer.fill(0); return this; }

  /** move write offset to the next byte boundary (padding with zero bits) */
  public alignWrite(): this {
    const pad = (8 - (this.writeOffset & 7)) & 7;
    if (pad) this.writeBits(0, pad);
    return this;
  }
  /** move read offset to the next byte boundary */
  public alignRead(): this {
    const pad = (8 - (this.readOffset & 7)) & 7;
    if (pad) this.ignoreReadBits(pad);
    return this;
  }

  // ------------------------------------------------------------------ internals

  private ensure(bits: number) {
    const need = (bits + 7) >>> 3;
    if (need <= this.buffer.length) return;
    let cap = this.buffer.length * 2;
    while (cap < need) cap *= 2;
    const next = Buffer.alloc(cap);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  private wrote(bits: number) {
    this.writeOffset += bits;
    if (this.writeOffset > this.bitsUsed) this.bitsUsed = this.writeOffset;
  }

  private assertRead(bits: number) {
    if (this.readOffset + bits > this.bitsUsed) {
      throw new RangeError(`BitStream: read out of bounds (need ${bits} bits, ${this.unreadBits} left)`);
    }
  }

  /** write `count` (<= 32) low bits of an unsigned value, MSB first */
  private putBits(value: number, count: number) {
    this.ensure(this.writeOffset + count);
    const buf = this.buffer;
    let off = this.writeOffset;
    let left = count;
    while (left > 0) {
      const idx = off >>> 3;
      const free = 8 - (off & 7);
      const n = free < left ? free : left;
      const chunk = Math.floor(value / 2 ** (left - n)) & ((1 << n) - 1);
      const shift = free - n;
      const mask = ((1 << n) - 1) << shift;
      buf[idx] = (buf[idx] & ~mask) | (chunk << shift);
      left -= n;
      off += n;
    }
    this.wrote(count);
  }

  /** read `count` (<= 32) bits as unsigned number, MSB first */
  private takeBits(count: number): number {
    this.assertRead(count);
    const buf = this.buffer;
    let off = this.readOffset;
    let left = count;
    let result = 0;
    while (left > 0) {
      const idx = off >>> 3;
      const free = 8 - (off & 7);
      const n = free < left ? free : left;
      const chunk = (buf[idx] >>> (free - n)) & ((1 << n) - 1);
      result = result * (1 << n) + chunk;
      left -= n;
      off += n;
    }
    this.readOffset = off;
    return result;
  }

  private aligned(offset: number) { return (offset & 7) === 0; }

  /** writes bytes from scratch (or given source) handling alignment */
  private putBytes(src: Uint8Array, size = src.length) {
    if (this.aligned(this.writeOffset)) {
      this.ensure(this.writeOffset + size * 8);
      this.buffer.set(src.subarray(0, size), this.writeOffset >>> 3);
      this.wrote(size * 8);
    } else {
      for (let i = 0; i < size; i++) this.putBits(src[i], 8);
    }
  }

  private takeBytesInto(dst: Buffer, size: number) {
    this.assertRead(size * 8);
    if (this.aligned(this.readOffset)) {
      const start = this.readOffset >>> 3;
      this.buffer.copy(dst, 0, start, start + size);
      this.readOffset += size * 8;
    } else {
      for (let i = 0; i < size; i++) dst[i] = this.takeBits(8);
    }
    return dst;
  }

  // ------------------------------------------------------------------ bits

  public writeBit(value: boolean | number): this {
    this.putBits(value ? 1 : 0, 1);
    return this;
  }

  public readBit(): boolean {
    return this.takeBits(1) === 1;
  }

  /** write `count` low bits (1..32) of an unsigned integer */
  public writeBits(value: number, count: number): this {
    checkInt(count, 0, 32, 'bit count');
    if (count === 0) return this;
    checkInt(value, 0, 2 ** count - 1, `${count}-bit`);
    this.putBits(value, count);
    return this;
  }

  /** read `count` (1..32) bits as an unsigned integer */
  public readBits(count: number): number {
    checkInt(count, 0, 32, 'bit count');
    return count === 0 ? 0 : this.takeBits(count);
  }

  /** two's complement signed integer in `count` (1..32) bits */
  public writeSignedBits(value: number, count: number): this {
    checkInt(count, 1, 32, 'bit count');
    const half = 2 ** (count - 1);
    checkInt(value, -half, half - 1, `${count}-bit signed`);
    this.putBits(value < 0 ? value + 2 * half : value, count);
    return this;
  }

  public readSignedBits(count: number): number {
    checkInt(count, 1, 32, 'bit count');
    const v = this.takeBits(count);
    const half = 2 ** (count - 1);
    return v >= half ? v - 2 * half : v;
  }

  /** integer in [min, max] using the minimal amount of bits */
  public writeRangedInt(value: number, min: number, max: number): this {
    checkInt(value, min, max, 'ranged int');
    const bits = bitsFor(max - min);
    if (bits > 32) throw new RangeError('BitStream: range too large (max 32 bits)');
    if (bits) this.putBits(value - min, bits);
    return this;
  }

  public readRangedInt(min: number, max: number): number {
    const bits = bitsFor(max - min);
    return min + (bits ? this.takeBits(bits) : 0);
  }

  /** float quantized into `bits` bits over [min, max] (like RakNet WriteFloat16) */
  public writeRangedFloat(value: number, min: number, max: number, bits = 16): this {
    checkInt(bits, 1, 32, 'bit count');
    if (!(max > min)) throw new RangeError('BitStream: max must be greater than min');
    const steps = 2 ** bits - 1;
    const clamped = Math.min(max, Math.max(min, value));
    this.putBits(Math.round(((clamped - min) / (max - min)) * steps), bits);
    return this;
  }

  public readRangedFloat(min: number, max: number, bits = 16): number {
    checkInt(bits, 1, 32, 'bit count');
    const steps = 2 ** bits - 1;
    return min + (this.takeBits(bits) / steps) * (max - min);
  }

  /** float in [-1, 1] with `bits` precision */
  public writeNormalizedFloat(value: number, bits = 16): this { return this.writeRangedFloat(value, -1, 1, bits); }
  public readNormalizedFloat(bits = 16): number { return this.readRangedFloat(-1, 1, bits); }

  /** unit vector: 3 normalized components (RakNet WriteNormVector-like) */
  public writeNormVector(x: number, y: number, z: number, bits = 16): this {
    return this.writeNormalizedFloat(x, bits).writeNormalizedFloat(y, bits).writeNormalizedFloat(z, bits);
  }
  public readNormVector(bits = 16): [number, number, number] {
    return [this.readNormalizedFloat(bits), this.readNormalizedFloat(bits), this.readNormalizedFloat(bits)];
  }

  /** quaternion with smallest-three compression: 2 bits index + 3 x `bits` */
  public writeQuat(w: number, x: number, y: number, z: number, bits = 15): this {
    const q = [w, x, y, z];
    const len = Math.hypot(w, x, y, z) || 1;
    for (let i = 0; i < 4; i++) q[i] /= len;
    let largest = 0;
    for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
    const sign = q[largest] < 0 ? -1 : 1;
    this.putBits(largest, 2);
    const lim = Math.SQRT1_2;
    for (let i = 0; i < 4; i++) if (i !== largest) this.writeRangedFloat(q[i] * sign, -lim, lim, bits);
    return this;
  }
  public readQuat(bits = 15): [number, number, number, number] {
    const largest = this.takeBits(2);
    const lim = Math.SQRT1_2;
    const q = [0, 0, 0, 0];
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      if (i === largest) continue;
      q[i] = this.readRangedFloat(-lim, lim, bits);
      sum += q[i] * q[i];
    }
    q[largest] = Math.sqrt(Math.max(0, 1 - sum));
    return q as [number, number, number, number];
  }

  // ------------------------------------------------------------------ bytes & numbers

  public writeBytes(bytes: Uint8Array, size: number = bytes.length): this {
    checkInt(size, 0, bytes.length, 'bytes size');
    this.putBytes(bytes, size);
    return this;
  }

  /** returns a copy */
  public readBytes(size: number): Buffer {
    checkInt(size, 0, Number.MAX_SAFE_INTEGER, 'bytes size');
    return this.takeBytesInto(Buffer.alloc(size), size);
  }

  /** append all bits of another stream (from its start) */
  public writeBitStream(other: BitStream, bits = other.bitsUsed): this {
    checkInt(bits, 0, other.bitsUsed, 'bit count');
    const whole = bits >>> 3;
    this.putBytes(other.buffer, whole);
    const rest = bits & 7;
    if (rest) this.putBits(other.buffer[whole] >>> (8 - rest), rest);
    return this;
  }

  /** Lua compatible: 1 byte (0/1) */
  public writeBoolean(value: boolean): this {
    scratch[0] = value ? 1 : 0;
    this.putBytes(scratch, 1);
    return this;
  }
  public readBoolean(): boolean {
    return this.takeBytesInto(scratch, 1)[0] !== 0;
  }

  public writeInt8(value: number): this { checkInt(value, -0x80, 0x7f, 'int8'); scratch.writeInt8(value); return this.putBytes(scratch, 1), this; }
  public writeUInt8(value: number): this { checkInt(value, 0, 0xff, 'uint8'); scratch.writeUInt8(value); return this.putBytes(scratch, 1), this; }
  public writeInt16(value: number): this { checkInt(value, -0x8000, 0x7fff, 'int16'); scratch.writeInt16LE(value); return this.putBytes(scratch, 2), this; }
  public writeUInt16(value: number): this { checkInt(value, 0, 0xffff, 'uint16'); scratch.writeUInt16LE(value); return this.putBytes(scratch, 2), this; }
  public writeInt32(value: number): this { checkInt(value, -0x80000000, 0x7fffffff, 'int32'); scratch.writeInt32LE(value); return this.putBytes(scratch, 4), this; }
  public writeUInt32(value: number): this { checkInt(value, 0, 0xffffffff, 'uint32'); scratch.writeUInt32LE(value); return this.putBytes(scratch, 4), this; }
  public writeInt64(value: bigint): this { checkBigInt(value, -(2n ** 63n), 2n ** 63n - 1n, 'int64'); scratch.writeBigInt64LE(value); return this.putBytes(scratch, 8), this; }
  public writeUInt64(value: bigint): this { checkBigInt(value, 0n, 2n ** 64n - 1n, 'uint64'); scratch.writeBigUInt64LE(value); return this.putBytes(scratch, 8), this; }
  public writeFloat(value: number): this { scratch.writeFloatLE(value); return this.putBytes(scratch, 4), this; }
  public writeDouble(value: number): this { scratch.writeDoubleLE(value); return this.putBytes(scratch, 8), this; }

  public readInt8(): number { return this.takeBytesInto(scratch, 1).readInt8(0); }
  public readUInt8(): number { return this.takeBytesInto(scratch, 1).readUInt8(0); }
  public readInt16(): number { return this.takeBytesInto(scratch, 2).readInt16LE(0); }
  public readUInt16(): number { return this.takeBytesInto(scratch, 2).readUInt16LE(0); }
  public readInt32(): number { return this.takeBytesInto(scratch, 4).readInt32LE(0); }
  public readUInt32(): number { return this.takeBytesInto(scratch, 4).readUInt32LE(0); }
  public readInt64(): bigint { return this.takeBytesInto(scratch, 8).readBigInt64LE(0); }
  public readUInt64(): bigint { return this.takeBytesInto(scratch, 8).readBigUInt64LE(0); }
  public readFloat(): number { return this.takeBytesInto(scratch, 4).readFloatLE(0); }
  public readDouble(): number { return this.takeBytesInto(scratch, 8).readDoubleLE(0); }

  /** unsigned LEB128 varint (up to Number.MAX_SAFE_INTEGER) */
  public writeVarUInt(value: number): this {
    checkInt(value, 0, Number.MAX_SAFE_INTEGER, 'varuint');
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) byte |= 0x80;
      this.writeUInt8(byte);
    } while (value > 0);
    return this;
  }
  public readVarUInt(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.readUInt8();
      result += (byte & 0x7f) * mul;
      if (!(byte & 0x80)) return result;
      mul *= 128;
    }
    throw new RangeError('BitStream: varint too long');
  }
  /** signed varint (zigzag) */
  public writeVarInt(value: number): this {
    checkInt(value, -(2 ** 52), 2 ** 52, 'varint');
    return this.writeVarUInt(value < 0 ? -value * 2 - 1 : value * 2);
  }
  public readVarInt(): number {
    const v = this.readVarUInt();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  // ------------------------------------------------------------------ strings

  /** raw string bytes, no length (Lua BS_STRING compatible) */
  public writeString(value: string, encoding: BufferEncoding = 'ascii'): this {
    return this.putBytes(Buffer.from(value, encoding)), this;
  }
  /** `length` is in bytes */
  public readString(length: number, encoding: BufferEncoding = 'ascii'): string {
    return this.readBytes(length).toString(encoding);
  }

  /** string prefixed with its byte length as uint8 */
  public writeString8(value: string, encoding: BufferEncoding = 'utf8'): this { return this.writePrefixed(value, encoding, 1); }
  /** string prefixed with its byte length as uint16 */
  public writeString16(value: string, encoding: BufferEncoding = 'utf8'): this { return this.writePrefixed(value, encoding, 2); }
  /** string prefixed with its byte length as uint32 */
  public writeString32(value: string, encoding: BufferEncoding = 'utf8'): this { return this.writePrefixed(value, encoding, 4); }
  public readString8(encoding: BufferEncoding = 'utf8'): string { return this.readString(this.readUInt8(), encoding); }
  public readString16(encoding: BufferEncoding = 'utf8'): string { return this.readString(this.readUInt16(), encoding); }
  public readString32(encoding: BufferEncoding = 'utf8'): string { return this.readString(this.readUInt32(), encoding); }

  private writePrefixed(value: string, encoding: BufferEncoding, size: 1 | 2 | 4): this {
    const bytes = Buffer.from(value, encoding);
    if (size === 1) this.writeUInt8(bytes.length);
    else if (size === 2) this.writeUInt16(bytes.length);
    else this.writeUInt32(bytes.length);
    return this.putBytes(bytes), this;
  }

  // ------------------------------------------------------------------ export

  /** view on the used bytes (no copy) */
  public getBuffer(): Buffer {
    return this.buffer.subarray(0, this.length);
  }
  /** copy of the used bytes */
  public toBuffer(): Buffer {
    return Buffer.from(this.getBuffer());
  }

  public sliceBuffer(start: number, end?: number): Buffer {
    return Buffer.from(this.getBuffer().subarray(start, end));
  }
  public slice(start: number, end?: number): BitStream {
    return BitStream.from(this.getBuffer().subarray(start, end));
  }

  public toString(encoding: BufferEncoding = 'ascii'): string {
    return this.getBuffer().toString(encoding);
  }

  /** e.g. `10100000 1111....` for debugging */
  public toBinaryString(): string {
    let s = '';
    for (let i = 0; i < this.bitsUsed; i++) {
      if (i && i % 8 === 0) s += ' ';
      s += (this.buffer[i >>> 3] >>> (7 - (i & 7))) & 1;
    }
    return s;
  }
}
