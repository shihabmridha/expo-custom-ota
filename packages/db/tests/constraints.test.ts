import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Constraint tests.
 *
 * These run the generated migration SQL against an in-memory SQLite database
 * and assert directly, rather than going through Drizzle. The point is to prove
 * the *database* rejects invalid state — a service-layer check would pass these
 * while leaving a concurrent request able to violate the invariant.
 */
const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

function migrationSql(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

const SQL = migrationSql();

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const statement of SQL.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) db.exec(trimmed);
  }
});

const NOW = Date.now();

function insertApp(id: string, slug: string, updateKey: string) {
  db.run(
    `INSERT INTO applications (id, name, slug, update_key, default_channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'production', ?, ?)`,
    [id, slug, slug, updateKey, NOW, NOW],
  );
}

function insertChannel(id: string, applicationId: string, name: string) {
  db.run('INSERT INTO channels (id, application_id, name, created_at) VALUES (?, ?, ?, ?)', [
    id,
    applicationId,
    name,
    NOW,
  ]);
}

function insertRelease(id: string, applicationId: string, number: number) {
  db.run(
    `INSERT INTO releases (id, application_id, release_number, status, import_status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', 'ready', ?, ?)`,
    [id, applicationId, number, NOW, NOW],
  );
}

function insertAsset(id: string, sha: string) {
  db.run(
    `INSERT INTO assets (id, sha256, storage_key, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, 'application/javascript', 1, ?)`,
    [id, sha, `sha256/${sha.slice(0, 2)}/${sha}`, NOW],
  );
}

function insertVariant(id: string, releaseId: string, platform: string, assetId: string) {
  db.run(
    `INSERT INTO release_variants
       (id, release_id, platform, runtime_version, update_id, manifest, launch_asset_id, created_at)
     VALUES (?, ?, ?, '1.0.0', ?, '{}', ?, ?)`,
    [id, releaseId, platform, `update-${id}`, assetId, NOW],
  );
}

