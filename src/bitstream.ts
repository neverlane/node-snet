export class BitStream {
  private buffer: Buffer;
  public readPosition: number;
  public writePosition: number;

  constructor() {
    this.buffer = Buffer.alloc(0);
    this.readPosition = 0;
    this.writePosition = 0;
  }

  static from(value: number[]): BitStream;
  static from(value: BitStream): BitStream;
  static from(value: Buffer): BitStream;
  static from(value: Uint8Array): BitStream;
  static from(value: number[] | Buffer | BitStream | Uint8Array): BitStream {
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

  public setReadPosition(v: number): void {
    this.readPosition = v;
  }
  public setWritePosition(v: number): void {
    this.writePosition = v;
  }

  public ignoreReadPosition(v: number): void {
    this.readPosition += v;
  }
  public ignoreWritePosition(v: number): void {
    this.writePosition += v;
  }

  public resetReadPosition(): void {
    this.readPosition = 0;
  }
  public resetWritePosition(): void {
    this.writePosition = 0;
  }

  private addBytes(valueOfBytes: number) {
    const bf = Buffer.alloc(this.buffer.length + valueOfBytes);
    this.buffer.copy(bf);
    this.buffer = bf;
  }
  
  public sliceBuffer(start: number, end?: number) {
    return <Buffer> Uint8Array.prototype.slice.call(this.buffer, start, end)
  }

  public slice(start: number, end?: number) {
    return BitStream.from(this.sliceBuffer(start, end));
  }

  public writeBytes(bytes: Uint8Array, size: number = bytes.length) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    this.writePosition += size;
    return this;
  }

  public writeBoolean(value: boolean) {
    this.addBytes(1);
    this.buffer[this.writePosition++] = Number(value);
    return this;
  }

  public writeInt8(value: number) {
    this.addBytes(1);
    this.buffer[this.writePosition++] = value;
    return this;
  }
  public writeUInt8(value: number) {
    this.addBytes(1);
    this.buffer[this.writePosition++] = value;
    return this;
  }

  public writeInt16(value: number) {
    this.addBytes(2);
    this.buffer.writeInt16LE(value, this.writePosition);
    this.writePosition += 2;
    return this;
  }
  public writeUInt16(value: number) {
    this.addBytes(2);
    this.buffer.writeUInt16LE(value, this.writePosition);
    this.writePosition += 2;
    return this;
  }

  public writeInt32(value: number) {
    this.addBytes(4);
    this.buffer.writeInt32LE(value, this.writePosition);
    this.writePosition += 4;
    return this;
  }
  public writeUInt32(value: number) {
    this.addBytes(4);
    this.buffer.writeUInt32LE(value, this.writePosition);
    this.writePosition += 4;
    return this;
  }

  public writeFloat(value: number) {
    this.addBytes(4);
    this.buffer.writeFloatLE(value, this.writePosition);
    this.writePosition += 4;
    return this;
  }

  public writeString(value: string, encoding: BufferEncoding = 'ascii') {
    this.addBytes(value.length);
    this.buffer.write(value, this.writePosition, encoding);
    this.writePosition += value.length;
    return this;
  }

  public readBytes(size: number) {
    return this.sliceBuffer(this.readPosition, this.readPosition + size);
  }

  public readBoolean(): boolean {
    return this.buffer[this.readPosition++] !== 0;
  }

  public readInt8(): number {
    return this.buffer[this.readPosition++];
  }
  public readUInt8(): number {
    return this.buffer[this.readPosition++];
  }

  public readInt16(): number {
    const v = this.buffer.readInt16LE(this.readPosition);
    this.readPosition += 2;
    return v;
  }
  public readUInt16(): number {
    const v = this.buffer.readUInt16LE(this.readPosition);
    this.readPosition += 2;
    return v;
  }

  public readInt32(): number {
    const v = this.buffer.readInt32LE(this.readPosition);
    this.readPosition += 4;
    return v;
  }
  public readUInt32(): number {
    const v = this.buffer.readUInt32LE(this.readPosition);
    this.readPosition += 4;
    return v;
  }
  
  public readFloat(): number {
    const v = this.buffer.readFloatLE(this.readPosition);
    this.readPosition += 4;
    return v;
  }

  public readString(length: number, encoding: BufferEncoding = 'ascii'): string {
    let value = this.readBytes(length);
    this.readPosition += length;
    return value.toString(encoding);
  }

  public getBuffer(): Buffer {
    return this.buffer;
  }

  public toString(encoding: BufferEncoding = 'ascii') {
    return this.buffer.toString(encoding);
  }
}