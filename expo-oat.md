# Self-Hosted Multi-App Expo OTA Update Platform — V1 Implementation Plan

## 1. Objective

Build a self-hosted OTA update platform compatible with the `expo-updates` client library and the Expo Updates v1 protocol.

The platform must support **multiple independent Expo applications**.

An administrator should be able to:

1. Create and manage multiple applications.
2. Configure independent OTA endpoints for each application.
3. Export an Expo application locally.
4. Upload the exported update manually through a web dashboard.
5. Validate the uploaded update.
6. Store bundles and assets.
7. Publish updates to `staging`, `production`, or another application-specific channel.
8. Promote the exact same release from staging to production.
9. Roll back to previous release contents.
10. View release and deployment history.
11. Manage application-specific signing configuration.

No EAS Update service should be required.

CI/CD integration is explicitly outside the V1 scope.

---

# 2. Core V1 Principles

The system should follow these principles.

### Multi-application

The OTA server is a platform, not an OTA backend for one particular app.

```text
OTA Platform
│
├── Application A
│   ├── channels
│   ├── releases
│   ├── deployments
│   └── signing
│
├── Application B
│   ├── channels
│   ├── releases
│   ├── deployments
│   └── signing
│
└── Application N
```

### Manual publishing

The OTA server does not:

- clone repositories
- pull source code
- execute GitHub workflows
- build APK/IPA files
- listen for repository webhooks
- automatically publish commits

The developer prepares an Expo export locally.

```bash
bunx expo export
```

or the appropriate Expo CLI command for the project's environment.

The resulting export package is uploaded manually through the OTA dashboard.

### Server is an importer and distributor

Conceptually:

```text
Developer Machine
      │
      │ Expo export
      ▼
 Update Archive
      │
      │ manual upload
      ▼
 Admin Dashboard
      │
      ▼
 OTA Backend
      │
      ├── validate
      ├── hash
      ├── generate manifest
      ├── sign manifest
      └── create release
             │
             ├── Turso
             │
             └── Object Storage
                       │
                       ▼
                  expo-updates
```

---

# 3. Required Technology Stack

Use the following stack unless a technical limitation makes a specific component unsuitable.

## Runtime and package manager

Use:

```text
Bun
```

Bun should be used for:

- backend runtime
- package management
- scripts
- development commands
- test execution where practical
- CLI/helper scripts
- build tooling where practical

Do not introduce Node.js as the primary application runtime.

Use:

```bash
bun install
bun run ...
bun test
bunx ...
```

instead of:

```bash
npm
npx
pnpm
yarn
```

where Bun provides the equivalent functionality.

---

# 4. Backend

Use:

```text
Bun
+
TypeScript
+
Hono
```

Recommended responsibilities:

```text
Hono
├── Public Expo protocol API
├── Admin REST API
├── Authentication
├── Upload handling
├── Release management
├── Signing
└── Storage integration
```

The backend must run directly on Bun.

Example development command:

```bash
bun run dev
```

Example production command:

```bash
bun run src/server.ts
```

or a compiled/bundled equivalent if beneficial.

Do not design around Node-specific APIs when Bun-native or Web Standard APIs are available.

Prefer:

- Web `Request`
- Web `Response`
- `fetch`
- `Blob`
- `FormData`
- `ReadableStream`
- Web Crypto where appropriate

This keeps the backend portable and works naturally with Hono.

---

# 5. Database

Use:

```text
Turso
+
libSQL
+
Drizzle ORM
```

Turso is the primary persistent relational database.

Do not use PostgreSQL in V1.

Database access should be implemented through Drizzle wherever practical.

Suggested packages should follow the current supported Bun/Turso/Drizzle combination.

Conceptually:

```text
Backend
   │
   ▼
Drizzle ORM
   │
   ▼
Turso / libSQL
```

The architecture should avoid raw SQL scattered throughout route handlers.

Database queries should live in domain repositories/services or clearly defined data-access modules.

---

# 6. Database Migrations

Use:

```text
Drizzle Kit
```

for schema migrations.

Do not:

- manually maintain SQL migration history
- use Prisma migrations
- use another migration framework

Suggested structure:

```text
src/
  db/
    schema/
      applications.ts
      channels.ts
      releases.ts
      assets.ts
      deployments.ts
      auth.ts

    client.ts

drizzle/
  migrations...
```

Typical workflow:

```bash
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

Exact commands should follow the currently installed Drizzle version.

Migrations must be committed to Git.

Production deployment must execute pending Drizzle migrations before or as part of application deployment.

---

# 7. Admin Frontend

Use a simple:

```text
Vite
+
React
+
TypeScript
```

SPA.

Do not use:

- Next.js
- Remix
- Astro
- server-side rendering
- React Server Components

V1 does not require those features.

The admin interface is simply an authenticated application communicating with the OTA backend API.

Conceptually:

```text
Browser
   │
   ▼
