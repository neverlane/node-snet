import { Client, BitStream } from '../src';

const client = new Client({
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