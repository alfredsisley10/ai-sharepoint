import * as vscode from "vscode";

/**
 * Stored SharePoint browser-session connections (ADR-0046). The session COOKIES
 * live in the OS keychain (SecretStorage), keyed by site URL; only non-secret
 * descriptors (URL, web title, account, when added) live in globalState. This
 * is the no-admin write path: the user's own signed-in session, replayed.
 */

export interface SessionSiteDescriptor {
  siteUrl: string;
  webTitle: string;
  account: string;
  addedAt: string;
  lastVerifiedAt?: string;
}

const KEY = "aiSharePoint.spSessions";
const secretKey = (siteUrl: string) => `sp-session:${siteUrl.replace(/\/+$/, "")}`;
const norm = (siteUrl: string) => siteUrl.replace(/\/+$/, "");

export class SharePointSessionStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly memento: vscode.Memento,
  ) {}

  list(): SessionSiteDescriptor[] {
    return this.memento.get<SessionSiteDescriptor[]>(KEY, []);
  }

  get(siteUrl: string): SessionSiteDescriptor | undefined {
    return this.list().find((s) => s.siteUrl === norm(siteUrl));
  }

  /** Match a chat-supplied reference (URL or web title, case-insensitive) to a
   *  connected session — or the only one when there's exactly one. */
  resolve(ref?: string): SessionSiteDescriptor | undefined {
    const all = this.list();
    if (!ref) return all.length === 1 ? all[0] : undefined;
    const r = ref.trim().toLowerCase().replace(/\/+$/, "");
    return (
      all.find((s) => s.siteUrl.toLowerCase() === r) ??
      all.find((s) => s.webTitle.toLowerCase() === r) ??
      all.find((s) => s.siteUrl.toLowerCase().includes(r) || s.webTitle.toLowerCase().includes(r))
    );
  }

  async cookies(siteUrl: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(siteUrl));
  }

  async connect(descriptor: SessionSiteDescriptor, cookies: string): Promise<void> {
    const siteUrl = norm(descriptor.siteUrl);
    await this.secrets.store(secretKey(siteUrl), cookies);
    const rest = this.list().filter((s) => s.siteUrl !== siteUrl);
    await this.memento.update(KEY, [...rest, { ...descriptor, siteUrl }]);
    this.emitter.fire();
  }

  async markVerified(siteUrl: string, at: string): Promise<void> {
    const list = this.list().map((s) => (s.siteUrl === norm(siteUrl) ? { ...s, lastVerifiedAt: at } : s));
    await this.memento.update(KEY, list);
    this.emitter.fire();
  }

  async remove(siteUrl: string): Promise<void> {
    const s = norm(siteUrl);
    await this.secrets.delete(secretKey(s));
    await this.memento.update(KEY, this.list().filter((x) => x.siteUrl !== s));
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