Vite React SPA
   │
   │ REST API
   ▼
Bun + Hono Backend
```

Keep the frontend small and operational rather than building a sophisticated design system.

Suggested stack:

```text
React
React Router
TanStack Query
```

A lightweight component library may be used if useful, but avoid creating unnecessary UI infrastructure.

---

# 8. Repository Structure

Prefer a Bun workspace/monorepo.

Example:

```text
ota-server/
│
├── apps/
│   │
│   ├── api/
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/
│       ├── src/
│       ├── index.html
│       ├── vite.config.ts
│       └── package.json
│
├── packages/
│   │
│   ├── db/
│   │
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   └── client.ts
│   │   └── drizzle.config.ts
│   │
│   ├── protocol/
│   │   └── src/
│   │
│   └── shared/
│       └── src/
│
├── drizzle/
│
├── package.json
├── bun.lock
└── README.md
```

Potential responsibilities:

```text
apps/api
    Hono/Bun server

apps/web
    Vite React admin SPA

packages/db
    Turso client
    Drizzle schema
    database access

packages/protocol
    Expo Updates protocol implementation

packages/shared
    shared types
    validation schemas
    constants
```

Avoid over-engineering package boundaries initially.

If splitting into packages creates unnecessary complexity, use:

```text
apps/api/src/modules/
```

instead.

---

# 9. Domain Model

The top-level OTA entity is:

```text
Application
```

Do not call it `Project` internally.

Expo uses the word "project" for several different concepts, so `Application` is clearer.

Hierarchy:

```text
OTA Platform
│
├── Application
│   │
│   ├── Channels
│   ├── Releases
│   ├── Release Variants
│   ├── Deployments
│   ├── Signing Configuration
│   └── Assets
│
└── Application
    └── ...
```

Every OTA-related operation must have an explicit owning application.

---

# 10. Applications

Schema concept:

```text
applications

id TEXT PK

name TEXT NOT NULL
slug TEXT NOT NULL UNIQUE

update_key TEXT NOT NULL UNIQUE

description TEXT NULL

android_package TEXT NULL
ios_bundle_identifier TEXT NULL

created_at INTEGER/TIMESTAMP
updated_at INTEGER/TIMESTAMP
```

UUIDs, UUIDv7, or another appropriate globally unique identifier may be used.

Do not depend on auto-incrementing IDs for externally visible resources.

Example:

```text
name:
Acadion Mobile

slug:
acadion-mobile

update_key:
ota_X7jb8C49pQ2...

android_package:
xyz.acadion.mobile

ios_bundle_identifier:
xyz.acadion.mobile
```

`update_key` identifies the application through the public update endpoint.

It is not an authentication secret.

---

# 11. Application OTA URL

Every application receives its own update URL.

Example:

```text
https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2
```

Another app:

```text
https://ota.example.com/api/v1/updates/ota_K98xYbP6Ls4
```

Expo configuration:

```json
{
  "expo": {
    "updates": {
      "url": "https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2",
      "requestHeaders": {
        "x-ota-channel": "production"
      }
    }
  }
}
```

The backend always resolves:

```text
update_key
    ↓
Application
```

before processing OTA selection.

---

# 12. Channels

Channels belong to an application.

Schema:

```text
channels

id TEXT PK
application_id TEXT FK NOT NULL
name TEXT NOT NULL

created_at ...

UNIQUE(application_id, name)
```

Example:

```text
Acadion
├── production
├── staging
└── beta

Lekho
├── production
└── staging
```

`Acadion.production` and `Lekho.production` are unrelated records.

Create by default:

```text
production
staging
```

when an application is created.

---

# 13. Releases

A release represents one imported Expo export.

Schema:

```text
releases

id TEXT PK
application_id TEXT FK NOT NULL

release_number INTEGER NOT NULL

message TEXT NULL

status TEXT NOT NULL
  draft
  published
  archived

source_filename TEXT NULL
source_hash TEXT NULL

created_at ...
created_by TEXT NULL

UNIQUE(application_id, release_number)
```

Release numbers should be application-local.

Example:

```text
Acadion
#1
#2
#3

Lekho
#1
#2
```

Internal identifiers remain globally unique.

---

# 14. Release Variants

A single Expo export may contain:

```text
Android
iOS
or both
```

Model them separately.

```text
release_variants

id TEXT PK
release_id TEXT FK NOT NULL

platform TEXT NOT NULL
  android
  ios

runtime_version TEXT NOT NULL

update_id TEXT NOT NULL UNIQUE

created_at ...

manifest TEXT/JSON NOT NULL
manifest_signature TEXT NOT NULL

launch_asset_id TEXT FK NOT NULL

