# Fixture: real `expo export` output

Genuine output of `bunx expo export --platform all`, not hand-written.

| | |
|---|---|
| Expo SDK | 57 (`expo@~57.0.11`) |
| Template | `create-expo-app --template blank-typescript` |
| Generated | 2026-08-10 on Windows 11 |
| `runtimeVersion` | `1.0.0` (explicit string) |
| `android.package` / `ios.bundleIdentifier` | `xyz.oat.fixture` |

`App.tsx` was modified to `require()` two images so the export contains real
assets — the unmodified blank template produces `assets: []`.

`expoConfig.json` is **not** produced by `expo export`. It was generated
separately with:

```js
const { exp } = require('@expo/config').getConfig(projectDir, {
  skipSDKVersionRequirement: true,
  isPublicConfig: true,
});
```

## Properties this fixture is here to pin

- The bundle filename is `index-<hash>.hbc` — **not** `entry-<hash>.hbc` as
  often documented. Always read `fileMetadata[platform].bundle`; never derive it.
- Asset paths in `metadata.json` use **backslashes** when the export is produced
  on Windows (`"assets\\cb975bba..."`), because `@expo/cli` builds them with
  `path.join`. ZIP entry names are always forward-slashed, so the importer must
  normalise. See `normalizeExportPath`.
- `assets/<hash>` files carry **no file extension**; the extension lives only in
  `metadata.json`.
- `version: 0`, `bundler: "metro"`.

## Do not reformat

These files are `-text -diff` in `.gitattributes`. Line-ending conversion would
change their SHA-256 and break every hash and signature assertion in a way that
looks like a crypto bug. Do not run a formatter over them.
