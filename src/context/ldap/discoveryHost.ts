import * as os from "node:os";
import * as fs from "node:fs";
import { promises as dns } from "node:dns";
import { DnsResolver, HostSignals, discover, DiscoveryResult } from "./discovery";

/** Node-backed DNS SRV resolver (ADR-0020). */
const nodeResolver: DnsResolver = {
  async resolveSrv(name) {
    return dns.resolveSrv(name);
  },
};

/** Gather workstation signals from the real environment. */
export function realHostSignals(): HostSignals {
  let resolvConf: string | undefined;
  try {
    resolvConf = fs.readFileSync("/etc/resolv.conf", "utf8");
  } catch {
    resolvConf = undefined; // Windows / unreadable — fine
  }
  let username: string | undefined;
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USERNAME ?? process.env.USER;
  }
  return {
    env: process.env as Record<string, string | undefined>,
    hostname: os.hostname(),
    resolvConf,
    username,
  };
}

/** Run AD auto-discovery against the live workstation + DNS. */
export function discoverActiveDirectory(): Promise<DiscoveryResult> {
  return discover(nodeResolver, realHostSignals());
}