expo_config TEXT/JSON
```

The release owns the application relationship, so every variant is indirectly application-scoped.

---

# 15. Runtime Versions

Runtime versions are opaque strings.

Do not interpret them globally.

For example:

```text
Acadion runtime 1.0.0
```

and:

```text
Lekho runtime 1.0.0
```

have no relationship.

Update resolution always requires:

```text
Application
+
Channel
+
Platform
+
Runtime Version
```

Never query by runtime version alone.

---

# 16. Deployments

A deployment determines what update should currently be served.

Schema:

```text
deployments

id TEXT PK

application_id TEXT FK NOT NULL
channel_id TEXT FK NOT NULL

platform TEXT NOT NULL

runtime_version TEXT NOT NULL

release_variant_id TEXT FK NOT NULL

updated_at ...
```

Constraint:

```text
UNIQUE(
  application_id,
  channel_id,
  platform,
  runtime_version
)
```

Example:

```text
Acadion
production
android
runtime 1.5.0
       ↓
Release #42 Android
```

while:

```text
Lekho
production
android
runtime 1.5.0
       ↓
Release #18 Android
```

Both safely coexist.

---

# 17. Assets

Use content-addressable object storage.

Recommended storage:

```text
Cloudflare R2
```

or any S3-compatible object storage.

The database stores asset metadata.

```text
assets

id TEXT PK

sha256 TEXT NOT NULL UNIQUE

storage_key TEXT NOT NULL UNIQUE

content_type TEXT NOT NULL
file_extension TEXT NULL

size_bytes INTEGER NOT NULL

created_at ...
```

Physical objects should be stored using hashes.

Example:

```text
sha256/
  ab/
    ab83a8201c...
```

Identical assets across:

- releases
- runtime versions
- applications

may use the same physical object.

This is safe because objects are immutable and content-addressed.

---

# 18. Release Assets

Create the relationship:

```text
release_assets

id TEXT PK

release_variant_id TEXT FK NOT NULL
asset_id TEXT FK NOT NULL

asset_key TEXT NOT NULL

type TEXT NOT NULL
  launch
  asset

sort_order INTEGER
```

An application's metadata remains isolated even when the underlying immutable physical asset is shared.

---

# 19. Application Signing

Each application must have an independent signing identity.

Correct:

```text
Acadion
   └── signing key A

Lekho
   └── signing key B
```

Not:

```text
Entire OTA platform
   └── one global signing key
```

This provides compromise isolation.

Database metadata:

```text
application_signing_keys

id TEXT PK
application_id TEXT FK NOT NULL

key_id TEXT NOT NULL

certificate_pem TEXT NOT NULL
certificate_fingerprint TEXT NOT NULL

private_key_ref TEXT NOT NULL

status TEXT NOT NULL
  active
  retired

created_at ...
```

Do not put the private key itself into Turso.

`private_key_ref` points to a secure server-side secret.

Example:

```text
/run/secrets/signing/acadion.pem
```

The backend loads the private key only when signing is required.

Private signing material must never reach the React application.

---

# 20. Manual Developer Workflow

The developer works locally.

Example:

```bash
bunx expo export
```

Then package the generated export and required Expo configuration into an archive.

Example:

```text
update.zip
│
├── metadata.json
├── bundles...
├── assets...
└── expoConfig.json
```

The actual Expo export format must be inspected against the Expo SDK used during implementation.

Do not hardcode assumptions based on outdated Expo export layouts.

---

# 21. Upload Flow

Updates are uploaded from within a specific application.

UI:

```text
Applications
    ↓
Acadion
    ↓
Releases
    ↓
Upload Release
```

Not:

```text
Global Upload
    ↓
Choose application afterward
```

This reduces mistakes.

Flow:

```text
Selected Application
       │
       ▼
Upload ZIP
       │
       ▼
Temporary Storage
       │
       ▼
Safe Extraction
       │
       ▼
Read Expo Metadata
       │
       ▼
Verify App Identity
       │
       ▼
Discover Platforms
       │
       ▼
Discover Runtime Versions
       │
       ▼
Hash Bundles + Assets
       │
       ▼
Upload Immutable Assets
       │
       ▼
Generate Manifest
       │
       ▼
Sign Manifest
       │
       ▼
Create Draft Release
```

---

# 22. Upload Validation

Validate:

```text
archive format
archive size
expanded archive size
file count
Expo metadata
Expo configuration
bundles
assets
platform
runtime version
application identity
hashes
signing
```

Protect against:

- ZIP path traversal
- `../`
- absolute paths
- symlinks
- decompression bombs
- excessive file counts
- excessive extracted size

Temporary files must always be cleaned afterward.

---

# 23. Application Identity Protection

When uploading into:

```text
Acadion
```

the backend should compare configured values such as:

```text
android.package
ios.bundleIdentifier
```

with the application's stored configuration.

Example:

```text
Expected:
xyz.acadion.mobile

