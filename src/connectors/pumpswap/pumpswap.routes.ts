import sensible from '@fastify/sensible';
import type { FastifyPluginAsync } from 'fastify';

import { pumpswapRouterRoutes } from './router-routes';

// PumpSwap AMM 直连路由（本地补丁，2026-08-26）：/connectors/pumpswap/router/*
const pumpswapRouterRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);
  await fastify.register(pumpswapRouterRoutes);
};

export const pumpswapRoutes = {
  router: pumpswapRouterRoutesWrapper,
};
