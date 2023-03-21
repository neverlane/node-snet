import { SNetServer, BitStream } from '..';

const server = new SNetServer({
  port: 11321,
  clientTimeout: 10000
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