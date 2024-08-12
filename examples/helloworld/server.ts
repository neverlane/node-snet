import { Server, BitStream } from '../../src';

const server = new Server({
  port: 11321,
  clientTimeout: 10000,
  ipVersion: 'v6'
});

server.on('ready', () => {
  console.log(`@server: started at port ${server.port}`);
});

server.on('receivePacket', async (id, bs, address, port) => {
  console.log(`receivePacket: ${address}:${port}`, id, bs.toString());
  if (id === 1) {
    const data = new BitStream();
    data.writeString('snetwork');
    server.sendAll(2, data, 4);
  }
});

server.on('clientUpdate', async (address, port, type) => {
  console.log(`clientUpdate ${address}:${port}:`, type);
});

server.listen();

// or change port
// server.listen(7788).then(() => console.log('listen'))