Uploaded:
com.example.lekho
```

Reject:

```text
This update appears to belong to another application.

Expected Android package:
xyz.acadion.mobile

Uploaded Android package:
com.example.lekho
```

This validation is particularly important in a multi-app OTA platform.

---

# 24. Hashing

Calculate SHA-256 for:

```text
launch bundle
every asset
uploaded source archive
```

Use Bun/Web Crypto APIs where appropriate.

Do not load extremely large files entirely into memory unnecessarily.

Streaming hashing should be considered if Bun's available APIs make it straightforward.

Hashes must be represented according to Expo Updates protocol requirements when inserted into manifests.

---

# 25. Import Transactions

Turso/libSQL transactions should protect database state.

However, object storage and database operations cannot be treated as one distributed ACID transaction.

Therefore use an explicit import state machine.

Example:

```text
uploaded
    ↓
processing
    ↓
assets_uploaded
    ↓
ready
```

If something fails:

```text
failed
```

Do not expose incomplete releases as publishable.

The importer should be idempotent where practical.

Unused objects may later be garbage-collected.

---

# 26. Release Preview

Before publishing, show:

```text
Release #45

Application:
Acadion Mobile

Message:
Fix payment validation

Platforms:
✓ Android
✓ iOS

Runtime:
Android: 1.5.0
iOS:     1.5.0

Assets:
74

Bundle:
2.7 MB

Total:
8.3 MB

Signing:
✓ Signed

Status:
Draft
```

Actions:

```text
[Publish to Staging]
[Delete Draft]
```

---

# 27. Publishing

Importing and publishing are separate operations.

An imported release starts as:

```text
draft
```

Publishing modifies deployment mappings.

Example:

```text
release #45
       │
       ▼
staging
```

Turso transaction:

```text
deployment:
Acadion
staging
android
1.5.0
→ #45 Android

deployment:
Acadion
staging
ios
1.5.0
→ #45 iOS
```

Where both platforms are intentionally published together, update both deployment mappings atomically inside one database transaction.

---

# 28. Promotion

Allow:

```text
staging
   ↓
production
```

without:

- rebuilding
- re-exporting
- resigning unnecessarily
- copying assets
- uploading anything again

Example:

```text
Release #45

Currently:
Staging

[Promote to Production]
```

Production deployment mappings now reference the same release variants.

This guarantees that the production release is exactly what was tested in staging.

---

# 29. Rollback

Rollback should create a new release referencing previous content.

Example history:

```text
#42 Stable
#43 Feature
#44 Broken
#45 Rollback to #42
```

Release #45 gets:

```text
new update ID
new createdAt
new manifest
new signature
```

but references the same immutable assets as #42.

No assets need to be uploaded again.

Do not simply point clients backward to an older update ID.

---

# 30. Published Release Immutability

Once published, the following cannot change:

```text
update_id
runtime_version
platform
manifest
signature
launch asset
asset hashes
created_at
```

Changing content means creating a new release.

Published releases may be:

```text
archived
```

but not mutated.

Drafts may be deleted.

---

# 31. Expo Public Endpoint

Expose:

```http
GET /api/v1/updates/:updateKey
```

Example:

```text
/api/v1/updates/ota_X7jb8C49pQ2
```

Flow:

```text
updateKey
    ↓
Application
    ↓
Expo protocol headers
    ↓
Channel
    ↓
Platform
    ↓
Runtime
    ↓
Deployment
    ↓
Release Variant
    ↓
Signed Expo Manifest
```

---

# 32. Selection Service

Keep update selection separate from HTTP formatting.

Example:

```ts
selectUpdate({
  applicationId,
  channel,
  platform,
  runtimeVersion,
  currentUpdateId,
});
```

Pseudo algorithm:

```text
1. Resolve application.

2. Validate protocol version.

3. Validate platform.

4. Read runtimeVersion.

5. Read channel.

6. Query deployment using:

   applicationId
   channel
   platform
   runtimeVersion

7. No deployment:
   return NO_UPDATE

8. Deployment found:
   load release variant.

9. If:
   currentUpdateId === deployed updateId

   return NO_UPDATE

10. Otherwise:
    return UPDATE
```

The selection service must require `applicationId`.

There should be no API capable of selecting updates globally by runtime/channel alone.

---

# 33. Expo Protocol Module

Isolate Expo-specific behavior.

Example:

```text
packages/protocol/src/

request.ts
manifest.ts
multipart.ts
directives.ts
signature.ts
headers.ts
selection-types.ts
```

Functions may include:

```text
parseExpoUpdateRequest()

buildExpoManifest()

buildMultipartResponse()

buildNoUpdateResponse()

signManifest()

serializeManifestForSigning()
```

The rest of the application should not need to know low-level Expo protocol details.

---

# 34. Admin Authentication

V1 only requires a single administrator or small administrator list.

Database:

```text
admins

