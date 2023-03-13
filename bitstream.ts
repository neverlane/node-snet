export class BitStream {
  private buffer: Buffer;
  private readPosition: number;
  private writePosition: number;

  constructor() {
    this.buffer = Buffer.alloc(0);
    this.readPosition = 0;
    this.writePosition = 0;
  }

  static from(value: number[]): BitStream;
  static from(value: BitStream): BitStream;
  static from(value: Buffer): BitStream;
  static from(value: number[] | Buffer | BitStream): BitStream {
    const bs = new BitStream();
    if (value instanceof BitStream) {
      const bsBuffer = value.getBuffer();
      const bf = Buffer.alloc(bsBuffer.length);
      bsBuffer.copy(bf);
      bs.buffer = bf;
    } else {
      bs.buffer = Buffer.from(value);
    } 
    return bs;
  }

  get length(): number {
    return this.buffer.length;
  }

  private addBytes(valueOfBytes: number) {
    const bf = Buffer.alloc(this.buffer.length + valueOfBytes);
    this.buffer.copy(bf);
    this.buffer = bf;
  }

  writeBoolean(value: boolean): void {
    this.addBytes(1);
    this.buffer[this.writePosition++] = Number(value);
  }

  writeInt8(value: number): void {
    this.addBytes(1);
    this.buffer[this.writePosition++] = value;
  }
  writeUInt8(value: number): void {
    this.addBytes(1);
    this.buffer[this.writePosition++] = value;
  }

  writeInt16(value: number): void {
    this.addBytes(2);
    this.buffer.writeInt16LE(value, this.writePosition);
    this.writePosition += 2;
  }
  writeUInt16(value: number): void {
    this.addBytes(2);
    this.buffer.writeUInt16LE(value, this.writePosition);
    this.writePosition += 2;
  }

  writeInt32(value: number): void {
    this.addBytes(4);
    this.buffer.writeInt32LE(value, this.writePosition);
    this.writePosition += 4;
  }
  writeUInt32(value: number): void {
    this.addBytes(4);
    this.buffer.writeUInt32LE(value, this.writePosition);
    this.writePosition += 4;
  }

  writeFloat(value: number): void {
    this.addBytes(4);
    this.buffer.writeFloatLE(value, this.writePosition);
    this.writePosition += 4;
  }

  writeString(value: string): void {
    this.addBytes(value.length);
    this.buffer.write(value, 'ascii');
    this.writePosition += value.length;
  }

  readBoolean(): boolean {
    return this.buffer[this.readPosition++] !== 0;
  }

  readInt8(): number {
    return this.buffer[this.readPosition++];
  }
  readUInt8(): number {
    return this.buffer[this.readPosition++];
  }

  readInt16(): number {
    const v = this.buffer.readInt16LE(this.readPosition);
    this.readPosition += 2;
    return v;
  }
  readUInt16(): number {
    const v = this.buffer.readUInt16LE(this.readPosition);
    this.readPosition += 2;
    return v;
  }

  readInt32(): number {
    const v = this.buffer.readInt32LE(this.readPosition);
    this.readPosition += 4;
    return v;
  }
  readUInt32(): number {
    const v = this.buffer.readUInt32LE(this.readPosition);
    this.readPosition += 4;
    return v;
  }
  
  readFloat(): number {
    const v = this.buffer.readFloatLE(this.readPosition);
    this.readPosition += 4;
    return v;
  }

  readString(length: number): string {
    let value = <Buffer> Uint8Array.prototype.slice.call(this.buffer, this.readPosition, this.readPosition + length);
    this.readPosition += length;
    return value.toString('ascii');
  }

  resetReadPosition(): void {
    this.readPosition = 0;
  }
  resetWritePosition(): void {
    this.writePosition = 0;
  }

  getBuffer(): Buffer {
    return this.buffer;
  }

  toString() {
    return this.buffer.toString('ascii');
  }

}