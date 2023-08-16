import { ClientOptions } from './client';
import { IpVersion } from './types';

export const convertClientConnectionString = (url: URL): ClientOptions => {
  if (url.protocol !== 'snet:') throw new TypeError(`unknown protocol ${url.protocol}`);
  const ipVersion = url.searchParams.get('ipv') as IpVersion ?? undefined;
  const maxTransferBytes = url.searchParams.has('mtb') ? +url.searchParams.has('mtb') : undefined;
  if (Number.isNaN(maxTransferBytes)) throw new TypeError('mtb cant be NaN');
  const port = url.port.length > 0 ? +url.port : 13322;
  return {
    address: url.hostname,
    ipVersion,
    maxTransferBytes,
    port,
  }
};