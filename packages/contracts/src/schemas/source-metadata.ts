import type { SourceMetadata } from '@ota/types/source-metadata';
import { z } from 'zod';

export const sourceRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);

export const sourceMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRevision: sourceRevisionSchema,
    gitCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    application: z.string().min(1).max(255),
    environment: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    platform: z.literal('android'),
    runtimeVersion: z.string().min(1).max(128),
    appVersion: z.string().min(1).max(80),
    nativeVersionCode: z.number().int().positive(),
    toolchain: z
      .object({
        bun: z.string().min(1).max(64),
        node: z.string().min(1).max(64),
        expo: z.string().min(1).max(64),
        reactNative: z.string().min(1).max(64),
        expoUpdates: z.string().min(1).max(64),
      })
      .strict(),
    publicConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => value.sourceRevision === `${value.appVersion}+${value.gitCommit}`, {
    message: 'sourceRevision must be appVersion+gitCommit',
  }) satisfies z.ZodType<SourceMetadata>;
