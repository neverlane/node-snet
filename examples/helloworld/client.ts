import { Client, BitStream, SNET_PRIORITIES } from '../../src';

const client = new Client({
  port: 11321,
  ipVersion: 'v6',
});

client.on('ready', async () => {
  console.log('@client: started');
  await client.sendAsync(1, new BitStream().writeString('hello world maaan'), SNET_PRIORITIES.SYSTEM);
  console.log('@client: server confirmed');
});

client.on('receivePacket', (id, bs) => {
  console.log('receivePacket:', id, bs.toString());
});

client.connect();
