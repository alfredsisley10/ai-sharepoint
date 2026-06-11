import {
  INetworkModule,
  NetworkRequestOptions,
  NetworkResponse,
} from "@azure/msal-node";
import { emitWire, safeUrl } from "../core/wireLog";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * MSAL network module backed by the extension host's global `fetch`.
 *
 * msal-node's default HTTP client uses Node's raw https stack, which ignores
 * VS Code's proxy settings and the operating-system trust store — so sign-in
 * dies with `network_error` behind corporate proxies that require
 * authentication or TLS inspection (MITM with an enterprise root CA).
 * VS Code patches the extension host's `fetch` to route through its
 * networking layer (`http.proxy` / OS proxy, `http.systemCertificates`,
 * proxy auth), which is exactly how this extension's Microsoft Graph calls
 * already travel. Routing MSAL's token traffic through the same `fetch`
 * makes auth work wherever Graph works.
 */
export class FetchNetworkClient implements INetworkModule {
  sendGetRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.send<T>("GET", url, options);
  }

  sendPostRequestAsync<T>(
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    return this.send<T>("POST", url, options);
  }

  private async send<T>(
    method: "GET" | "POST",
    url: string,
    options?: NetworkRequestOptions,
  ): Promise<NetworkResponse<T>> {
    const started = Date.now();
    // Token traffic: URL + status only, EVER — request bodies carry auth
    // codes/refresh tokens and responses carry access tokens, so the wire
    // log structurally withholds both rather than trusting redaction.
    emitWire("msal", "→", `${method} ${safeUrl(url)} (request/response bodies withheld — token material)`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: options?.headers,
        body: options?.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      emitWire(
        "msal",
        "✗",
        `${method} ${safeUrl(url)} — ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`,
      );
      throw err;
    }
    emitWire("msal", "←", `${method} ${safeUrl(url)} ${res.status} (${Date.now() - started}ms)`);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // Entra endpoints answer JSON for success and error responses alike; an
    // unparseable body (proxy block page, HTML error) becomes an empty object
    // so MSAL surfaces the HTTP status instead of a parse crash.
    const body = (await res.json().catch(() => ({}))) as T;
    return { headers, body, status: res.status };
  }
}
