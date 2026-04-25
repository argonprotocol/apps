#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface DevGatewayCertOptions {
  app?: string;
  appInstance?: string;
  network?: string;
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = Path.resolve(Path.dirname(scriptPath), '..');
const rootCaCommonName = 'Argon Local Dev Gateway CA';
const leafCommonName = 'localhost';
const rootCaRenewSeconds = 90 * 24 * 60 * 60;
const leafRenewSeconds = 30 * 24 * 60 * 60;

if (isMainModule()) {
  void ensureDevGatewayCerts().catch(error => {
    console.error(`[dev-gateway-certs] ${(error as Error).message}`);
    process.exit(1);
  });
}

export async function ensureDevGatewayCerts(options: DevGatewayCertOptions = {}): Promise<void> {
  const certHome = getCertHome();
  const rootCaPath = Path.join(certHome, 'rootCA.pem');
  const rootCaKeyPath = Path.join(certHome, 'rootCA-key.pem');
  const localhostCertDir = Path.join(certHome, 'localhost');
  const leafCertPath = Path.join(localhostCertDir, 'cert.pem');
  const fullchainPath = Path.join(localhostCertDir, 'fullchain.pem');
  const leafKeyPath = Path.join(localhostCertDir, 'privkey.pem');

  Fs.mkdirSync(localhostCertDir, { recursive: true });

  if (shouldCreateRootCa(rootCaPath, rootCaKeyPath)) {
    console.info(`[dev-gateway-certs] Creating local dev CA at ${certHome}`);
    createRootCa(rootCaPath, rootCaKeyPath);
  }

  if (shouldCreateLeafCert(leafCertPath, leafKeyPath, rootCaPath)) {
    console.info('[dev-gateway-certs] Creating localhost gateway certificate');
    createLocalhostCertificate({
      certDir: localhostCertDir,
      rootCaPath,
      rootCaKeyPath,
      leafCertPath,
      fullchainPath,
      leafKeyPath,
    });
  }

  if (process.platform === 'darwin' && !readBooleanEnv('ARGON_DEV_GATEWAY_SKIP_TRUST')) {
    trustRootCaOnMac(rootCaPath);
  }

  const targets = getCertificateTargetDirs(options);
  for (const target of targets) {
    Fs.mkdirSync(target, { recursive: true });
    Fs.copyFileSync(fullchainPath, Path.join(target, 'fullchain.pem'));
    Fs.copyFileSync(leafKeyPath, Path.join(target, 'privkey.pem'));
    Fs.copyFileSync(rootCaPath, Path.join(target, 'rootCA.pem'));
    setPrivateKeyMode(Path.join(target, 'privkey.pem'));
  }

  console.info(`[dev-gateway-certs] Gateway certificate ready for ${targets.length} nginx target(s)`);
}

function isMainModule(): boolean {
  const executedPath = process.argv[1] ? Path.resolve(process.argv[1]) : '';
  return import.meta.url === pathToFileURL(executedPath).href;
}

function getCertHome(): string {
  return readNonEmptyEnv('ARGON_DEV_GATEWAY_CERT_HOME') ?? Path.join(Os.homedir(), '.argon', 'dev-gateway-ca');
}

function shouldCreateRootCa(rootCaPath: string, rootCaKeyPath: string): boolean {
  if (!Fs.existsSync(rootCaPath) || !Fs.existsSync(rootCaKeyPath)) return true;
  if (!certificateIsValidFor(rootCaPath, rootCaRenewSeconds)) return true;
  return !certificateMatchesPrivateKey(rootCaPath, rootCaKeyPath);
}

function shouldCreateLeafCert(leafCertPath: string, leafKeyPath: string, rootCaPath: string): boolean {
  if (!Fs.existsSync(leafCertPath) || !Fs.existsSync(leafKeyPath)) return true;
  if (!certificateIsValidFor(leafCertPath, leafRenewSeconds)) return true;
  if (!certificateMatchesPrivateKey(leafCertPath, leafKeyPath)) return true;
  return !certificateIsIssuedByRoot(leafCertPath, rootCaPath) || !certificateHasLocalhostNames(leafCertPath);
}

function createRootCa(rootCaPath: string, rootCaKeyPath: string): void {
  createRsaPrivateKey(rootCaKeyPath, 3072);
  runOpenSsl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    rootCaKeyPath,
    '-sha256',
    '-days',
    '3650',
    '-out',
    rootCaPath,
    '-subj',
    `/CN=${rootCaCommonName}`,
  ]);
}

function createLocalhostCertificate(args: {
  certDir: string;
  rootCaPath: string;
  rootCaKeyPath: string;
  leafCertPath: string;
  fullchainPath: string;
  leafKeyPath: string;
}): void {
  const csrPath = Path.join(args.certDir, 'localhost.csr');
  const opensslConfigPath = Path.join(args.certDir, 'localhost.openssl.cnf');
  const serialPath = Path.join(args.certDir, 'rootCA.srl');

  Fs.writeFileSync(opensslConfigPath, localhostOpenSslConfig());

  createRsaPrivateKey(args.leafKeyPath, 2048);
  runOpenSsl(['req', '-new', '-key', args.leafKeyPath, '-out', csrPath, '-config', opensslConfigPath]);
  runOpenSsl([
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    args.rootCaPath,
    '-CAkey',
    args.rootCaKeyPath,
    '-CAcreateserial',
    '-out',
    args.leafCertPath,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    opensslConfigPath,
    '-extensions',
    'v3_req',
  ]);

  Fs.writeFileSync(args.fullchainPath, `${Fs.readFileSync(args.leafCertPath)}${Fs.readFileSync(args.rootCaPath)}`);
  Fs.rmSync(csrPath, { force: true });
  Fs.rmSync(opensslConfigPath, { force: true });
  Fs.rmSync(serialPath, { force: true });
}

