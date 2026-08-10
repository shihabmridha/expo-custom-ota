import { join } from 'node:path';
import type { OatDatabase } from '@oat/db';
import { applicationSigningKeys } from '@oat/db';
import { createSigner, type Signer, serializeSignatureHeader } from '@oat/protocol';
import { and, eq } from 'drizzle-orm';

/**
 * Loading and caching of per-application signing keys.
 *
 * Private key material lives on disk under SIGNING_KEYS_DIRECTORY (a mounted
 * secret in production) and is read only when signing is required. It is never
 * stored in the database and never leaves the server.
 */
export interface SigningKeyRecord {
  keyId: string;
  certificatePem: string;
  privateKeyRef: string;
}

export class SigningService {
  /**
   * Signers are cached because importing a key is comparatively expensive and
   * the no-update path signs a directive on every device poll.
   */
  private readonly signers = new Map<string, Signer>();

  constructor(
    private readonly db: OatDatabase,
    private readonly keysDirectory: string,
  ) {}

  async getActiveKey(applicationId: string): Promise<SigningKeyRecord | null> {
    const rows = await this.db
      .select({
        keyId: applicationSigningKeys.keyId,
        certificatePem: applicationSigningKeys.certificatePem,
        privateKeyRef: applicationSigningKeys.privateKeyRef,
      })
      .from(applicationSigningKeys)
      .where(
        and(
          eq(applicationSigningKeys.applicationId, applicationId),
          eq(applicationSigningKeys.status, 'active'),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Resolve a private key reference to a path inside the keys directory.
   *
   * A bare filename is resolved relative to the configured directory; an
   * absolute path is honoured so deployments can mount keys anywhere.
   */
  private resolveKeyPath(ref: string): string {
    if (ref.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ref)) return ref;
    return join(this.keysDirectory, ref);
  }

  async getSigner(applicationId: string): Promise<Signer | null> {
    const cached = this.signers.get(applicationId);
    if (cached) return cached;

    const key = await this.getActiveKey(applicationId);
    if (!key) return null;

    const file = Bun.file(this.resolveKeyPath(key.privateKeyRef));
    if (!(await file.exists())) {
      throw new Error(
        `Signing key for application ${applicationId} is registered but its private key was not ` +
          `found at "${key.privateKeyRef}". Check SIGNING_KEYS_DIRECTORY.`,
      );
    }

    const signer = await createSigner(await file.text(), key.keyId);
    this.signers.set(applicationId, signer);
    return signer;
  }

  /**
   * Sign a payload and return a ready-to-emit `expo-signature` header, or null
   * when the application has no signing key configured.
   */
  async signHeader(applicationId: string, payload: string): Promise<string | null> {
    const signer = await this.getSigner(applicationId);
    return signer ? signer.signHeader(payload) : null;
  }

  /** Build the header for a signature computed earlier, at import time. */
  static headerFor(signature: string, keyId: string): string {
    return serializeSignatureHeader(signature, keyId);
  }

  /** Drop a cached signer, e.g. after a key rotation. */
  invalidate(applicationId: string): void {
    this.signers.delete(applicationId);
  }
}
