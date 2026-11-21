<!-- markdownlint-disable MD033 -->
<!-- markdownlint-disable MD041 -->
<!-- markdownlint-disable MD013 -->
<div align="center">

  # node-snet

  **simple network: reliable udp for node.js**  
  *priorities · confirmations · raknet-style bitstream · lua snet compatible*

  [![npm version](https://img.shields.io/npm/v/node-snet?style=flat-square&logo=npm&labelColor=000000)](https://www.npmjs.com/package/node-snet)
  [![ci](https://img.shields.io/github/actions/workflow/status/neverlane/node-snet/ci.yml?branch=master&style=flat-square&logo=github&label=ci&labelColor=000000)](https://github.com/neverlane/node-snet/actions/workflows/ci.yml)
  [![github stars](https://img.shields.io/github/stars/neverlane/node-snet?style=flat-square&logo=github&labelColor=000000)](https://github.com/neverlane/node-snet/stargazers)
  [![license](https://img.shields.io/npm/l/node-snet?style=flat-square&labelColor=000000)](https://www.npmjs.com/package/node-snet)

</div>

node-snet is a node.js port of [snet](https://github.com/RazorRw/SNET) for luajit. it sends packets over udp with
a priority each: fire-and-forget, or re-sent until the other side confirms them. it speaks the same wire format as
lua snet, so node and lua servers and clients mix freely. the interop is tested against real luajit peers.

```ts
import { BitStream, Client, Server, SNET_PRIORITIES } from "node-snet";

const server = new Server({ port: 11321 });

server.on("receivePacket", (id, bs, address, port, client) => {
  if (id === 1) {
    console.log(`hello from ${client.key}:`, bs.readString8());
    server.sendAll(2, new BitStream().writeString8("snetwork"), SNET_PRIORITIES.HIGH);
  }
});

await server.listen();

const client = new Client({ port: 11321 });
client.on("receivePacket", (id, bs) => console.log("server says", id, bs.readString8()));
await client.connect();

// resolves once the server confirms the packet
await client.sendAsync(1, new BitStream().writeString8("hello world"), SNET_PRIORITIES.HIGH);
```

### why node-snet

- each packet has a priority: `BYPASS` packets are fire-and-forget, the rest are re-sent until confirmed.
- `sendAsync` resolves when the remote confirms, `packetLost` fires when the resends run out.
- duplicates are confirmed again but delivered only once.
- `BitStream` writes single bits, ranged ints, quantized floats, vectors and quaternions, like raknet.
- byte-aligned writes match lua `bstream` byte for byte, so lua code can read them.
- one dependency-free package with esm + cjs builds and full typescript types.

### install

```sh
pnpm add node-snet
```

```sh
npm install node-snet
yarn add node-snet
```

needs node >= 22.

### priorities

| priority | delivery |
|:---------|:---------|
| `BYPASS` | fire and forget |
| `LOW` | re-sent up to 5 times until confirmed |
| `MEDIUM` | up to 10 times |
| `HIGH` | up to 20 times |
| `SYSTEM` | until confirmed or the remote disconnects |

### bitstream

```ts
const bs = new BitStream()
  .writeBit(true)                          // 1 bit
  .writeBits(5, 3)                         // 3 bits
  .writeRangedInt(42, 0, 100)              // 7 bits
  .writeRangedFloat(12.34, 0, 100, 12)     // 12 bits
  .writeNormVector(0.6, -0.8, 0)           // 3 × 16 bits
  .writeQuat(1, 0, 0, 0)                   // 2 + 3 × 15 bits
  .writeVarUInt(300)                       // leb128
  .writeString8("привет")                  // u8 byte length + utf8
  .writeInt64(-5n)
  .alignWrite();                           // pad to the next byte

bs.readBit(); bs.readBits(3); bs.readRangedInt(0, 100); // ...
bs.toBinaryString(); // "1101…" for debugging
```

| group | methods |
|:------|:--------|
| bits | `writeBit` `writeBits` `writeSignedBits` `alignWrite` `alignRead` `writeBitStream` |
| compact | `writeRangedInt` `writeRangedFloat` `writeNormalizedFloat` `writeNormVector` `writeQuat` `writeVarUInt` `writeVarInt` |
| numbers | `writeInt8/16/32/64` `writeUInt8/16/32/64` `writeFloat` `writeDouble` `writeBoolean` |
| bytes & strings | `writeBytes` `writeString` (raw, lua compatible) `writeString8/16/32` (length-prefixed) |

every `write*` has a matching `read*`. numbers are little-endian. a multi-byte value at an unaligned offset is
packed bit by bit, with no implicit alignment. inside a byte, bits go msb-first, like raknet.

### options

```ts
new Server({
  address: "0.0.0.0",
  port: 13322,
  ipVersion: "v4",             // inferred from address
  clientTimeout: 60_000,       // drop silent clients
  blockPacketTimeout: 60_000,  // how often blocked addresses get SNET_BLOCK_PACKET
  maxTransferBytes: 1400,      // max payload, bigger sends throw
  resendInterval: 500,         // ms between resends
  recvBufferSize: 4 << 20,     // os socket buffers, capped by net.core.rmem_max on linux
  sendBufferSize: 4 << 20,
  legacyTerminator: false,     // true to talk to node-snet 1.x / slmp-team snet
});

new Client({ /* same */ timeout: 60_000 }); // no packets from the server → "timeout"
```

| event | client | server |
|:------|:------:|:------:|
| `receivePacket` / `onReceivePacket` | ✓ | ✓ |
| `connected` · `timeout` · `blocked` | ✓ | |
| `connect` · `timeout` (with a `ServerClient`) | | ✓ |
| `clientUpdate` / `onClientUpdate` | | ✓ |
| `packetLost` · `ready` · `close` · `error` | ✓ | ✓ |

client options can also come from a url: `convertClientConnectionString("snet://[::1]:13322?mtb=1024")`.

on linux the os caps socket buffers at `net.core.rmem_max`, about 208 kb by default. if you send big bursts of
`BYPASS` packets, raise it with `sysctl -w net.core.rmem_max=8388608`.

### lua snet compatibility

the wire format follows [RazorRw/SNET](https://github.com/RazorRw/SNET) at `19aecbe`:
`[0x00][u32 uniqueId][u32 packetId][u8 priority][payload]`, all little-endian. `0xFFFFFFFF` is the confirmation
packet and `0xFFFFFFFE` means you are blocked.

| peer | setting |
|:-----|:--------|
| razorrw/snet (lua) | default |
| node-snet 1.x, slmp-team snet | `legacyTerminator: true`, because they append a trailing `0x00` |

notes for the lua side:

- razor's `client.lua` and `server.lua` call a global `socket` (`socket.gettime()`) that is never required.
  moonloader exposes `socket` globally. anywhere else, set `socket = require("socket")` before `require("snet")`.
- razor's `process()` reads one datagram per call and keeps the os default socket buffer, so bursts of `BYPASS`
  packets get dropped on the lua side. call `process()` several times per frame.

### development

```sh
pnpm install
pnpm test:setup   # luajit + luasocket + pinned razorrw/snet for the interop tests
pnpm test
pnpm changeset    # describe your change; it lands in CHANGELOG.md on release
```

| path | what |
|:-----|:-----|
| [`src/`](/src/) | library: `BitStream`, `Peer` (reliability), `Client`, `Server` |
| [`tests/`](/tests/) | wire, bitstream, feature, interop and load tests |
| [`tests/lua/peer.lua`](/tests/lua/peer.lua) | lua snet test peer controlled over snet itself |
| [`examples/`](/examples/) | runnable hello world server and client |
| [`scripts/`](/scripts/) | lua setup, publish and release scripts |

### releases

run `pnpm version-packages` to bump the version and write `CHANGELOG.md`, then commit and push to `master`.
once ci passes, [release.yml](/.github/workflows/release.yml) publishes the new version to npm with trusted
publishing and provenance, and creates a github release.
