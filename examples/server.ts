import { SNetServer, BitStream } from '..';

const server = new SNetServer({
  port: 11321
});

server.on('ready', () => {
  console.log('@server: started');
});

server.on('onReceivePacket', async (id, bs) => {
  console.log('receive:', id, bs.toString());
  if (id === 1) {
    const data = new BitStream();
    data.writeString('snetwork');
    server.sendAll(2, data, 4);
  }
});