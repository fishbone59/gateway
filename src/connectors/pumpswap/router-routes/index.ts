import { FastifyPluginAsync } from 'fastify';

import directBuyRoute from './directBuy';

export const pumpswapRouterRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(directBuyRoute);
};

export default pumpswapRouterRoutes;
