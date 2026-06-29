import { SecretStore } from "../secrets/secretStore";
import { SharePointAuthProvider } from "./types";
import { MsalPublicClientProvider } from "./msalPublicProvider";
import { DeviceCodeProvider, DeviceCodePrompt } from "./deviceCodeProvider";
import { resolveAuthSettings } from "./authConfig";
import { AppError } from "../core/errors";

export type AuthProviderId = "msal-public-interactive" | "msal-device-code";

export const AUTH_PROVIDERS: Array<{
  id: AuthProviderId;
  label: string;
  detail: string;
}> = [
  {
    id: "msal-public-interactive",
    label: "Microsoft sign-in (system browser)",
    detail: "Recommended. Opens your browser; works with SSO and MFA.",
  },
  {
    id: "msal-device-code",
    label: "Microsoft sign-in (device code)",
    detail:
      "For VDI/remote/locked-down environments. Enter a short code on any device.",
  },
];

/**
 * Creates auth providers by id with validated, machine-scoped auth settings.
 * Both providers share the per-tenant keychain cache, so a sign-in via either
 * serves the other (PLAN §5 provider abstraction).
 */
export class AuthProviderRegistry {
  /** Providers are memoized by (id, cacheHandle, clientId): a provider owns one
   *  MSAL PublicClientApplication with a single in-memory token cache. Minting a
   *  fresh PCA per request (the old behavior) meant concurrent background reads
   *  each reloaded the keychain cache and redeemed the SAME rotating refresh
   *  token in parallel — a cache stampede whose losers got invalid_grant and
   *  forced a surprise interactive sign-in. Reusing the instance lets MSAL
   *  dedupe and serialize silent acquisitions. */
  private readonly cache = new Map<string, SharePointAuthProvider>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly onDeviceCodePrompt: (info: DeviceCodePrompt) => void,
  ) {}

  /** `clientIdOverride` lets a feature sign in as a DIFFERENT public client
   *  than the Graph default — Power BI's no-install path authenticates as
   *  the Azure CLI first-party app (pre-authorized for the Power BI service,
   *  so no per-app admin approval). Authority still comes from the
   *  machine-scoped settings, so tenant lockdown applies unchanged. */
  create(id: string, cacheHandle: string, clientIdOverride?: string): SharePointAuthProvider {
    const { authority, clientId } = resolveAuthSettings();
    const effectiveClientId = clientIdOverride?.trim() || clientId;
    const key = `${id}::${authority}::${cacheHandle}::${effectiveClientId}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    let provider: SharePointAuthProvider;
    switch (id) {
      case "msal-public-interactive":
        provider = new MsalPublicClientProvider(
          this.secrets,
          cacheHandle,
          authority,
          effectiveClientId,
        );
        break;
      case "msal-device-code":
        provider = new DeviceCodeProvider(
          this.secrets,
          cacheHandle,
          authority,
          effectiveClientId,
          this.onDeviceCodePrompt,
        );
        break;
      default:
        throw new AppError(`Unknown auth provider: ${id}`, "config");
    }
    this.cache.set(key, provider);
    return provider;
  }
}