function insertDeployment(
  id: string,
  applicationId: string,
  channelId: string,
  platform: string,
  runtimeVersion: string,
  variantId: string | null,
  directive: string | null = null,
) {
  db.run(
    `INSERT INTO deployments
       (id, application_id, channel_id, platform, runtime_version, release_variant_id,
        directive, directive_commit_time, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      applicationId,
      channelId,
      platform,
      runtimeVersion,
      variantId,
      directive,
      directive ? NOW : null,
      NOW,
      NOW,
    ],
  );
}

describe('applications', () => {
  test('rejects a duplicate slug', () => {
    insertApp('a1', 'acadion', 'ota_1');
    expect(() => insertApp('a2', 'acadion', 'ota_2')).toThrow(/UNIQUE/i);
  });

  test('rejects a duplicate update_key', () => {
    insertApp('a1', 'acadion', 'ota_1');
    expect(() => insertApp('a2', 'lekho', 'ota_1')).toThrow(/UNIQUE/i);
  });
});

describe('channels', () => {
  test('rejects a duplicate channel within one application', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertChannel('c1', 'a1', 'production');
    expect(() => insertChannel('c2', 'a1', 'production')).toThrow(/UNIQUE/i);
  });

  test('allows the same channel name across different applications', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertApp('a2', 'lekho', 'ota_2');
    insertChannel('c1', 'a1', 'production');
    // Acadion.production and Lekho.production are unrelated rows.
    expect(() => insertChannel('c2', 'a2', 'production')).not.toThrow();
  });
});

describe('releases', () => {
  test('rejects a duplicate release number within one application', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertRelease('r1', 'a1', 1);
    expect(() => insertRelease('r2', 'a1', 1)).toThrow(/UNIQUE/i);
  });

  test('allows the same release number across different applications', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertApp('a2', 'lekho', 'ota_2');
    insertRelease('r1', 'a1', 1);
    expect(() => insertRelease('r2', 'a2', 1)).not.toThrow();
  });

  test('rejects an invalid status', () => {
    insertApp('a1', 'acadion', 'ota_1');
    expect(() =>
      db.run(
        `INSERT INTO releases (id, application_id, release_number, status, import_status, created_at, updated_at)
         VALUES ('r1', 'a1', 1, 'live', 'ready', ?, ?)`,
        [NOW, NOW],
      ),
    ).toThrow(/CHECK/i);
  });

  test('rejects an invalid import status', () => {
    insertApp('a1', 'acadion', 'ota_1');
    expect(() =>
      db.run(
        `INSERT INTO releases (id, application_id, release_number, status, import_status, created_at, updated_at)
         VALUES ('r1', 'a1', 1, 'draft', 'halfway', ?, ?)`,
        [NOW, NOW],
      ),
    ).toThrow(/CHECK/i);
  });
});

describe('release_variants', () => {
  beforeEach(() => {
    insertApp('a1', 'acadion', 'ota_1');
    insertRelease('r1', 'a1', 1);
    insertAsset('as1', 'aa'.repeat(32));
  });

  test('rejects two variants of the same platform in one release', () => {
    insertVariant('v1', 'r1', 'android', 'as1');
    expect(() =>
      db.run(
        `INSERT INTO release_variants
           (id, release_id, platform, runtime_version, update_id, manifest, launch_asset_id, created_at)
         VALUES ('v2', 'r1', 'android', '1.0.0', 'other', '{}', 'as1', ?)`,
        [NOW],
      ),
    ).toThrow(/UNIQUE/i);
  });

  test('allows one variant per platform', () => {
    insertVariant('v1', 'r1', 'android', 'as1');
    expect(() => insertVariant('v2', 'r1', 'ios', 'as1')).not.toThrow();
  });

  test('rejects an invalid platform', () => {
    expect(() => insertVariant('v1', 'r1', 'windows', 'as1')).toThrow(/CHECK/i);
  });

  test('rejects a duplicate update id across applications', () => {
    insertApp('a2', 'lekho', 'ota_2');
    insertRelease('r2', 'a2', 1);
    insertVariant('v1', 'r1', 'android', 'as1');
    expect(() =>
      db.run(
        `INSERT INTO release_variants
           (id, release_id, platform, runtime_version, update_id, manifest, launch_asset_id, created_at)
         VALUES ('v2', 'r2', 'android', '1.0.0', 'update-v1', '{}', 'as1', ?)`,
        [NOW],
      ),
    ).toThrow(/UNIQUE/i);
  });
});

describe('assets', () => {
  test('deduplicates by sha256', () => {
    insertAsset('as1', 'ab'.repeat(32));
    expect(() => insertAsset('as2', 'ab'.repeat(32))).toThrow(/UNIQUE/i);
  });
});

describe('deployments', () => {
  beforeEach(() => {
    insertApp('a1', 'acadion', 'ota_1');
    insertApp('a2', 'lekho', 'ota_2');
    insertChannel('c1', 'a1', 'production');
    insertChannel('c2', 'a2', 'production');
    insertRelease('r1', 'a1', 1);
    insertRelease('r2', 'a2', 1);
    insertAsset('as1', 'cc'.repeat(32));
    insertVariant('v1', 'r1', 'android', 'as1');
    insertVariant('v2', 'r2', 'android', 'as1');
  });

  test('rejects a duplicate (app, channel, platform, runtime) tuple', () => {
    insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', 'v1');
    expect(() => insertDeployment('d2', 'a1', 'c1', 'android', '1.5.0', 'v1')).toThrow(/UNIQUE/i);
  });

  test('allows the identical tuple in a different application', () => {
    // The core multi-app isolation case: same channel name, platform and
    // runtime version, different applications, no collision.
    insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', 'v1');
    expect(() => insertDeployment('d2', 'a2', 'c2', 'android', '1.5.0', 'v2')).not.toThrow();
  });

  test('allows different runtime versions in the same channel', () => {
    insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', 'v1');
    expect(() => insertDeployment('d2', 'a1', 'c1', 'android', '1.4.0', 'v1')).not.toThrow();
  });

  test('an upsert replaces rather than duplicating', () => {
    insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', 'v1');
    db.run(
      `INSERT INTO deployments
         (id, application_id, channel_id, platform, runtime_version, release_variant_id, version, created_at, updated_at)
       VALUES ('d2', 'a1', 'c1', 'android', '1.5.0', 'v1', 0, ?, ?)
       ON CONFLICT (application_id, channel_id, platform, runtime_version)
       DO UPDATE SET release_variant_id = excluded.release_variant_id, version = version + 1`,
      [NOW, NOW],
    );

    const rows = db.query('SELECT id, version FROM deployments').all() as {
      id: string;
      version: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('d1');
    expect(rows[0]?.version).toBe(1);
  });

  test('accepts a rollBackToEmbedded directive with no variant', () => {
    expect(() =>
      insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', null, 'rollBackToEmbedded'),
    ).not.toThrow();
  });

  test('rejects both a variant and a directive', () => {
    expect(() =>
      insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', 'v1', 'rollBackToEmbedded'),
    ).toThrow(/CHECK/i);
  });

  test('rejects neither a variant nor a directive', () => {
    expect(() => insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', null, null)).toThrow(
      /CHECK/i,
    );
  });

  test('rejects an unknown directive', () => {
    expect(() =>
      insertDeployment('d1', 'a1', 'c1', 'android', '1.5.0', null, 'selfDestruct'),
    ).toThrow(/CHECK/i);
  });
});

describe('foreign keys are actually enforced', () => {
  test('rejects a channel referencing a missing application', () => {
    // This test exists to prove PRAGMA foreign_keys is ON. bun:sqlite defaults
    // it OFF, which would make every FK in the schema decorative and let the
    // isolation tests pass vacuously.
    expect(() => insertChannel('c1', 'does-not-exist', 'production')).toThrow(/FOREIGN KEY/i);
  });

  test('cascades channel deletion when an application is deleted', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertChannel('c1', 'a1', 'production');
    db.run('DELETE FROM applications WHERE id = ?', ['a1']);
    expect(db.query('SELECT COUNT(*) AS n FROM channels').get()).toEqual({ n: 0 });
  });

  test('does not cascade-delete shared assets', () => {
    insertApp('a1', 'acadion', 'ota_1');
    insertRelease('r1', 'a1', 1);
    insertAsset('as1', 'dd'.repeat(32));
    insertVariant('v1', 'r1', 'android', 'as1');

    // Deleting the release must not remove an object other applications may
    // still reference — assets are removed only by reference-counted GC.
    db.run('DELETE FROM releases WHERE id = ?', ['r1']);
    expect(db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
  });
});

describe('signing keys', () => {
  beforeEach(() => insertApp('a1', 'acadion', 'ota_1'));

  function insertKey(id: string, applicationId: string, keyId: string, status: string) {
    db.run(
      `INSERT INTO application_signing_keys
         (id, application_id, key_id, certificate_pem, certificate_fingerprint,
          certificate_not_after, private_key_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pem', 'fp', ?, 'ref', ?, ?, ?)`,
      [id, applicationId, keyId, NOW, status, NOW, NOW],
    );
  }

  test('allows only one active key per application', () => {
    insertKey('k1', 'a1', 'main', 'active');
    expect(() => insertKey('k2', 'a1', 'second', 'active')).toThrow(/UNIQUE/i);
  });

  test('allows any number of retired keys alongside one active', () => {
    insertKey('k1', 'a1', 'main', 'active');
    expect(() => insertKey('k2', 'a1', 'old', 'retired')).not.toThrow();
    expect(() => insertKey('k3', 'a1', 'older', 'retired')).not.toThrow();
  });

  test('allows each application its own active key', () => {
    insertApp('a2', 'lekho', 'ota_2');
    insertKey('k1', 'a1', 'main', 'active');
    expect(() => insertKey('k2', 'a2', 'main', 'active')).not.toThrow();
  });
});

