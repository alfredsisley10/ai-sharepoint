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
  constructor(
    private readonly secrets: SecretStore,
    private readonly onDeviceCodePrompt: (info: DeviceCodePrompt) => void,
  ) {}

  create(id: string, cacheHandle: string): SharePointAuthProvider {
    const { authority, clientId } = resolveAuthSettings();
    switch (id) {
      case "msal-public-interactive":
        return new MsalPublicClientProvider(
          this.secrets,
          cacheHandle,
          authority,
          clientId,
        );
      case "msal-device-code":
        return new DeviceCodeProvider(
          this.secrets,
          cacheHandle,
          authority,
          clientId,
          this.onDeviceCodePrompt,
        );
      default:
        throw new AppError(`Unknown auth provider: ${id}`, "config");
    }
  }
}
