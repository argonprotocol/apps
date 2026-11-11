import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { acquireDevLock } from './lock.ts';

const scriptPath = fileURLToPath(import.meta.url);
const projectPath = fileURLToPath(new URL('./macos-signing/Provisioning.xcodeproj', import.meta.url));
const entitlementsHash = createHash('sha256')
  .update(Fs.readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url)))
  .digest('hex');
const provisioningAppRelativePath = Path.join('DerivedData', 'Build', 'Products', 'Debug', 'LocalSigning.app');

export async function prepareMacosDevelopmentSigning(
  env: NodeJS.ProcessEnv,
  config: Pick<typeof import('../src-tauri/tauri.conf.json'), 'identifier' | 'productName' | 'version'>,
): Promise<string | undefined> {
  if (process.platform !== 'darwin') return;
  if (env.ARGON_MACOS_SIGNING === '0') {
    delete env.APPLE_SIGNING_IDENTITY;
    return;
  }
  if (env.ARGON_DRIVER_WS && env.ARGON_MACOS_SIGNING !== '1') {
    delete env.APPLE_SIGNING_IDENTITY;
    return;
  }
  const cacheRoot = Path.join(Os.homedir(), 'Library', 'Caches', 'com.argon.desktop', 'dev-signing');
  const preferencePath = Path.join(cacheRoot, 'preference');
  const teamPath = Path.join(cacheRoot, 'team');
  const preference = Fs.existsSync(preferencePath) ? Fs.readFileSync(preferencePath, 'utf8').trim() : undefined;
  if (preference === 'disabled' && env.ARGON_MACOS_SIGNING !== '1') {
    delete env.APPLE_SIGNING_IDENTITY;
    return;
  }

  let team = env.APPLE_DEVELOPMENT_TEAM;
  if (!team && Fs.existsSync(teamPath)) team = Fs.readFileSync(teamPath, 'utf8').trim();
  team ??= findArgonDevelopmentTeam();
  let identity = team ? readValidSigningIdentity(Path.join(cacheRoot, team, config.identifier)) : undefined;
  if (!identity && preference !== 'enabled' && env.ARGON_MACOS_SIGNING !== '1') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.info(
        '[tauri-dev] Touch ID signing is not configured. Run interactively, or set ARGON_MACOS_SIGNING=1 to set it up.',
      );
      delete env.APPLE_SIGNING_IDENTITY;
      return;
    }
    console.info(
      '[tauri-dev] Touch ID testing needs local development signing. Xcode can create the certificate and profile using your Argon team account.',
    );
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question('Set up local macOS signing now? [Y/n] ');
      if (/^n(?:o)?$/i.test(answer.trim())) {
        Fs.mkdirSync(cacheRoot, { recursive: true });
        Fs.writeFileSync(preferencePath, 'disabled\n');
        delete env.APPLE_SIGNING_IDENTITY;
        return;
      }
      if (!team) {
        console.info('Find the team ID in developer.apple.com/account → Membership Details.');
        team = (await terminal.question('Apple development team ID: ')).trim();
      }
    } finally {
      terminal.close();
    }
  }
  if (!team || !/^[A-Z0-9]{10}$/.test(team)) {
    throw new Error('Set APPLE_DEVELOPMENT_TEAM to your ten-character team ID, then retry macOS signing setup.');
  }
  const directory = Path.join(cacheRoot, team, config.identifier);

  const release = acquireDevLock(Path.join(directory, 'setup.lock'), 'macOS development signing setup');
  try {
    identity = readValidSigningIdentity(directory);
    if (!identity) {
      console.info(
        '[tauri-dev] Asking Xcode to prepare development signing. Sign in to the Argon team under Xcode → Settings → Accounts if prompted.',
      );
      const logPath = Path.join(directory, 'setup.log');
      const log = Fs.openSync(logPath, 'w');
      try {
        execFileSync(
          'xcodebuild',
          [
            '-project',
            projectPath,
            '-scheme',
            'LocalSigning',
            '-configuration',
            'Debug',
            '-derivedDataPath',
            Path.join(directory, 'DerivedData'),
            '-destination',
            'platform=macOS',
            '-allowProvisioningUpdates',
            '-allowProvisioningDeviceRegistration',
            `DEVELOPMENT_TEAM=${team}`,
            `PRODUCT_BUNDLE_IDENTIFIER=${config.identifier}`,
            'clean',
            'build',
          ],
          { stdio: ['ignore', log, log] },
        );
        const app = Path.join(directory, provisioningAppRelativePath);
        execFileSync('codesign', ['--display', `--extract-certificates=${Path.join(directory, 'certificate-')}`, app], {
          stdio: ['ignore', log, log],
        });
        const entitlements = execFileSync('codesign', ['--display', '--entitlements', '-', '--xml', app], {
          stdio: ['ignore', 'pipe', log],
        });
        Fs.writeFileSync(Path.join(directory, 'Entitlements.plist'), entitlements);
        Fs.writeFileSync(Path.join(directory, 'entitlements-hash'), entitlementsHash);
      } catch {
        throw new Error(
          `macOS signing setup failed. Sign in to the Argon team in Xcode → Settings → Accounts, then retry. Details: ${logPath}. Use ARGON_MACOS_SIGNING=0 to develop without Touch ID.`,
        );
      } finally {
        Fs.closeSync(log);
      }
      identity = readValidSigningIdentity(directory);
      if (!identity)
        throw new Error(
          'Xcode did not produce a valid local signing identity and profile. Check Xcode → Settings → Accounts and retry.',
        );
    }
    Fs.writeFileSync(teamPath, `${team}\n`);
    Fs.writeFileSync(preferencePath, 'enabled\n');
  } finally {
    release();
  }

  // Cargo's array runner preserves paths containing spaces and applies to each hot reload.
  const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Unable to determine the Rust host for macOS development signing.');
  const checkout = createHash('sha256').update(scriptPath).digest('hex').slice(0, 16);
  const cargoConfigPath = Path.join(directory, `cargo-${checkout}.toml`);
  const runner = [process.execPath, '--import', import.meta.resolve('tsx'), scriptPath, '--run-binary'];
  const temporaryConfigPath = `${cargoConfigPath}.${process.pid}.tmp`;
  Fs.writeFileSync(temporaryConfigPath, `[target.${JSON.stringify(host)}]\nrunner = ${JSON.stringify(runner)}\n`);
  Fs.renameSync(temporaryConfigPath, cargoConfigPath);
  env.APPLE_SIGNING_IDENTITY = identity;
  env.ARGON_MACOS_SIGNING_DIR = directory;
  env.ARGON_MACOS_SIGNING_APP = JSON.stringify(config);
  console.info('[tauri-dev] Local macOS signing enabled for Touch ID.');
  return cargoConfigPath;
}

