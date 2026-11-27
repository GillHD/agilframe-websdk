/** TURN helpers: add TCP variants so restrictive networks still get a relay path. */
import type { IceServerConfig } from '@agil/protocol';

export function withTurnTcp(servers: IceServerConfig[]): IceServerConfig[] {
  const result: IceServerConfig[] = [...servers];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (!/^turns?:/i.test(url) || /[?&]transport=/i.test(url)) continue;
      const tcp = url.includes('?') ? url + '&transport=tcp' : url + '?transport=tcp';
      if (!result.some((entry) => {
        const existing = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
        return existing.some((candidate) => candidate.toLowerCase() === tcp.toLowerCase());
      })) {
        result.push({ ...server, urls: tcp });
      }
    }
  }
  return result;
}

export function hasTurnServer(servers: IceServerConfig[]): boolean {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url));
  });
}
