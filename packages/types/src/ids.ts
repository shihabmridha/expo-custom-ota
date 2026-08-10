/**
 * Branded id types.
 *
 * Every table's primary key is a `text` UUID, so structurally they are all
 * `string` and nothing stops you passing a channel id where an application id
 * is expected. Branding makes that a compile error at zero runtime cost, which
 * matters here because the multi-application isolation invariant is enforced by
 * threading the right id into every query.
 */
declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ApplicationId = Brand<string, 'ApplicationId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type ReleaseId = Brand<string, 'ReleaseId'>;
export type ReleaseVariantId = Brand<string, 'ReleaseVariantId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type DeploymentId = Brand<string, 'DeploymentId'>;
export type AdminId = Brand<string, 'AdminId'>;
export type SigningKeyId = Brand<string, 'SigningKeyId'>;

/**
 * The `id` field of a manifest. Must be UUID-formatted: the client calls
 * `UUID.fromString` on it and throws otherwise.
 */
export type UpdateId = Brand<string, 'UpdateId'>;

export const asApplicationId = (v: string) => v as ApplicationId;
export const asChannelId = (v: string) => v as ChannelId;
export const asReleaseId = (v: string) => v as ReleaseId;
export const asReleaseVariantId = (v: string) => v as ReleaseVariantId;
export const asAssetId = (v: string) => v as AssetId;
export const asDeploymentId = (v: string) => v as DeploymentId;
export const asAdminId = (v: string) => v as AdminId;
export const asSigningKeyId = (v: string) => v as SigningKeyId;
export const asUpdateId = (v: string) => v as UpdateId;
