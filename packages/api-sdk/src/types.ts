import type { contracts, RouteResponse } from '@ota/contracts';

/**
 * Response types, inferred from the contracts rather than restated — so they
 * cannot drift from what the server actually returns.
 */
export type ImportReleaseResult = RouteResponse<typeof contracts.releases.import>;
export type ReleaseDetail = RouteResponse<typeof contracts.releases.get>;
export type Release = RouteResponse<typeof contracts.releases.list>[number];
export type Application = RouteResponse<typeof contracts.applications.get>;
export type PublishResult = RouteResponse<typeof contracts.releases.publish>;
export type ClientConfig = RouteResponse<typeof contracts.applications.clientConfig>;
export type Deployment = RouteResponse<typeof contracts.deployments.list>[number];