id TEXT PK
email TEXT UNIQUE
password_hash TEXT

created_at ...
updated_at ...
```

Use secure password hashing supported cleanly by Bun.

Authentication requirements:

- HTTP-only cookies
- Secure cookies in production
- SameSite appropriately configured
- session expiration
- login rate limiting
- logout
- CSRF protection where required

No public registration.

---

# 35. Admin API

Authentication:

```text
POST /api/admin/auth/login
POST /api/admin/auth/logout
GET  /api/admin/auth/session
```

Applications:

```text
GET    /api/admin/applications
POST   /api/admin/applications
GET    /api/admin/applications/:id
PATCH  /api/admin/applications/:id
DELETE /api/admin/applications/:id
```

Channels:

```text
GET
/api/admin/applications/:id/channels

POST
/api/admin/applications/:id/channels

DELETE
/api/admin/channels/:id
```

Releases:

```text
GET
/api/admin/applications/:id/releases

POST
/api/admin/applications/:id/releases/import

GET
/api/admin/releases/:id

DELETE
/api/admin/releases/:id
```

Publishing:

```text
POST /api/admin/releases/:id/publish

POST /api/admin/releases/:id/promote

POST /api/admin/releases/:id/rollback
```

Client setup:

```text
GET
/api/admin/applications/:id/client-config
```

Simulation:

```text
POST
/api/admin/applications/:id/simulate-update-request
```

---

# 36. React Admin Dashboard

The Vite React application should contain these main routes:

```text
/login

/applications

/applications/:id

/applications/:id/releases

/applications/:id/releases/:releaseId

/applications/:id/channels

/applications/:id/deployments

/applications/:id/settings

/applications/:id/signing
```

Use React Router for routing.

Use TanStack Query or equivalent for backend API state.

Do not introduce Redux unless the implementation genuinely requires it.

Most application state should come from:

```text
server state → TanStack Query
URL state    → React Router
local UI     → useState/useReducer
```

---

# 37. Dashboard UI

Top-level screen:

```text
OTA Dashboard

Applications

┌─────────────────────────┐
│ Acadion Mobile          │
│                        │
│ Production: #42        │
│ Staging:    #45        │
│ Runtimes:   3          │
└─────────────────────────┘

┌─────────────────────────┐
│ Lekho                   │
│                        │
│ Production: #18        │
│ Staging:    #19        │
│ Runtimes:   2          │
└─────────────────────────┘

[ + New Application ]
```

---

# 38. Application Screen

Example:

```text
Acadion Mobile

Overview
Releases
Channels
Deployments
Client Setup
Signing
Settings
```

Overview:

```text
Production

1.5.0
Android → #42
iOS     → #42

1.4.0
Android → #38
iOS     → #38
```

and:

```text
Staging

1.5.0
Android → #45
iOS     → #45
```

---

# 39. New Application Workflow

Form:

```text
Name
[ Acadion Mobile ]

Slug
[ acadion-mobile ]

Android Package
[ xyz.acadion.mobile ]

iOS Bundle Identifier
[ xyz.acadion.mobile ]
```

Creation should:

```text
1. Insert application.

2. Generate random update_key.

3. Create production channel.

4. Create staging channel.

5. Initialize application signing configuration.

6. Show client setup instructions.
```

---

# 40. Client Setup UI

Display:

```text
OTA URL

https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2
```

Display example Expo configuration:

```json
{
  "expo": {
    "updates": {
      "url": "https://ota.example.com/api/v1/updates/ota_X7jb8C49pQ2",
      "requestHeaders": {
        "x-ota-channel": "production"
      }
    }
  }
}
```

Also show:

```text
Runtime Version Configuration
Signing Certificate
Required Client Configuration
```

The administrator should be able to copy configuration snippets easily.

---

# 41. Object Storage Interface

Do not tightly couple OTA logic to R2.

Define an abstraction.

Example:

```ts
interface AssetStorage {
  exists(key: string): Promise<boolean>;

  put(
    key: string,
    data: Blob | ReadableStream | Uint8Array,
    options: {
      contentType: string;
      cacheControl?: string;
    },
  ): Promise<void>;

  getPublicUrl(key: string): string;

  delete(key: string): Promise<void>;
}
```

Implement:

```text
R2AssetStorage
```

first.

This leaves the option for S3-compatible implementations later.

---

# 42. Asset Caching

Published asset URLs must be immutable.

Use:

```http
Cache-Control: public, max-age=31536000, immutable
```

Suitable URLs:

```text
https://assets.example.com/sha256/HASH
```

Never:

```text
/latest/bundle.js
```

Do not overwrite objects after publication.

---

# 43. Logging

Use structured logging.

Events:

```text
application_created

release_uploaded
release_import_started
release_import_failed
release_ready

release_published
release_promoted
release_rollback_created

update_requested
update_served
no_update_available

