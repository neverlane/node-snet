import { SNetClient, BitStream } from '..';

const client = new SNetClient({
  port: 11321
});

client.on('ready', () => {
  console.log('@client: started');
  const data = new BitStream();
  data.writeString('hello world maaan');
  client.send(1, data, 4);
});

client.on('onReceivePacket', async (id, bs) => {
  console.log('onReceivePacket:', id, bs.toString());
});

client.connect();