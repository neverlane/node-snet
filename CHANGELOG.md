# node-snet

## 2.0.0

### major changes

- wire format follows [RazorRw/SNET](https://github.com/RazorRw/SNET) (`19aecbe`): no trailing `0x00` after packets and nothing is stripped on receive. 1.x lost the last payload byte of every packet from Lua SNET and could not read its confirmations (reliable packets were re-sent until their limit and piled up in memory). set `legacyTerminator: true` to talk to node-snet 1.x / SLMP-Team SNET
- `BitStream` is now bit-level (RakNet style): `writeBit`/`writeBits`/`writeSignedBits`, ranged ints, quantized floats, normalized vectors, quaternions, `alignWrite`/`alignRead`. byte-aligned writes produce the same bytes as Lua `bstream`
- `BitStream` writes overwrite at the write offset (1.x grew the buffer with garbage), `writeString` counts bytes instead of chars (utf8 was truncated), out-of-range ints throw `RangeError` (8-bit values silently wrapped), buffer grows by doubling (was O(n²))
- new `BitStream` types: `Int64`/`UInt64` (bigint), `Double`, `VarUInt`/`VarInt`, length-prefixed `String8`/`String16`/`String32`
- `send` throws `RangeError` when the payload is bigger than `maxTransferBytes` (was silently dropped); default `maxTransferBytes` is 1400
- confirmation and block packets are no longer emitted as `receivePacket`; clients get a `blocked` event instead
- `server.clients` is a `Map<string, ServerClient>`, `server.blacklist` is a `Map<string, number>`, `isBlacklisted` returns a boolean
- `send` returns the packet `uniqueId`

### minor changes

- `sendAsync` on client, server and `ServerClient`: resolves when the remote confirms, rejects with `PacketLostError`
- `packetLost` event when a reliable packet runs out of resends
- client `timeout` option + `connected`/`timeout` events; client status goes back to `DISCONNECTED`, and its `SYSTEM` packets are dropped (they were re-sent forever)
- server `connect`/`timeout` events with a `ServerClient` (`send`, `sendAsync`, `kick`), `getClient`, `sendAll(..., except)`
- options `resendInterval`, `recvBufferSize`/`sendBufferSize` (4 MB by default, 1.x used 512 bytes and dropped bursts), `dedupTtl`/`dedupSize`
- connection strings: `mtb` is parsed (it was always `1`), IPv6 brackets are stripped, `tick` and `legacy` params

### patch changes

- duplicates are tracked per remote by time (1.x remembered only the last 10 ids, so retransmissions were delivered twice under load); confirmations no longer take part in deduplication
- confirmations are matched by address and port, not only by `uniqueId`
- `sendAll` no longer stops at the first unparsable client
- header-only packets (empty payload) are accepted
- `ECONNREFUSED` (ICMP port unreachable on a connected UDP socket) is not emitted as `error`
- `connect`/`listen` reject on socket errors, `disconnect`/`stop` are safe to call twice
