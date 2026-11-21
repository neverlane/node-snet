import type { ClientOptions } from './client';
import type { IpVersion } from './types';

/**
 * snet://host[:port][?ipv=v4|v6&mtb=1400&tick=50&legacy=1]
 * IPv6 hosts go in brackets: snet://[::1]:13322
 */
export const convertClientConnectionString = (url: URL | string): ClientOptions => {
  if (typeof url === 'string') url = new URL(url);
  if (url.protocol !== 'snet:') throw new TypeError(`unknown protocol ${url.protocol}`);

  const address = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const ipv = url.searchParams.get('ipv');
  if (ipv !== null && ipv !== 'v4' && ipv !== 'v6') throw new TypeError(`ipv must be v4 or v6, got ${ipv}`);
  const ipVersion: IpVersion = (ipv as IpVersion | null) ?? (address.includes(':') ? 'v6' : 'v4');

  const num = (name: string) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const v = Number(raw);
    if (!Number.isInteger(v) || v <= 0) throw new TypeError(`${name} must be a positive integer, got ${raw}`);
    return v;
  };
  const legacy = url.searchParams.get('legacy');

  return {
    address,
    ipVersion,
    port: url.port.length > 0 ? +url.port : 13322,
    maxTransferBytes: num('mtb'),
    tickTimeout: num('tick'),
    ...(legacy !== null ? { legacyTerminator: legacy === '1' || legacy === 'true' } : {}),
  };
};
