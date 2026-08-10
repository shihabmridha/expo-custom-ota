import * as schema from '@oat/db/schema/index';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../../app-env.ts';
import { ApplicationError } from '../../services/applications.ts';

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.delete('/:channelId', async (c) => {
  const rows = await c.var.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, c.req.param('channelId')))
    .limit(1);

  const channel = rows[0];
  if (!channel) throw new ApplicationError('NOT_FOUND', 404, 'Unknown channel.');

  const deployments = await c.var.db
    .select({ id: schema.deployments.id })
    .from(schema.deployments)
    .where(eq(schema.deployments.channelId, channel.id))
    .limit(1);

  if (deployments[0]) {
    throw new ApplicationError(
      'CHANNEL_IN_USE',
      409,
      `Channel "${channel.name}" still has deployments. Devices configured for it would stop ` +
        'receiving updates. Remove the deployments first.',
    );
  }

  await c.var.db.delete(schema.channels).where(eq(schema.channels.id, channel.id));
  return c.json({ ok: true as const });
});
