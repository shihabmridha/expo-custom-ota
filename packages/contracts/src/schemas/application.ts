import { z } from 'zod';
import { bundleIdentifierSchema, channelNameSchema, platformSchema, slugSchema } from './common.ts';

export const applicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  updateKey: z.string(),
  description: z.string().nullable(),
  androidPackage: z.string().nullable(),
  iosBundleIdentifier: z.string().nullable(),
  defaultChannel: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Application = z.infer<typeof applicationSchema>;

/** One row of the dashboard's application list. */
export const applicationSummarySchema = applicationSchema.extend({
  releaseCount: z.number().int(),
  channelSummaries: z.array(
    z.object({
      channel: z.string(),
      latestReleaseNumber: z.number().int().nullable(),
    }),
  ),
  runtimeVersionCount: z.number().int(),
  hasSigningKey: z.boolean(),
});

export type ApplicationSummary = z.infer<typeof applicationSummarySchema>;

export const createApplicationInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    slug: slugSchema,
    description: z.string().max(1000).optional(),
    androidPackage: bundleIdentifierSchema.optional(),
    iosBundleIdentifier: bundleIdentifierSchema.optional(),
    defaultChannel: channelNameSchema.default('production'),
    /** Generate an RSA-2048 code signing key and certificate on creation. */
    generateSigningKey: z.boolean().default(true),
  })
  .refine((v) => v.androidPackage || v.iosBundleIdentifier, {
    error:
      'Set at least one of androidPackage or iosBundleIdentifier. Without one, uploads cannot be ' +
      'checked against this application and an export for a different app would be accepted.',
    path: ['androidPackage'],
  });

export const updateApplicationInputSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(1000).nullable().optional(),
  androidPackage: bundleIdentifierSchema.nullable().optional(),
  iosBundleIdentifier: bundleIdentifierSchema.nullable().optional(),
  defaultChannel: channelNameSchema.optional(),
});

export const channelSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

export const createChannelInputSchema = z.object({ name: channelNameSchema });

export const deploymentSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  platform: platformSchema,
  runtimeVersion: z.string(),
  releaseVariantId: z.string().nullable(),
  releaseId: z.string().nullable(),
  releaseNumber: z.number().int().nullable(),
  updateId: z.string().nullable(),
  directive: z.string().nullable(),
  updatedAt: z.string(),
});

export type Deployment = z.infer<typeof deploymentSchema>;

export const signingKeySchema = z.object({
  keyId: z.string(),
  certificatePem: z.string(),
  certificateFingerprint: z.string(),
  certificateNotAfter: z.string(),
  status: z.enum(['active', 'retired']),
  createdAt: z.string(),
});

/** Everything needed to configure `expo-updates` against this application. */
export const clientConfigSchema = z.object({
  applicationId: z.string(),
  otaUrl: z.string(),
  updateKey: z.string(),
  defaultChannel: z.string(),
  certificatePem: z.string().nullable(),
  keyId: z.string().nullable(),
  /** A ready-to-paste `app.json` fragment. */
  appJsonSnippet: z.string(),
  channels: z.array(z.string()),
});

export const simulateRequestInputSchema = z.object({
  platform: platformSchema,
  runtimeVersion: z.string().min(1),
  channelName: z.string().optional(),
  currentUpdateId: z.string().optional(),
  embeddedUpdateId: z.string().optional(),
  expectSignature: z.boolean().default(true),
});

/**
 * Result of replaying an update request server-side.
 *
 * This is the tool that diagnoses "my device isn't updating" without needing
 * the device, so it reports the decision, the parts, and whether the signature
 * actually verifies against the stored certificate.
 */
export const simulateRequestResultSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  decision: z.string(),
  manifest: z.string().nullable(),
  directive: z.string().nullable(),
  signature: z.string().nullable(),
  signatureVerified: z.boolean().nullable(),
  notes: z.array(z.string()),
});
