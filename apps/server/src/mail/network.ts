import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function isPublicAddress(address: string) {
  try {
    // Reject mapped IPv4 and transition ranges as well as private/link-local/reserved space.
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export async function resolveMailHost(host: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    isIP(host)
      ? Promise.resolve([{ address: host, family: isIP(host) }])
      : dns.lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Mail DNS lookup timed out')),
        5000,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error('Mail server must resolve exclusively to public addresses');
  const address = addresses[0];
  if (!address) throw new Error('Mail server unavailable');
  return address.address;
}
