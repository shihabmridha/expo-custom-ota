import { createDb } from '@oat/db';
import { loadEnv } from '../src/config/env.ts';
import { createAdmin } from '../src/services/auth.ts';

/**
 * Create an administrator.
 *
 * The only way to create one — there is no registration route.
 *
 *   bun run admin:create -- --email you@example.com --password 'secret'
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const email = arg('email') ?? prompt('Email:') ?? '';
const password = arg('password') ?? prompt('Password:') ?? '';
const name = arg('name');

if (!email.includes('@')) {
  console.error('A valid --email is required.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}

const env = loadEnv();
const db = createDb({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN });

try {
  const admin = await createAdmin(db, { email, password, ...(name ? { name } : {}) });
  console.log(`Created administrator ${admin.email} (${admin.id}).`);
} catch (error) {
  const message = (error as Error).message;
  console.error(
    message.includes('UNIQUE')
      ? `An administrator with email ${email} already exists.`
      : `Could not create administrator: ${message}`,
  );
  process.exit(1);
}
