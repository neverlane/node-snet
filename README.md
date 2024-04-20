# Node Simple Network

NodeJS port of [LuaJIT SNet](https://github.com/SLMP-Team/SNET/)

SNET - cross-platform, open source, network library

## Install

```bash
npm install node-snet
yarn add node-snet
pnpm add node-snet
```

## Example

```ts
import { Server, BitStream } from 'node-snet';

const server = new Server({
  port: 11321,
  clientTimeout: 10000,
  ipVersion: 'v6'
});

server.on('ready', () => {
  console.log(`@server: started at port ${server.port}`);
});

server.on('onReceivePacket', async (id, bs, address, port) => {
  console.log(`onReceivePacket: ${address}:${port}`, id, bs.toString());
  if (id === 1) {
    const data = new BitStream();
    data.writeString('snetwork');
    server.sendAll(2, data, 4);
  }
});

server.on('onClientUpdate', async (address, port, type) => {
  console.log(`onClientUpdate ${address}:${port}:`, type);
});

server.listen();

// or change port
// server.listen(7788).then(() => console.log('listen'))
```
