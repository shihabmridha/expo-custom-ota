import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { CODE_SIGNING_ALGORITHM } from '@oat/types';
import { serializeSignatureHeader } from './sfv.ts';

/**
 * Expo code signing.
 *
 * The client supports exactly one algorithm: RSA PKCS#1 v1.5 with SHA-256
 * (`rsa-v1_5-sha256` = Node `RSA-SHA256` = JCA `SHA256withRSA` = WebCrypto
 * `RSASSA-PKCS1-v1_5`). RSA-PSS and ECDSA are not supported.
 *
 * The signed payload is the exact UTF-8 bytes of the part body. There is no
 * canonicalization step, so callers must sign the same string they emit.
 */

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/**
 * Node's `Buffer` is `Uint8Array<ArrayBufferLike>`, which WebCrypto's
 * `BufferSource` rejects because it may be backed by a `SharedArrayBuffer`.
 * `Uint8Array.from` copies into a plain `ArrayBuffer`. The inputs here are keys
 * and signatures — hundreds of bytes — so the copy is irrelevant.
 */
function toBytes(buffer: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(buffer);
}

export interface Signer {
  /** Must equal the client's `codeSigningMetadata.keyid` or verification throws. */
  readonly keyId: string;
  /** Returns standard base64 **with** padding. */
  sign(payload: string): Promise<string>;
  /** Returns a ready-to-emit `expo-signature` header value. */
  signHeader(payload: string): Promise<string>;
}

/**
 * Import a PKCS#8 or PKCS#1 RSA private key PEM into a non-extractable
 * WebCrypto key.
 *
 * `createPrivateKey` normalises both PEM flavours (`BEGIN PRIVATE KEY` and
 * `BEGIN RSA PRIVATE KEY`) and re-exports as PKCS#8 DER, which is the only
 * format `subtle.importKey` accepts.
 */
export async function importPrivateKeyPem(privateKeyPem: string): Promise<CryptoKey> {
  const der = createPrivateKey(privateKeyPem).export({ format: 'der', type: 'pkcs8' });
  return crypto.subtle.importKey('pkcs8', toBytes(der), ALGORITHM, false, ['sign']);
}

export async function createSigner(privateKeyPem: string, keyId: string): Promise<Signer> {
  const key = await importPrivateKeyPem(privateKeyPem);

  const sign = async (payload: string): Promise<string> => {
    const signature = await crypto.subtle.sign(
      ALGORITHM.name,
      key,
      new TextEncoder().encode(payload),
    );
    return Buffer.from(signature).toString('base64');
  };

  return {
    keyId,
    sign,
    async signHeader(payload) {
      return serializeSignatureHeader(await sign(payload), keyId);
    },
  };
}

/** Extract the SPKI public key from a certificate PEM (or a bare public key PEM). */
function publicKeyDerFromPem(pem: string): Buffer {
  const key = pem.includes('BEGIN CERTIFICATE')
    ? new X509Certificate(pem).publicKey
    : createPublicKey(pem);
  return key.export({ format: 'der', type: 'spki' });
}

/**
 * Verify a signature against a certificate.
 *
 * Used by tests and by the dashboard's request simulator — the serving path
 * never verifies its own output.
 */
export async function verifySignature(
  payload: string,
  signatureBase64: string,
  certificatePem: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      toBytes(publicKeyDerFromPem(certificatePem)),
      ALGORITHM,
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      ALGORITHM.name,
      key,
      toBytes(Buffer.from(signatureBase64, 'base64')),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  /** Colon-separated uppercase hex, as OpenSSL prints it. */
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  isSelfSigned: boolean;
  publicKeyPem: string;
}

export function certificateInfo(certificatePem: string): CertificateInfo {
  const cert = new X509Certificate(certificatePem);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    fingerprintSha256: cert.fingerprint256,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    isSelfSigned: cert.subject === cert.issuer,
    publicKeyPem: cert.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** RFC 5280 id-kp-codeSigning. */
const CODE_SIGNING_EKU_OID = '1.3.6.1.5.5.7.3.3';

/**
 * Validate that a certificate is usable for Expo code signing before we let an
 * administrator save it. Returns human-readable problems, empty when fine.
 *
 * The client validates the certificate itself before verifying anything with
 * it, and rejects the update outright if it fails:
 *
 *   "First certificate in chain is not a code signing certificate. Must have
 *    X509v3 Key Usage: Digital Signature and X509v3 Extended Key Usage: Code
 *    Signing"
 *
 * So a certificate that lacks those extensions — an Android app signing
 * certificate from `keytool`, for instance, which has neither — would be
 * accepted here and then fail on every device. Catching it at save time is the
 * difference between an error message and a debugging session.
 *
 * Note: Node's `X509Certificate` exposes extended key usage but not the
 * individual keyUsage bits, so the `digitalSignature` bit is not checked here.
 * Certificates OAT generates set both, via Expo's own generator.
 */
export function validateCodeSigningCertificate(certificatePem: string, now = new Date()): string[] {
  const problems: string[] = [];
  let cert: X509Certificate;

  try {
    cert = new X509Certificate(certificatePem);
  } catch (cause) {
    return [`Not a valid X.509 certificate: ${(cause as Error).message}`];
  }

  const notBefore = new Date(cert.validFrom);
  const notAfter = new Date(cert.validTo);
  if (now < notBefore) problems.push(`Certificate is not valid until ${notAfter.toISOString()}.`);
  if (now > notAfter) problems.push(`Certificate expired on ${notAfter.toISOString()}.`);

  const keyDetails = cert.publicKey.asymmetricKeyDetails;
  if (cert.publicKey.asymmetricKeyType !== 'rsa') {
    problems.push(
      `Key type must be RSA (the client only supports ${CODE_SIGNING_ALGORITHM}); got ` +
        `${cert.publicKey.asymmetricKeyType}. An EC key cannot be used for Expo code signing.`,
    );
  } else if ((keyDetails?.modulusLength ?? 0) < 2048) {
    problems.push(`RSA key must be at least 2048 bits; got ${keyDetails?.modulusLength}.`);
  }

  // `X509Certificate.keyUsage` holds the extended key usage OIDs.
  const extendedKeyUsage = cert.keyUsage ?? [];
  if (!extendedKeyUsage.includes(CODE_SIGNING_EKU_OID)) {
    problems.push(
      'Certificate is missing the Code Signing extended key usage ' +
        `(${CODE_SIGNING_EKU_OID}), which expo-updates requires — it rejects the update with ` +
        '"not a code signing certificate". Android app signing certificates do not have this ' +
        'extension and cannot be used here; generate a separate code signing key instead.',
    );
  }

  return problems;
}
