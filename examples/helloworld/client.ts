import { Client, BitStream } from '../../src';

const client = new Client({
  port: 11321,
  ipVersion: 'v6'
});

client.on('ready', () => {
  console.log('@client: started');
  const data = new BitStream();
  data.writeString('hello world maaan');
  client.send(1, data, 4);
});

client.on('receivePacket', async (id, bs) => {
  console.log('receivePacket:', id, bs.toString());
});

client.connect();