/**
 * Signing key rotation.
 *
 * Rotation keeps the same `key_id`, because the client matches it against the
 * `codeSigningMetadata.keyid` baked into an already-shipped binary. An earlier
 * `UNIQUE(application_id, key_id)` made that impossible — the retired key still
 * occupied (app, "main") — and rotation failed with an opaque constraint error.
 */
describe('signing key rotation', () => {
  beforeEach(() => insertApp('a1', 'acadion', 'ota_1'));

  function insertKey(id: string, applicationId: string, keyId: string, status: string) {
    db.run(
      `INSERT INTO application_signing_keys
         (id, application_id, key_id, certificate_pem, certificate_fingerprint,
          certificate_not_after, private_key_ref, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pem', 'fp', ?, 'ref', ?, ?, ?)`,
      [id, applicationId, keyId, NOW, status, NOW, NOW],
    );
  }

  test('a retired key does not block a new one with the same keyid', () => {
    insertKey('k1', 'a1', 'main', 'active');
    db.run("UPDATE application_signing_keys SET status = 'retired' WHERE id = 'k1'");

    expect(() => insertKey('k2', 'a1', 'main', 'active')).not.toThrow();

    const active = db
      .query("SELECT id FROM application_signing_keys WHERE status = 'active'")
      .all() as { id: string }[];
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe('k2');
  });

  test('two active keys are still refused, whatever their keyids', () => {
    insertKey('k1', 'a1', 'main', 'active');
    expect(() => insertKey('k2', 'a1', 'other', 'active')).toThrow(/UNIQUE/i);
  });

  test('several retired keys may share a keyid across rotations', () => {
    insertKey('k1', 'a1', 'main', 'retired');
    insertKey('k2', 'a1', 'main', 'retired');
    expect(() => insertKey('k3', 'a1', 'main', 'active')).not.toThrow();
  });
});
