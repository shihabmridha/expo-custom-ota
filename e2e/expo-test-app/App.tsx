import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * OAT end-to-end verification app.
 *
 * Change VERSION, re-export, upload, publish — then confirm the device shows
 * the new letter. Everything else on screen exists to make a failure legible
 * without a debugger attached.
 */
const VERSION = 'A';

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const append = (line: string) => setLog((prev) => [...prev, line]);

  // Assets exercise the asset-download path, not just the bundle.
  const images = [require('./assets/icon.png'), require('./assets/splash-icon.png')];

  useEffect(() => {
    append(`updateId: ${Updates.updateId ?? '(embedded)'}`);
    append(`channel: ${Updates.channel ?? '(none)'}`);
    append(`runtimeVersion: ${Updates.runtimeVersion}`);
    append(`isEmbeddedLaunch: ${Updates.isEmbeddedLaunch}`);
    append(`createdAt: ${Updates.createdAt?.toISOString() ?? '—'}`);
  }, []);

  async function checkNow() {
    try {
      append('checking…');
      const result = await Updates.checkForUpdateAsync();
      append(`available: ${result.isAvailable}`);
      if ('reason' in result && result.reason) append(`reason: ${String(result.reason)}`);

      if (result.isAvailable) {
        const fetched = await Updates.fetchUpdateAsync();
        append(`fetched: ${fetched.isNew}`);
        if (fetched.isNew) {
          append('reloading…');
          await Updates.reloadAsync();
        }
      }
    } catch (error) {
      // The interesting failures are here: signature rejection, keyid mismatch,
      // certificate problems. Surface the message verbatim.
      append(`ERROR: ${(error as Error).message}`);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.version}>VERSION {VERSION}</Text>

      <View style={styles.row}>
        {images.map((source, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static list
          <Image key={index} source={source} style={styles.image} />
        ))}
      </View>

      <Text style={styles.button} onPress={checkNow}>
        Check for update
      </Text>

      <ScrollView style={styles.log}>
        {log.map((line) => (
          <Text key={line} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  version: { fontSize: 56, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 12 },
  image: { width: 56, height: 56 },
  button: {
    backgroundColor: '#111',
    color: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    overflow: 'hidden',
  },
  log: { alignSelf: 'stretch', maxHeight: 260 },
  logLine: { fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
});
