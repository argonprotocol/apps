import { execFileSync } from 'node:child_process';
import Fs from 'node:fs';
import config from '../src-tauri/tauri.conf.json' with { type: 'json' };

const profileData = Fs.readFileSync(new URL('../src-tauri/Distribution.provisionprofile', import.meta.url));
const decodedProfile = execFileSync('security', ['cms', '-D'], { input: profileData });
const entitlements = JSON.parse(
  execFileSync('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', '-'], {
    input: decodedProfile,
    encoding: 'utf8',
  }),
) as {
  'com.apple.application-identifier': string;
  'com.apple.developer.team-identifier': string;
  'keychain-access-groups'?: string[];
};
const expiration = execFileSync('plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', '-'], {
  input: decodedProfile,
  encoding: 'utf8',
});
if (new Date(expiration.trim()).getTime() <= Date.now()) {
  throw new Error('The macOS provisioning profile has expired. Replace src-tauri/Distribution.provisionprofile.');
}

const overrides = JSON.parse(process.env.TAURI_CONFIG ?? '{}') as Partial<typeof config>;
const identifier = overrides.identifier ?? config.identifier;
const prefix = `${entitlements['com.apple.application-identifier'].split('.')[0]}.`;
const applicationIdentifier = `${prefix}${identifier}`;
if (!profileAllowsIdentifier(entitlements['com.apple.application-identifier'], applicationIdentifier)) {
  throw new Error('The macOS provisioning profile does not authorize the configured bundle identifier.');
}
const groups = entitlements['keychain-access-groups'] ?? [];
if (!groups.some(group => profileAllowsIdentifier(group, applicationIdentifier))) {
  throw new Error('The macOS provisioning profile does not authorize the app keychain access group.');
}

const template = Fs.readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url), 'utf8');
const rendered = template
  .replaceAll('$(AppIdentifierPrefix)', prefix)
  .replaceAll('$(PRODUCT_BUNDLE_IDENTIFIER)', identifier)
  .replaceAll('$(DEVELOPMENT_TEAM)', entitlements['com.apple.developer.team-identifier']);

const directory = new URL('../src-tauri/gen/apple/', import.meta.url);
Fs.mkdirSync(directory, { recursive: true });
Fs.writeFileSync(new URL('Entitlements.plist', directory), rendered);

function profileAllowsIdentifier(pattern: string, identifier: string): boolean {
  if (pattern.endsWith('*')) return identifier.startsWith(pattern.slice(0, -1));
  return pattern === identifier;
}
