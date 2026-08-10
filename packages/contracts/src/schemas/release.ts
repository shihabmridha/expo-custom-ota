import { z } from 'zod';
import {
  channelNameSchema,
  importStatusSchema,
  platformSchema,
  releaseStatusSchema,
} from './common.ts';

export const releaseVariantSchema = z.object({
  id: z.string(),
  platform: platformSchema,
  runtimeVersion: z.string(),
  updateId: z.string(),
  signed: z.boolean(),
  signingKeyId: z.string().nullable(),
  assetCount: z.number().int(),
  launchAssetSizeBytes: z.number().int(),
  totalSizeBytes: z.number().int(),
  createdAt: z.string(),
});

export const releaseSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  releaseNumber: z.number().int(),
  message: z.string().nullable(),
  status: releaseStatusSchema,
  importStatus: importStatusSchema,
  importError: z.string().nullable(),
  sourceFilename: z.string().nullable(),
  sourceSizeBytes: z.number().int().nullable(),
  rollbackOfReleaseId: z.string().nullable(),
  createdAt: z.string(),
});

export type Release = z.infer<typeof releaseSchema>;

/** A release plus everything the preview screen shows. */
export const releaseDetailSchema = releaseSchema.extend({
  variants: z.array(releaseVariantSchema),
  deployedTo: z.array(
    z.object({
      channelName: z.string(),
      platform: platformSchema,
      runtimeVersion: z.string(),
    }),
  ),
});

export type ReleaseDetail = z.infer<typeof releaseDetailSchema>;

export const importReleaseQuerySchema = z.object({
  message: z.string().max(1000).optional(),
  filename: z.string().max(255).optional(),
});

export const importReleaseResultSchema = z.object({
  releaseId: z.string(),
  releaseNumber: z.number().int(),
  importStatus: importStatusSchema,
});

export const publishInputSchema = z.object({
  channel: channelNameSchema,
  /** Omit to publish every platform present in the release. */
  platforms: z.array(platformSchema).min(1).optional(),
});

export const promoteInputSchema = z.object({
  fromChannel: channelNameSchema,
  toChannel: channelNameSchema,
  platforms: z.array(platformSchema).min(1).optional(),
});

export const rollbackInputSchema = z.object({
  /** Channel to publish the newly-created rollback release to. */
  channel: channelNameSchema,
  platforms: z.array(platformSchema).min(1).optional(),
  message: z.string().max(1000).optional(),
});

export const publishResultSchema = z.object({
  releaseId: z.string(),
  releaseNumber: z.number().int(),
  deployments: z.array(
    z.object({
      channelName: z.string(),
      platform: platformSchema,
      runtimeVersion: z.string(),
      updateId: z.string(),
    }),
  ),
});

export const rollbackToEmbeddedInputSchema = z.object({
  channel: channelNameSchema,
  platform: platformSchema,
  runtimeVersion: z.string().min(1),
});

export const deploymentEventSchema = z.object({
  id: z.string(),
  channelName: z.string(),
  platform: platformSchema,
  runtimeVersion: z.string(),
  action: z.enum(['publish', 'promote', 'rollback', 'rollback_to_embedded', 'clear']),
  fromUpdateId: z.string().nullable(),
  toUpdateId: z.string().nullable(),
  createdAt: z.string(),
});

export const metricsSchema = z.object({
  totals: z.object({
    releases: z.number().int(),
    assets: z.number().int(),
    storageBytes: z.number().int(),
  }),
  daily: z.array(
    z.object({
      day: z.string(),
      platform: platformSchema,
      result: z.string(),
      count: z.number().int(),
    }),
  ),
});
