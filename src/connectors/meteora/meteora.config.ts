import { getAvailableSolanaNetworks } from '../../chains/solana/solana.utils';
import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace MeteoraConfig {
  // Supported networks for Meteora
  export const chain = 'solana';
  export const networks = getAvailableSolanaNetworks();
  export type Network = string;

  // Supported trading types
  export const tradingTypes = ['clmm'] as const;

  export interface RootConfig {
    // Global configuration
    slippagePct: number;
    strategyType: number;

    // Temporal (Nozomi) API key for broadcastMode=temporal zap-in
    temporalApiKey: string;

    // Jito block-engine UUID (x-jito-auth) and bundle tip for broadcastMode=jito zap-in
    jitoUuid: string;
    // Tip per bundle in lamports; 0 = dynamic (tip_floor p75 scaled by bundle CU)
    jitoTipLamports: number;
    // Cap for dynamic tip pricing
    jitoTipMaxLamports: number;
    // Regional block-engine endpoint (https://docs.jito.wtf/lowlatencytxnsend)
    jitoBlockEngine: string;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('meteora.slippagePct'),
    strategyType: ConfigManagerV2.getInstance().get('meteora.strategyType') ?? 0,
    temporalApiKey: ConfigManagerV2.getInstance().get('meteora.temporalApiKey') ?? '',
    jitoUuid: ConfigManagerV2.getInstance().get('meteora.jitoUuid') ?? '',
    jitoTipLamports: ConfigManagerV2.getInstance().get('meteora.jitoTipLamports') ?? 10_000,
    jitoTipMaxLamports: ConfigManagerV2.getInstance().get('meteora.jitoTipMaxLamports') ?? 200_000,
    jitoBlockEngine:
      ConfigManagerV2.getInstance().get('meteora.jitoBlockEngine') ??
      'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