storage_failure
database_failure
signing_failure
```

For OTA requests:

```text
applicationId
channel
platform
runtimeVersion
currentUpdateId
servedUpdateId
result
```

Never log:

```text
passwords
sessions
private signing keys
sensitive secrets
```

---

# 44. Basic Metrics

V1 only needs basic operational counters.

Examples:

```text
manifest requests

updates served

no-update responses

asset requests

storage used

releases per application
```

Do not build:

- user tracking
- installation tracking
- detailed device analytics
- update adoption analytics
- crash analytics

in V1.

---

# 45. Multi-App Isolation Requirements

This is a critical security and correctness requirement.

The coding agent must follow this invariant:

> No release, channel, runtime, deployment, manifest, signing operation, or update selection may occur without an explicit owning Application.

Example test:

```text
App A
production
android
1.0.0
→ Release A1

App B
production
android
1.0.0
→ Release B1
```

Then:

```text
App A URL → A1
App B URL → B1
```

Never:

```text
App A → B1
```

even though:

```text
channel
platform
runtimeVersion
```

are identical.

---

# 46. Database Isolation

Avoid queries such as:

```ts
db.select()
  .from(deployments)
  .where(eq(deployments.runtimeVersion, runtimeVersion));
```

Instead query explicitly using:

```text
applicationId
channelId
platform
runtimeVersion
```

Application ownership should also be enforced with database relationships and unique indexes wherever possible.

---

# 47. Protocol Tests

Implement tests before relying on the admin UI.

Use Bun's test runner if suitable:

```bash
bun test
```

Test:

### Parsing

```text
valid Expo request
missing runtime
missing platform
invalid platform
unsupported protocol
```

### Selection

```text
correct application
correct channel
correct platform
correct runtime
```

### Isolation

```text
App A never gets App B release
```

### Current update

```text
currentUpdateId == deploymentUpdateId

→ NO_UPDATE
```

### Manifest

Validate:

```text
id
createdAt
runtimeVersion
launchAsset
assets
hashes
URLs
metadata
extra
```

### Signing

Validate:

```text
correct signature succeeds

modified manifest fails

wrong certificate fails
```

---

# 48. Importer Tests

Test:

```text
valid Expo export

Android only

iOS only

Android + iOS

missing metadata

missing bundle

missing asset

invalid archive

ZIP traversal

oversized ZIP

incorrect application identity

duplicate assets

repeated import
```

---

# 49. Turso/Drizzle Tests

Test constraints including:

```text
duplicate application slug rejected

duplicate update_key rejected

duplicate channel within application rejected

same channel name across apps allowed

duplicate release number within app rejected

same release number across apps allowed

duplicate deployment combination rejected
```

Specifically verify:

```text
UNIQUE(
 application_id,
 channel_id,
 platform,
 runtime_version
)
```

behaves correctly.

---

# 50. Real Device End-to-End Test

Create a small Expo test application.

Configure:

```text
custom OTA URL
runtimeVersion
production channel
code-signing certificate
```

Install native release.

Initial content:

```text
VERSION A
```

Then locally change:

```text
VERSION B
```

Run:

```bash
bunx expo export
```

Upload through admin UI.

Publish to staging or production.

Confirm:

```text
VERSION B
```

loads through OTA without reinstalling the application.

Then publish:

```text
VERSION C
```

Confirm C.

Then rollback to B.

Confirm B.

Then publish an update with another runtimeVersion.

Confirm old native runtime never receives it.

Perform tests for:

```text
Android
iOS
```

---

# 51. Failure Behavior

The installed mobile application must remain usable if:

```text
OTA server is offline

Turso is unavailable

R2 is unavailable

no deployment exists

no compatible runtime exists

network request times out

manifest request fails
```

OTA communication must never be a mandatory prerequisite for normal application startup.

The embedded or cached application remains the fallback.

---

# 52. Environment Variables

Example backend environment:

```text
DATABASE_URL=
DATABASE_AUTH_TOKEN=

R2_ENDPOINT=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_URL=

SESSION_SECRET=

OTA_PUBLIC_URL=

