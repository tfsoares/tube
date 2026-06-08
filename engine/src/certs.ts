/**
 * Tube TLS Certificate Generation — Self-signed CA + server certs
 *
 * Uses system openssl (zero npm deps). Generates:
 *   ~/.tube/ca/ca-key.pem       — EC key for the CA
 *   ~/.tube/ca/ca.pem           — Self-signed CA cert (10yr)
 *   ~/.tube/ca/server-key.pem   — EC key for the server cert
 *   ~/.tube/ca/server.pem       — Server cert signed by CA (1yr, wildcard SAN)
 *   ~/.tube/ca/host-certs/      — Per-hostname SNI certs (generated on demand)
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import * as tls from "node:tls";

// ─── Paths ───────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.TUBE_STATE_DIR || join(os.homedir() || "/tmp", ".tube");
const CA_DIR = join(STATE_DIR, "ca");
const CA_KEY_PATH = join(CA_DIR, "ca-key.pem");
const CA_CERT_PATH = join(CA_DIR, "ca.pem");
const SERVER_KEY_PATH = join(CA_DIR, "server-key.pem");
const SERVER_CERT_PATH = join(CA_DIR, "server.pem");
const SRL_PATH = join(CA_DIR, "ca.srl");
const HOST_CERTS_DIR = join(CA_DIR, "host-certs");
const TRUST_MARKER = join(CA_DIR, ".trusted");

// ─── OpenSSL helpers ─────────────────────────────────────────────────────────

let _opensslOk: boolean | undefined;

function hasOpenssl(): boolean {
  if (_opensslOk !== undefined) return _opensslOk;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore", timeout: 5000 });
    _opensslOk = true;
  } catch {
    _opensslOk = false;
  }
  return _opensslOk;
}

function openssl(args: string[]): Buffer {
  return execFileSync("openssl", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
}

// ─── CA generation ───────────────────────────────────────────────────────────

function generateCA(): void {
  mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });

  openssl([
    "ecparam", "-genkey", "-name", "prime256v1", "-noout",
    "-out", CA_KEY_PATH,
  ]);
  chmodSync(CA_KEY_PATH, 0o600);

  openssl([
    "req", "-new", "-x509", "-sha256",
    "-key", CA_KEY_PATH,
    "-out", CA_CERT_PATH,
    "-days", "3650",
    "-subj", "/CN=Tube Local CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  chmodSync(CA_CERT_PATH, 0o644);
}

// ─── Server cert generation ─────────────────────────────────────────────────

function generateServerCert(tld: string): void {
  openssl([
    "ecparam", "-genkey", "-name", "prime256v1", "-noout",
    "-out", SERVER_KEY_PATH,
  ]);
  chmodSync(SERVER_KEY_PATH, 0o600);

  const csrPath = join(CA_DIR, "server.csr");
  const extPath = join(CA_DIR, "server.ext");

  openssl([
    "req", "-new", "-key", SERVER_KEY_PATH,
    "-out", csrPath,
    "-subj", "/CN=localhost",
  ]);

  writeFileSync(extPath, `subjectAltName=DNS:localhost,DNS:*.${tld},DNS:*.local\n`);

  if (!existsSync(SRL_PATH)) writeFileSync(SRL_PATH, "1000\n");

  openssl([
    "x509", "-req", "-sha256",
    "-in", csrPath,
    "-CA", CA_CERT_PATH,
    "-CAkey", CA_KEY_PATH,
    "-CAserial", SRL_PATH,
    "-out", SERVER_CERT_PATH,
    "-days", "365",
    "-extfile", extPath,
  ]);
  chmodSync(SERVER_CERT_PATH, 0o644);

  try { unlinkSync(csrPath); } catch {}
  try { unlinkSync(extPath); } catch {}
}

// ─── Per-hostname SNI cert generation ────────────────────────────────────────

function generateHostCert(hostname: string, tld: string): void {
  mkdirSync(HOST_CERTS_DIR, { recursive: true, mode: 0o700 });

  const keyPath = join(HOST_CERTS_DIR, `${hostname}-key.pem`);
  const certPath = join(HOST_CERTS_DIR, `${hostname}.pem`);

  if (existsSync(certPath) && existsSync(keyPath)) return;

  const csrPath = join(HOST_CERTS_DIR, `${hostname}.csr`);
  const extPath = join(HOST_CERTS_DIR, `${hostname}.ext`);

  openssl([
    "ecparam", "-genkey", "-name", "prime256v1", "-noout",
    "-out", keyPath,
  ]);
  chmodSync(keyPath, 0o600);

  openssl([
    "req", "-new", "-key", keyPath,
    "-out", csrPath,
    "-subj", `/CN=${hostname}`,
  ]);

  writeFileSync(extPath, `subjectAltName=DNS:${hostname},DNS:*.${tld}\n`);

  openssl([
    "x509", "-req", "-sha256",
    "-in", csrPath,
    "-CA", CA_CERT_PATH,
    "-CAkey", CA_KEY_PATH,
    "-CAserial", SRL_PATH,
    "-out", certPath,
    "-days", "365",
    "-extfile", extPath,
  ]);
  chmodSync(certPath, 0o644);

  try { unlinkSync(csrPath); } catch {}
  try { unlinkSync(extPath); } catch {}
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CertData {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

export function loadCerts(tld: string): CertData | undefined {
  // If openssl is missing, try loading existing tube certs but skip generation
  if (!hasOpenssl()) {
    if (existsSync(SERVER_CERT_PATH) && existsSync(SERVER_KEY_PATH)) {
      return {
        cert: readFileSync(SERVER_CERT_PATH),
        key: readFileSync(SERVER_KEY_PATH),
        ca: existsSync(CA_CERT_PATH) ? readFileSync(CA_CERT_PATH) : undefined,
      };
    }
    console.error("[tube] openssl not found and no existing certs — TLS disabled");
    return undefined;
  }

  // Use existing tube certs if available
  if (existsSync(SERVER_CERT_PATH) && existsSync(SERVER_KEY_PATH)) {
    return {
      cert: readFileSync(SERVER_CERT_PATH),
      key: readFileSync(SERVER_KEY_PATH),
      ca: existsSync(CA_CERT_PATH) ? readFileSync(CA_CERT_PATH) : undefined,
    };
  }

  // Generate new certs
  try {
    console.error(`[tube] Generating TLS certs for *.${tld} (openssl)...`);

    if (!existsSync(CA_CERT_PATH) || !existsSync(CA_KEY_PATH)) {
      generateCA();
      console.error(`[tube] CA generated: ${CA_CERT_PATH}`);
      trustCA();
    }

    generateServerCert(tld);
    console.error(`[tube] Server cert generated: ${SERVER_CERT_PATH}`);

    return {
      cert: readFileSync(SERVER_CERT_PATH),
      key: readFileSync(SERVER_KEY_PATH),
      ca: readFileSync(CA_CERT_PATH),
    };
  } catch (err) {
    console.error(`[tube] Cert generation failed: ${err}`);
    return undefined;
  }
}

export function createSNICallback(
  tld: string
): (servername: string, cb: (err: Error | null, ctx: tls.SecureContext) => void) => void {
  mkdirSync(HOST_CERTS_DIR, { recursive: true, mode: 0o700 });

  return (servername: string, cb: (err: Error | null, ctx: tls.SecureContext) => void) => {
    try {
      const certPath = join(HOST_CERTS_DIR, `${servername}.pem`);
      const keyPath = join(HOST_CERTS_DIR, `${servername}-key.pem`);

      if (!existsSync(certPath) || !existsSync(keyPath)) {
        console.error(`[tube] SNI cert for ${servername} ...`);
        generateHostCert(servername, tld);
      }

      const ctx = tls.createSecureContext({
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        ca: readFileSync(CA_CERT_PATH),
      });
      cb(null, ctx);
    } catch (err) {
      cb(err as Error, null as any);
    }
  };
}

export function getCACertPath(): string {
  return CA_CERT_PATH;
}

export function trustCA(): void {
  if (!existsSync(CA_CERT_PATH)) return;
  if (existsSync(TRUST_MARKER)) return;

  try {
    const loginKeychain = join(os.homedir(), "Library", "Keychains", "login.keychain-db");
    execFileSync("security", [
      "add-trusted-cert", "-d", "-r", "trustRoot",
      "-k", loginKeychain,
      CA_CERT_PATH,
    ], { stdio: "ignore", timeout: 15000 });
    writeFileSync(TRUST_MARKER, String(Date.now()));
    console.error("[tube] CA trusted in login keychain");
  } catch {
    console.error("[tube] Could not auto-trust CA — run manually:");
    console.error(`  security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ${CA_CERT_PATH}`);
  }
}
