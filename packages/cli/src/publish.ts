import { OtaClient } from '@ota/api-sdk';
import { type PackOptions, packUpdate } from './pack.ts';

export interface PublishOptions extends PackOptions {
  serverUrl?: string;
  appId?: string;
  channel?: string;
  email?: string;
  password?: string;
  message?: string;
}

export async function publishUpdate(options: PublishOptions = {}): Promise<void> {
  const serverUrl = options.serverUrl ?? process.env.OTA_SERVER_URL;
  const appId = options.appId ?? process.env.OTA_APP_ID;
  const channel = options.channel ?? process.env.OTA_CHANNEL ?? 'production';
  const email = options.email ?? process.env.OTA_EMAIL;
  const password = options.password ?? process.env.OTA_PASSWORD;

  if (!serverUrl) {
    throw new Error('Server URL is required. Pass --server <url> or set OTA_SERVER_URL.');
  }
  if (!appId) {
    throw new Error('Application ID is required. Pass --app <id> or set OTA_APP_ID.');
  }
  if (appId.startsWith('ota_')) {
    throw new Error(
      `"${appId}" looks like an update key (the value in your updates URL), not an application id. ` +
        `The application id is a UUID — find it in the dashboard or via GET /api/admin/applications.`,
    );
  }
  if (!email || !password) {
    throw new Error(
      'Credentials are required for publishing. Set OTA_EMAIL and OTA_PASSWORD or pass --email and --password.',
    );
  }

  const packed = await packUpdate(options);

  console.log(`Connecting to ${serverUrl}…`);
  const client = new OtaClient({ baseUrl: serverUrl });

  console.log(`Authenticating as ${email}…`);
  await client.login(email, password);

  console.log(`Uploading ${(packed.byteLength / 1024 / 1024).toFixed(1)} MB…`);
  console.log(`Publishing release to channel "${channel}"…`);
  const result = await client.importAndPublish(appId, packed.archive, {
    channel,
    message: options.message,
  });

  console.log('✓ Release published successfully!');
  console.log(`  Release ID: ${result.releaseId}`);
  console.log(`  Channel: ${channel}`);
}