SIGNING_KEYS_DIRECTORY=
```

Do not put secrets in Vite client-side environment variables.

The web application should only receive genuinely public configuration.

---

# 53. Development Commands

Root scripts should aim for a simple workflow.

Example:

```json
{
  "scripts": {
    "dev": "...",
    "dev:api": "...",
    "dev:web": "...",

    "test": "bun test",

    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",

    "build": "...",
    "build:web": "...",
    "typecheck": "..."
  }
}
```

Commands should run through:

```bash
bun run dev
bun run test
bun run db:generate
bun run db:migrate
bun run build
```

Use Bun workspaces if the monorepo structure benefits from them.

---

# 54. Docker Deployment

Production should support Docker deployment.

Conceptually:

```text
Docker Container
│
├── Bun backend
│
└── built Vite static files
```

The simplest production architecture may be:

```text
Bun/Hono
   │
   ├── /api/*
   │
   └── serve Vite dist/
```

or static assets may be served separately.

For V1, serving the built Vite application through the Bun backend is acceptable and reduces operational complexity.

Do not include:

```text
PostgreSQL container
Redis container
Node.js container
```

unless a later feature genuinely requires them.

Turso is externally hosted/self-hosted libSQL depending on deployment choice.

R2 handles binary update assets.

---

# 55. V1 Explicit Non-Goals

Do not implement:

```text
CI/CD integration

GitHub integration

GitLab integration

webhooks

repository cloning

server-side Expo source builds

APK/IPA building

EAS Build replacement

percentage rollouts

A/B testing

device targeting

user targeting

branches

Git branch mapping

delta updates

automatic crash rollback

complex analytics

push-triggered update checks

organizations

team RBAC

billing

public signup

API publishing tokens

publishing CLI
```

These belong to later versions.

---

# 56. Implementation Phases

## Phase 0 — Repository Foundation

Set up:

```text
Bun workspace

apps/api
apps/web

packages/db
packages/protocol
packages/shared
```

Configure:

```text
TypeScript
Hono
Vite
React
Turso
Drizzle
Drizzle Kit
Bun test
```

Make sure:

```bash
bun install
bun run dev
bun test
```

work cleanly.

---

## Phase 1 — Expo Protocol Spike

Before building the dashboard or database-heavy features:

Create:

```text
GET /api/v1/updates/test
```

Serve one manually prepared Expo update.

Implement signing.

Test against a real Expo release application.

Goal:

```text
expo-updates
     ↕
Bun/Hono server
```

must work.

Do not continue to large UI work before this is verified.

---

## Phase 2 — Protocol Package

Implement and test:

```text
parseExpoRequest()

selectUpdate()

createManifest()

signManifest()

createMultipartResponse()

createNoUpdateResponse()
```

Keep protocol behavior isolated from Turso and HTTP routing wherever possible.

---

## Phase 3 — Turso + Drizzle

Implement Drizzle schemas:

```text
admins

applications
application_signing_keys

channels

releases
release_variants

assets
release_assets

deployments
```

Generate migrations with Drizzle Kit.

Apply against development Turso database.

Add database-level constraints.

---

## Phase 4 — Application Management

Implement:

```text
create application

list applications

application settings

OTA update key

default channels

client configuration
```

Build corresponding Vite React screens.

---

## Phase 5 — Object Storage

Implement:

```text
AssetStorage interface

R2 implementation

SHA-256 storage paths

immutable caching
```

Add deduplication.

---

## Phase 6 — Release Importer

Implement:

```text
upload

temporary file handling

safe ZIP extraction

Expo metadata parsing

app identity validation

runtime discovery

asset hashing

asset uploading

manifest generation

manifest signing

draft release creation
```

---

## Phase 7 — Release Dashboard

Implement React screens for:

```text
release list

release details

upload

validation result

release preview
```

---

## Phase 8 — Publishing

Implement:

```text
publish to staging

publish to production

promotion

deployment mapping
```

Use Turso transactions for deployment changes.

---

## Phase 9 — Rollback

Implement rollback by generating a new release from previous release contents.

Reuse existing asset references.

Create:

```text
new updateId
new createdAt
new manifest
new signature
```

---

## Phase 10 — Authentication

Implement secure administrator login/session management.

Protect all `/api/admin/*` routes.

---

## Phase 11 — Hardening

Add:

```text
upload limits

ZIP bomb protection

rate limiting

structured logging

error handling

transaction validation

asset cleanup strategy

security headers
```

---

## Phase 12 — Android + iOS Verification

Complete real-device tests.

Do not mark V1 production-ready until signed OTA updates work on both platforms.

---

# 57. Documentation

Create:

```text
README.md

docs/
  architecture.md
  development.md
  deployment.md

  expo-protocol.md
  client-setup.md

  publishing.md
  code-signing.md

  turso.md
  database-migrations.md

  troubleshooting.md
```

The development guide should assume Bun.

Example:

```bash
git clone ...

bun install

bun run db:migrate

bun run dev
```

Do not document npm/Node as the primary workflow.

---

# 58. Coding-Agent Requirements

Before implementing the Expo-specific parts, the coding agent must:

1. Read the current Expo Updates v1 specification.
2. Read the official Expo custom update server example.
3. Read the current `expo-updates` configuration documentation.
4. Generate a real Expo export.
5. Inspect the actual exported metadata.
6. Validate the exact expected manifest structure.
7. Validate multipart response behavior.
8. Validate no-update behavior.
9. Validate Expo code signing against a real client.

For infrastructure:

10. Use Bun as the runtime and package manager.
11. Use Hono for the backend HTTP API.
12. Use Turso/libSQL as the database.
13. Use Drizzle ORM for database access.
14. Use Drizzle Kit for all schema migrations.
15. Use Vite + React + TypeScript for the web interface.
16. Avoid Node-specific assumptions where Bun/Web APIs work.
17. Avoid PostgreSQL-specific SQL.
18. Remember that SQLite/libSQL semantics differ from PostgreSQL.
19. Keep the codebase multi-application from the beginning.
20. Do not add V2 features while implementing V1.

---

# 59. Important Turso Considerations

Because the database is SQLite/libSQL based, the implementation must not blindly reuse PostgreSQL-oriented designs.

The coding agent should specifically account for:

```text
SQLite-compatible column types

SQLite foreign-key behavior

SQLite transaction semantics

JSON storage strategy

timestamp representation

boolean representation

enum representation
```

Prefer simple portable values.

For example, statuses can be stored as text:

```text
draft
published
archived
```

and validated through application-level schemas/types.

JSON can be stored as text/JSON-compatible columns according to the chosen Drizzle/Turso support.

Do not introduce PostgreSQL-only concepts such as:

```text
native Postgres enums
JSONB-specific operators
array columns
SERIAL
Postgres advisory locks
```

---

# 60. Concurrency

Publishing operations must account for concurrent administrator actions.

For example, two simultaneous attempts to publish different releases to:

```text
Acadion
production
android
runtime 1.5.0
```

must leave exactly one valid deployment mapping.

Use:

- database unique constraints
- transactions
- appropriate conditional writes

to guarantee consistency.

Do not rely only on UI buttons being disabled.

---

# 61. Definition of Done

V1 is complete when:

```text
✓ Bun is the backend runtime

✓ Bun is used for package management and project scripts

✓ Hono serves the backend API

✓ Turso stores application metadata

✓ Drizzle ORM handles database access

✓ Drizzle Kit handles migrations

✓ Vite + React provides the admin UI

✓ Multiple applications can be created

✓ Each application has an independent OTA URL

✓ Each application has independent channels

✓ Each application has independent signing identity

✓ production and staging channels exist

✓ Expo exports can be uploaded manually

✓ uploads are safely validated

✓ Android/iOS variants are detected

✓ runtime versions are detected

✓ application identity is validated

✓ assets are hashed

✓ assets are stored immutably

✓ duplicate assets are deduplicated

✓ valid Expo Updates v1 manifests are generated

✓ manifests are signed

✓ draft releases can be created

✓ releases can be published

✓ staging can be promoted to production

✓ old release contents can be republished as rollback

✓ runtime mismatches never receive updates

✓ applications can never receive each other's releases

✓ Android receives signed OTA update

✓ iOS receives signed OTA update

✓ no-update behavior works

✓ published releases are immutable

✓ protocol tests exist

✓ database isolation tests exist

✓ importer security tests exist
```

---

# 62. Desired V1 User Experience

## First-time application setup

```text
OTA Dashboard
     ↓
Create Application
     ↓
Enter App Identifiers
     ↓
OTA Server Generates Update URL
     ↓
Configure expo-updates
     ↓
Embed Signing Certificate
     ↓
Build App Store Binary
```

## Normal publishing

Developer:

```text
change JS/TS
     ↓
bunx expo export
     ↓
create upload archive
```

Dashboard:

```text
Applications
     ↓
Choose App
     ↓
Upload Release
     ↓
Validate
     ↓
Save Draft
     ↓
Publish to Staging
     ↓
Test
     ↓
Promote to Production
```

Installed application:

```text
expo-updates
     │
     ▼
/api/v1/updates/:updateKey
     │
     ▼
Application
     │
     ▼
Channel
     │
     ▼
Platform
     │
     ▼
Runtime Version
     │
     ▼
Deployment
     │
     ▼
Signed Manifest
     │
     ▼
R2 Immutable Assets
     │
     ▼
Updated Application
```

---

# 63. Architectural Invariants

These rules should be treated as non-negotiable during implementation.

### Application isolation

Every OTA operation belongs to exactly one Application.

### Runtime compatibility

Never send an update for a different runtime version.

### Immutable releases

Published release contents never change.

### Immutable assets

A published asset URL never changes contents.

### Signing

Production OTA updates must be signed.

### Exact promotion

Promotion moves an existing tested release; it does not rebuild it.

### Safe rollback

Rollback republishes previous contents under a new update identity.

### Manual V1

No CI/CD or Git integration.

### Bun-first

Bun is the primary runtime, package manager, script runner, and development tool.

### Turso-first persistence

All relational application state uses Turso through Drizzle ORM.

### Drizzle-owned schema

Database evolution happens through Drizzle schema definitions and Drizzle migrations.

### Simple frontend

The admin UI remains a straightforward Vite + React SPA.