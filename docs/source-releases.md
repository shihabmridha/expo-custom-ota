# Source release grouping

`sourceRevision` is source provenance shared by a native build and a separately
exported OTA bundle. It does not replace server release IDs or Expo update UUIDs,
and it does not assert byte-for-byte equality between independently built bundles.

## Uploads and rollback

CLI 0.1.3 accepts `--release-metadata <path>` with a fresh Android export. It
verifies a clean checkout at the descriptor's Git commit before export and again
after archive assembly, before any upload. Generated output and local descriptors
must be gitignored. Source edits or commit changes during export abort publication.
The archive's optional `releaseMetadata.json` is validated against the application,
export platform, runtime, app version and native version code before import.
The version-1 descriptor shape lives in `packages/contracts/src/schemas/source-metadata.ts`.
Source revisions contain 1–128 printable ASCII characters without spaces; invalid
values and unexpected descriptor fields are rejected, never truncated.

Imported releases store nullable source revision and descriptor fields. Legacy
archives retain nulls. Rollback copies this metadata while generating new server
release/update UUIDs and preserving the existing deployment history.

## Device reports

Apps send lowercase extra parameters `source-revision` and `source-update-id`.
Clear the associated UUID before changing the label, then write the running
`Updates.updateId`. The server accepts a client label only when its accompanying
UUID matches the native `expo-current-update-id` header. Every poll replaces the
association, including clearing it for missing, invalid, or stale metadata.

For imported update UUIDs, the server's release metadata is authoritative, even
when null. Client reports cannot relabel those releases. Embedded/downloaded
status is derived from current versus embedded native update IDs; missing IDs
produce unknown status. Client-supplied provenance remains an observability hint.

## Admin API and dashboard

`GET /api/admin/applications/:id/device-source-groups` accepts the same channel,
platform, runtime and 1/7/30-day activity filters as device metrics. It groups
retained installs by channel, platform, runtime and source revision, with counts
for each update UUID and launch kind. Native-only revisions need no OTA import;
legacy installs appear under unknown source revision. The application route
provides tenant scope. User-ID fallback records are excluded from install groups,
matching device metrics; they remain visible in the install-record list.

The install list also exposes `sourceRevision` and `launchKind`. The dashboard's
Source releases panel displays these groups; Update history continues to display
the original served/confirmed funnel. No grouping field participates in selection,
targeting, or confirmation proof.

## Rollout

Apply the additive nullable migration and deploy server support first. Then deploy
the dashboard and manually publish CLI 0.1.3, followed by mobile builds/reporting.
No historical source labels are inferred. Staging OTA publication and native store
uploads are separate release actions. The integration coverage is in
`backend/tests/source-releases.test.ts` and `packages/cli/tests/source-metadata.test.ts`.