async function runSignedDevelopmentBinary(binary: string, args: string[]): Promise<void> {
  if (!process.execve)
    throw new Error('macOS development signing requires Node.js 22.15 or later. Use the repository’s .nvmrc version.');
  const directory = process.env.ARGON_MACOS_SIGNING_DIR!;
  const config = JSON.parse(process.env.ARGON_MACOS_SIGNING_APP!) as typeof import('../src-tauri/tauri.conf.json');
  const targetDirectory = Path.join(process.env.ARGON_MACOS_SIGNING_RUN_DIR!, 'target');
  const debugDirectory = Path.join(targetDirectory, 'debug');

  Fs.mkdirSync(debugDirectory, { recursive: true });
  Fs.copyFileSync(binary, Path.join(debugDirectory, Path.basename(binary)));
  const bundleConfig = {
    ...config,
    build: { ...config.build, beforeBundleCommand: '' },
    bundle: {
      ...config.bundle,
      createUpdaterArtifacts: false,
      macOS: {
        entitlements: Path.join(directory, 'Entitlements.plist'),
        hardenedRuntime: false,
        files: {
          'embedded.provisionprofile': Path.join(
            directory,
            provisioningAppRelativePath,
            'Contents',
            'embedded.provisionprofile',
          ),
        },
      },
    },
  };
  const env = { ...process.env };
  process.env.CARGO_TARGET_DIR = targetDirectory;
  for (const key of [
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_API_KEY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY_PATH',
  ]) {
    delete process.env[key];
  }
  const workingDirectory = process.cwd();
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  const { run } = await import('@tauri-apps/cli');
  await run(['bundle', '--debug', '--bundles', 'app', '--config', JSON.stringify(bundleConfig)]);
  process.chdir(workingDirectory);

  const app = Path.join(debugDirectory, 'bundle', 'macos', `${config.productName}.app`);
  const executable = Fs.realpathSync(Path.join(app, 'Contents', 'MacOS', Path.basename(binary)));
  // Tauri kills and waits for this exact process during Rust hot reloads.
  process.execve(executable, [executable, ...args], env);
}

function findArgonDevelopmentTeam(): string | undefined {
  try {
    const pem = execFileSync('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    const teams = new Set<string>();
    for (const certificatePem of certificates) {
      const certificate = new X509Certificate(certificatePem);
      if (!/^O=Argon Foundation$/m.test(certificate.subject)) continue;
      if (new Date(certificate.validTo).getTime() <= Date.now()) continue;
      const team = certificate.subject.match(/^OU=([A-Z0-9]{10})$/m)?.[1];
      if (team) teams.add(team);
    }
    if (teams.size === 1) return [...teams][0];
  } catch {
    // Xcode can still create a certificate after the developer supplies the team ID.
  }
}

function readValidSigningIdentity(directory: string): string | undefined {
  try {
    if (Fs.readFileSync(Path.join(directory, 'entitlements-hash'), 'utf8') !== entitlementsHash) return;
    const certificate = new X509Certificate(Fs.readFileSync(Path.join(directory, 'certificate-0')));
    const identity = certificate.fingerprint.replaceAll(':', '');
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    if (!identities.includes(identity)) return;
    const profilePath = Path.join(directory, provisioningAppRelativePath, 'Contents', 'embedded.provisionprofile');
    const profile = execFileSync('security', ['cms', '-D', '-i', profilePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const expiration = execFileSync('plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', '-'], {
      input: profile,
      encoding: 'utf8',
    });
    if (new Date(expiration.trim()).getTime() <= Date.now()) return;
    if (!Fs.existsSync(Path.join(directory, 'Entitlements.plist'))) return;
    return identity;
  } catch {
    return;
  }
}

if (process.argv[1] && Path.resolve(process.argv[1]) === scriptPath && process.argv[2] === '--run-binary') {
  runSignedDevelopmentBinary(process.argv[3], process.argv.slice(4)).catch(error => {
    console.error(`[tauri-dev] Signed development launch failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
