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

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('meteora.slippagePct'),
    strategyType: ConfigManagerV2.getInstance().get('meteora.strategyType') ?? 0,
    temporalApiKey: ConfigManagerV2.getInstance().get('meteora.temporalApiKey') ?? '',

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
