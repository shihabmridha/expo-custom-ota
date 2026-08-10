import type { OtaDatabase } from '@ota/db';
import * as schema from '@ota/db/schema/index';
import { and, eq, gt, lt } from 'drizzle-orm';

/**
 * Administrator authentication.
 *
 * The cookie carries 32 random bytes; the database stores only the SHA-256 of
 * that value, so a database dump cannot be replayed to forge a session.
 */

export interface SessionAdmin {
  id: string;
  email: string;
  name: string | null;
}

export const SESSION_COOKIE = 'ota_session';

function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/**
 * A fixed argon2id hash used to burn the same CPU time when an email does not
 * exist as when it does. Without this, response timing enumerates admins.
 */
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  dummyHash ??= await Bun.password.hash('oat-timing-equalizer', 'argon2id');
  return dummyHash;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, 'argon2id');
}

export async function verifyCredentials(
  db: OtaDatabase,
  email: string,
  password: string,
): Promise<SessionAdmin | null> {
  const rows = await db
    .select()
    .from(schema.admins)
    .where(eq(schema.admins.email, email.toLowerCase().trim()))
    .limit(1);

  const admin = rows[0];
  if (!admin) {
    // Constant-ish time: verify against a dummy hash so a missing account costs
    // the same as a wrong password.
    await Bun.password.verify(password, await getDummyHash());
    return null;
  }

  const valid = await Bun.password.verify(password, admin.passwordHash);
  if (!valid) return null;

  return { id: admin.id, email: admin.email, name: admin.name };
}

export async function createSession(
  db: OtaDatabase,
  adminId: string,
  ttlHours: number,
  meta: { ipHash?: string | undefined; userAgent?: string | undefined } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  await db.insert(schema.sessions).values({
    id: crypto.randomUUID(),
    adminId,
    tokenHash: hashToken(token),
    expiresAt,
    ipHash: meta.ipHash ?? null,
    userAgent: meta.userAgent ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(db: OtaDatabase, token: string): Promise<SessionAdmin | null> {
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      id: schema.admins.id,
      email: schema.admins.email,
      name: schema.admins.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.admins, eq(schema.admins.id, schema.sessions.adminId))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashToken(token)),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  await db
    .update(schema.sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.sessions.id, row.sessionId));

  return { id: row.id, email: row.email, name: row.name };
}

export async function destroySession(db: OtaDatabase, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

export async function purgeExpiredSessions(db: OtaDatabase): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
}

export async function createAdmin(
  db: OtaDatabase,
  input: { email: string; password: string; name?: string },
): Promise<SessionAdmin> {
  const id = crypto.randomUUID();
  const email = input.email.toLowerCase().trim();

  await db.insert(schema.admins).values({
    id,
    email,
    passwordHash: await hashPassword(input.password),
    name: input.name ?? null,
  });

  return { id, email, name: input.name ?? null };
}
