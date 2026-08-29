import { AvailableNetworks } from '../../services/base';
import { ConfigManagerV2 } from '../../services/config-manager-v2';

export namespace OkxConfig {
  // The OKX DEX aggregator connector: Solana mainnet (chainIndex 501) + EVM networks
  // (robinhoodchain = chainIndex 4663, local patch 2026-08-29).
  export const chain = 'solana';
  export const networks = ['mainnet-beta', 'robinhoodchain'];
  export type Network = string;

  // network -> OKX chainIndex
  export const CHAIN_INDEX: Record<string, string> = {
    'mainnet-beta': '501',
    robinhoodchain: '4663',
  };

  // EVM networks served by this connector (all others are treated as Solana)
  export const EVM_NETWORKS = ['robinhoodchain'];

  // Supported trading types
  export const tradingTypes = ['router'] as const;

  export interface RootConfig {
    slippagePct: number;
    apiKey?: string;
    secretKey?: string;
    passphrase?: string;
    computeUnitPrice: number;

    // Available networks
    availableNetworks: Array<AvailableNetworks>;
  }

  export const config: RootConfig = {
    slippagePct: ConfigManagerV2.getInstance().get('okx.slippagePct'),
    apiKey: ConfigManagerV2.getInstance().get('okx.apiKey'),
    secretKey: ConfigManagerV2.getInstance().get('okx.secretKey'),
    passphrase: ConfigManagerV2.getInstance().get('okx.passphrase'),
    computeUnitPrice: ConfigManagerV2.getInstance().get('okx.computeUnitPrice'),

    availableNetworks: [
      {
        chain,
        networks: networks,
      },
    ],
  };
}
