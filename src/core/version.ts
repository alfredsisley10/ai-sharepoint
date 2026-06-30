/**
 * The version COMPILED INTO the running code — deliberately independent of
 * `context.extension.packageJSON.version`, which reports whatever manifest
 * VS Code loaded. When the two disagree, the installation is TORN: new
 * extension.js running against a stale cached manifest, so views/commands
 * added by newer releases silently don't exist in the UI (pilot: the view
 * container still showed pre-0.20 names while 0.23+ features ran, and
 * "Projects" could not be enabled because the loaded manifest never
 * declared it). A test asserts this constant matches package.json on every
 * release.
 */
export const EXTENSION_VERSION = "0.100.0";
