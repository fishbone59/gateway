import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';

// Import routes
import { jupiterRouterRoutes } from './router-routes';
import { jupiterTriggerRoutes } from './trigger-routes';

// Jupiter routes with 4 endpoints
const jupiterRouterRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    // Decorate the instance with a hook to modify route options
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/jupiter'];
      }
    });

    await instance.register(jupiterRouterRoutes);
  });
};

// Jupiter Trigger V2 routes (limit orders / TP-SL / OCO, local patch)
const jupiterTriggerRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);
  await fastify.register(jupiterTriggerRoutes);
};

// Export routes in the same pattern as Raydium
export const jupiterRoutes = {
  router: jupiterRouterRoutesWrapper,
  trigger: jupiterTriggerRoutesWrapper,
};