function trustRootCaOnMac(rootCaPath: string): void {
  const fingerprint = certificateFingerprint(rootCaPath);
  const markerPath = Path.join(Path.dirname(rootCaPath), 'macos-trusted-fingerprint');
  const trustedFingerprint = readExistingFile(markerPath)?.trim();
  if (trustedFingerprint === fingerprint) return;

  console.info('[dev-gateway-certs] macOS will prompt to trust the Argon local dev CA');
  try {
    execFileSync(
      'security',
      ['add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'ssl', '-k', loginKeychainPath(), rootCaPath],
      { stdio: 'inherit' },
    );
    Fs.writeFileSync(markerPath, `${fingerprint}\n`);
  } catch (error) {
    throw new Error(
      `Unable to trust the Argon local dev CA. Run with ARGON_DEV_GATEWAY_SKIP_TRUST=1 to skip trust setup, or install ${rootCaPath} manually. ${(error as Error).message}`,
    );
  }
}

function getCertificateTargetDirs(options: DevGatewayCertOptions): string[] {
  const configuredTargets = readNonEmptyEnv('ARGON_DEV_GATEWAY_CERT_TARGETS');
  if (configuredTargets) {
    return configuredTargets.split(Path.delimiter).map(target => Path.resolve(target));
  }

  const network = options.network ?? readNonEmptyEnv('ARGON_NETWORK_NAME') ?? 'dev-docker';
  const instanceName = normalizeInstanceName(options.appInstance ?? readNonEmptyEnv('ARGON_APP_INSTANCE') ?? 'e2e');
  const appIds = getLocalAppIds(options.app ?? readNonEmptyEnv('ARGON_APP'));
  const appConfigBaseDir = getAppConfigBaseDir();
  const targets = new Set<string>([Path.join(repoRoot, 'config', 'nginx-certs')]);

  for (const appId of appIds) {
    targets.add(
      Path.join(appConfigBaseDir, appId, network, instanceName, 'virtual-machine', 'app', 'config', 'nginx-certs'),
    );
  }

  return [...targets];
}

function getLocalAppIds(app?: string): string[] {
  if (app === 'operations') return ['com.argon.operations.local'];
  if (app === 'treasury') return ['com.argon.treasury.local'];
  return ['com.argon.operations.local', 'com.argon.treasury.local'];
}

function getAppConfigBaseDir(): string {
  if (process.platform === 'darwin') {
    return Path.join(Os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || Path.join(Os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
}

function normalizeInstanceName(appInstance: string): string {
  return appInstance.split(':')[0] || 'e2e';
}

function certificateIsValidFor(certPath: string, seconds: number): boolean {
  try {
    const cert = readCertificate(certPath);
    const now = Date.now();
    return cert.validFromDate.getTime() <= now && cert.validToDate.getTime() > now + seconds * 1000;
  } catch {
    return false;
  }
}

function certificateFingerprint(certPath: string): string {
  return readCertificate(certPath).fingerprint256;
}

function certificateMatchesPrivateKey(certPath: string, keyPath: string): boolean {
  try {
    const cert = readCertificate(certPath);
    const key = createPrivateKey(Fs.readFileSync(keyPath));
    return cert.checkPrivateKey(key);
  } catch {
    return false;
  }
}

function certificateIsIssuedByRoot(certPath: string, rootCaPath: string): boolean {
  try {
    const cert = readCertificate(certPath);
    const rootCa = readCertificate(rootCaPath);
    return cert.checkIssued(rootCa) && cert.verify(rootCa.publicKey);
  } catch {
    return false;
  }
}

function certificateHasLocalhostNames(certPath: string): boolean {
  try {
    const cert = readCertificate(certPath);
    return (
      cert.checkHost('localhost') === 'localhost' && cert.checkIP('127.0.0.1') === '127.0.0.1' && !!cert.checkIP('::1')
    );
  } catch {
    return false;
  }
}

function readCertificate(certPath: string): X509Certificate {
  return new X509Certificate(Fs.readFileSync(certPath));
}

function createRsaPrivateKey(path: string, modulusLength: number): void {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength });
  Fs.writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  setPrivateKeyMode(path);
}

function localhostOpenSslConfig(): string {
  return `
[req]
distinguished_name=req_distinguished_name
prompt=no

[req_distinguished_name]
CN=${leafCommonName}

[v3_req]
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
DNS.1=localhost
IP.1=127.0.0.1
IP.2=::1
`;
}

function runOpenSsl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

function loginKeychainPath(): string {
  return Path.join(Os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

function setPrivateKeyMode(path: string): void {
  try {
    Fs.chmodSync(path, 0o600);
  } catch {
    // Windows and unusual filesystems may not support POSIX modes.
  }
}

function readExistingFile(path: string): string | undefined {
  try {
    return Fs.readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBooleanEnv(name: string): boolean {
  const value = readNonEmptyEnv(name);
  return value === '1' || value === 'true';
}
