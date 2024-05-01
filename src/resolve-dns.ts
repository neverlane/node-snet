import { Resolver } from 'node:dns';

export interface ResolveDnsOptions {
  domain: string;
  version: 'v4' | 'v6';
  servers?: string[];
}

export const resolveDns = ({ domain, version, servers }: ResolveDnsOptions): Promise<string | null> => {
  return new Promise<string | null>((resolve) => {
    if (!domain) throw new TypeError('resolveDns: options.domain not passed');
    if (!version) throw new TypeError('resolveDns: options.version not passed');
    
    const resolver = new Resolver();
    if (servers) resolver.setServers(servers);
    
    let _resolve: typeof resolver.resolve4;
    if (version === 'v4') {
      _resolve = resolver.resolve4;
    } else if (version === 'v6') {
      _resolve = resolver.resolve6;
    } else {
      resolve(null);
      return;
    }
    _resolve.bind(resolver)(domain, (error, addresses) => {
      if (error || addresses.length === 0) {
        resolve(null);
      } else {
        resolve(addresses[0]);
      }
    });
  });
}