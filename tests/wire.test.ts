/**
 * Byte-level wire format checks against RazorRw/SNET @19aecbe:
 *   [0x00][u32 LE uniqueId][u32 LE packetId][u8 priority][payload...]   (no trailing \0)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BitStream, SNET_CONFIRM_PRIORITY, SNET_PRIORITES } from '../src';
import {
  buildDatagram, closeAll, collect, getPort, rawSocket, sleep,
  startNodeClient, startNodeServer, waitFor,
} from './helpers/net';

const cleanup: Parameters<typeof closeAll> = [];
afterEach(async () => { await closeAll(...cleanup.splice(0)); });

describe('wire: node-snet sends Razor format', () => {
  it('client datagram is \\0 + header + payload, without trailing \\0', async () => {
    const raw = await rawSocket();
    const port = raw.sock.address().port;
    const client = await startNodeClient(port);
    cleanup.push(client, raw);

    client.send(7, new BitStream().writeBytes(Buffer.from('hey')), SNET_PRIORITES.BYPASS);
    await waitFor(() => raw.got.length > 0);
    expect(raw.got[0].toString('hex')).toBe(buildDatagram(0, 7, 0, Buffer.from('hey')).toString('hex'));
  });

  it('uniqueId increments per packet, priority byte is written', async () => {
    const raw = await rawSocket();
    const client = await startNodeClient(raw.sock.address().port);
    cleanup.push(client, raw);

    client.send(1, new BitStream(), SNET_PRIORITES.LOW);
    client.send(2, new BitStream(), SNET_PRIORITES.HIGH);
    await waitFor(() => raw.got.length >= 2);
    expect(raw.got[0].readUInt32LE(1)).toBe(0);
    expect(raw.got[1].readUInt32LE(1)).toBe(1);
    expect(raw.got[0][9]).toBe(SNET_PRIORITES.LOW);
    expect(raw.got[1][9]).toBe(SNET_PRIORITES.HIGH);
  });
});

describe('wire: node-snet server parses Razor format', () => {
  const setup = async () => {
    const port = getPort();
    const server = await startNodeServer(port);
    const inbox = collect(server);
    const raw = await rawSocket();
    cleanup.push(server, raw);
    return { port, server, inbox, raw };
  };

  it('keeps the last payload byte (no terminator expected)', async () => {
    const { port, inbox, raw } = await setup();
    await raw.send(buildDatagram(1, 5, 0, Buffer.from('abc')), port);
    expect((await inbox.first(5)).toString()).toBe('abc');
  });

  it('keeps payload that ends with 0x00', async () => {
    const { port, inbox, raw } = await setup();
    const payload = new BitStream().writeUInt32(0).getBuffer(); // 00 00 00 00
    await raw.send(buildDatagram(1, 5, 0, payload), port);
    expect((await inbox.first(5)).toString('hex')).toBe('00000000');
  });

  it('accepts header-only packet (empty payload)', async () => {
    const { port, inbox, raw } = await setup();
    await raw.send(buildDatagram(1, 9, 0, Buffer.alloc(0)), port);
    expect((await inbox.first(9)).length).toBe(0);
  });

  it('answers priority>0 with SNET_CONFIRM_PRIORITY carrying the uniqueId', async () => {
    const { port, raw } = await setup();
    await raw.send(buildDatagram(42, 5, SNET_PRIORITES.HIGH, Buffer.from('x')), port);
    await waitFor(() => raw.got.length > 0);
    const ack = raw.got[0];
    expect(ack[0]).toBe(0);
    expect(ack.readUInt32LE(5)).toBe(SNET_CONFIRM_PRIORITY);
    expect(ack[9]).toBe(SNET_PRIORITES.BYPASS);
    expect(ack.readUInt32LE(10)).toBe(42);
  });

  it('does not ACK BYPASS packets', async () => {
    const { port, raw } = await setup();
    await raw.send(buildDatagram(1, 5, SNET_PRIORITES.BYPASS, Buffer.from('x')), port);
    await sleep(200);
    expect(raw.got).toHaveLength(0);
  });

  it('drops duplicate uniqueId but still ACKs it', async () => {
    const { port, inbox, raw } = await setup();
    const dg = buildDatagram(3, 5, SNET_PRIORITES.HIGH, Buffer.from('dup'));
    await raw.send(dg, port);
    await raw.send(dg, port);
    await waitFor(() => raw.got.length >= 2);
    await sleep(100);
    expect(inbox.byId(5)).toHaveLength(1);
  });

  it('survives garbage datagrams and keeps working', async () => {
    const { port, server, inbox, raw } = await setup();
    const errors: Error[] = [];
    server.on('error', (e) => errors.push(e));
    for (const junk of [
      Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 1, 2, 3, 4]),
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(9), Buffer.from('hello'),
    ]) await raw.send(junk, port);
    await raw.send(buildDatagram(1, 5, 0, Buffer.from('ok')), port);
    expect((await inbox.first(5)).toString()).toBe('ok');
    expect(inbox.got).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it('does not expose service packets (confirm) to user handlers', async () => {
    const { port, inbox, raw } = await setup();
    const ack = new BitStream().writeUInt32(0).getBuffer();
    await raw.send(buildDatagram(1, SNET_CONFIRM_PRIORITY, 0, ack), port);
    await raw.send(buildDatagram(2, 5, 0, Buffer.from('after')), port);
    await inbox.first(5);
    expect(inbox.byId(SNET_CONFIRM_PRIORITY)).toHaveLength(0);
  });
});
