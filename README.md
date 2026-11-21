# node-snet

Simple Network: reliable UDP with priorities and a RakNet-style `BitStream`.

A Node.js port of [SNET](https://github.com/RazorRw/SNET) (LuaJIT), wire compatible with it:
node-snet servers and clients talk to Lua SNET servers and clients. The interop is covered by
tests that run real LuaJIT peers.

## Install

```bash
npm install node-snet
yarn add node-snet
pnpm add node-snet
```

## Example

```ts
import { Server, Client, BitStream, SNET_PRIORITIES } from 'node-snet';

const server = new Server({ port: 11321, clientTimeout: 10_000 });

server.on('connect', (client) => console.log('connected', client.key));

server.on('receivePacket', (id, bs, address, port, client) => {
  if (id === 1) {
    console.log('hello from', client.key, bs.readString8());
    server.sendAll(2, new BitStream().writeString8('snetwork'), SNET_PRIORITIES.HIGH);
  }
});

await server.listen();

const client = new Client({ port: 11321 });
client.on('receivePacket', (id, bs) => console.log('server says', id, bs.readString8()));
await client.connect();

// resolves when the server confirms the packet
await client.sendAsync(1, new BitStream().writeString8('hello world'), SNET_PRIORITIES.HIGH);
```

## Priorities

| priority | delivery |
| --- | --- |
| `BYPASS` | fire and forget |
| `LOW` | re-sent up to 5 times until confirmed |
| `MEDIUM` | up to 10 times |
| `HIGH` | up to 20 times |
| `SYSTEM` | until confirmed or the remote disconnects |

A reliable packet that runs out of resends emits `packetLost`, and `sendAsync` rejects with `PacketLostError`.
Duplicates of reliable packets are confirmed again but delivered only once.

## BitStream

Byte-sized values (`writeUInt8`, `writeInt16`, `writeUInt32`, `writeFloat`, `writeBoolean`, `writeString`, ...)
are little-endian and produce the same bytes as Lua SNET's `bstream`. On top of that, bits work like in RakNet:

```ts
const bs = new BitStream()
  .writeBit(true)                          // 1 bit
  .writeBits(5, 3)                         // 3 bits
  .writeRangedInt(42, 0, 100)              // 7 bits
  .writeRangedFloat(12.34, 0, 100, 12)     // 12 bits
  .writeNormVector(0.6, -0.8, 0)           // 3 x 16 bits
  .writeQuat(1, 0, 0, 0)                   // 2 + 3 x 15 bits
  .writeVarUInt(300)                       // LEB128
  .writeString8('привет')                  // u8 byte length + utf8
  .writeInt64(-5n)
  .alignWrite();                           // pad to the next byte

bs.readBit(); bs.readBits(3); bs.readRangedInt(0, 100); // ...
bs.toBinaryString(); // '1101...' for debugging
```

Multi-byte values written at an unaligned offset are packed bit by bit (no implicit alignment).
Bits are packed MSB-first inside each byte.

## Options

```ts
new Server({
  address: '0.0.0.0',
  port: 13322,
  ipVersion: 'v4',             // inferred from address
  clientTimeout: 60_000,       // drop silent clients
  blockPacketTimeout: 60_000,  // how often blocked addresses get SNET_BLOCK_PACKET
  maxTransferBytes: 1400,      // max payload, bigger sends throw
  resendInterval: 500,         // ms between resends
  recvBufferSize: 4 << 20,     // OS socket buffers (capped by net.core.rmem_max on linux)
  sendBufferSize: 4 << 20,
  legacyTerminator: false,     // true to talk to node-snet 1.x / SLMP-Team SNET
});

new Client({ /* same */ timeout: 60_000 }); // no packets from the server -> 'timeout'
```

You can also build client options from a URL: `convertClientConnectionString('snet://[::1]:13322?mtb=1024')`.

On Linux, the OS caps socket buffers at `net.core.rmem_max` (about 208 KB by default). If you send big bursts of
`BYPASS` packets, raise it: `sysctl -w net.core.rmem_max=8388608`.

## Lua SNET compatibility

Wire format (RazorRw/SNET `19aecbe`): `[0x00][u32 uniqueId][u32 packetId][u8 priority][payload]`, little-endian.
Service packet ids: `0xFFFFFFFF` is the confirmation, `0xFFFFFFFE` means blocked.

- node-snet 1.x and SLMP-Team SNET append a trailing `0x00`, so set `legacyTerminator: true` for them.
- Razor's `client.lua` and `server.lua` use a global `socket` (`socket.gettime()`) without requiring it. Outside
  hosts that expose it globally (MoonLoader), set `socket = require('socket')` before `require('snet')`.
- Razor's `process()` reads one datagram per call, and its socket keeps the OS default buffer. Under bursts, the Lua
  side drops `BYPASS` packets. Call `process()` several times per frame.

## Development

```bash
pnpm install
pnpm test:setup   # luajit + luasocket + pinned RazorRw/SNET for interop tests
pnpm test
pnpm changeset    # describe your change, it goes into CHANGELOG.md on release
```

Releases: `pnpm version-packages` bumps the version and writes `CHANGELOG.md`. Commit and push to `master`. Once CI
passes, the release workflow publishes the new version to npm (trusted publishing + provenance) and creates a GitHub
release.
