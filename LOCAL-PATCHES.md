# 本地补丁说明（分支 local/patches-2.16）

本仓库是 hummingbot/gateway 的私有 fork。`main` 跟踪上游，`local/patches-2.16`
基于上游 v2.16.0，叠加以下本地补丁（全部已实盘验证）：

## Meteora DLMM

- **zap-in 单币开仓**：`/connectors/meteora/clmm/open-position` 支持单币投入，
  内部自动 swap + 加仓。tx-delivery 独立模块，支持多种广播模式：
  `fast`（共享 blockhash 流水线广播 + 批量确认）、`temporal`（Nozomi 确认门控）、
  `jito`（Jito block engine）
- **PoolWatcher**：WSS 喂 lbPair 状态，position-info 免 RPC 轮询

## Jupiter

- **Trigger V2**：OCO 止盈止损挂单支持（`trigger-client`，JWT 鉴权 + Privy 金库）
- **execute-quote `waitConfirm=false` 快路径**：本地签名 + sendRawTransaction 后
  立即返回 signature，跳过网关侧确认/解析；调用方用自有 WSS 确认
- preserveEmbeddedBudget 快路径（跳过二次模拟）、blockhash 拉取与发送重叠

## PumpSwap AMM（pump.fun）

- **`/connectors/pumpswap/router/direct-buy`**：读池储备 + global_config 费率 →
  恒定乘积本地定价 → 本地构建 buy_exact_quote_in → 签名发送即返回
- 精确 25 档阶梯费率（canonical 判定 + 本地费率表）、cashback / Token-2022 /
  BOOST 池（virtual_quote_reserves）支持、cc=SET 池 pool-v2 remaining account
- CU 上限提至 250,000（首买 T22 ATA 场景）

## Solana 性能

- **Keypair 进程内缓存**：getWallet 的 scrypt 解密从每笔 ~500-800ms 降到缓存命中 ~0ms
- wallet-WSS 确认路径（accountSubscribe on fee payer）与轮询竞速，swap 确认 3.4-3.9s → 1.8s

## OKX connector EVM 扩展

- 新增 EVM 网络支持（robinhoodchain 4663，Arbitrum Orbit L2）
- 按金额 approve（串行）、EVM 钱包缓存、静态 gas padding `max(okx_gas × 5, 1.5M)`
  （Orbit 上 OKX gas 估算偏低，不信本地 estimateGas）

## 其他

- http-client dispatcher 统一、solana computeUnitsOverride
- 仓库根目录 `wallet_dlmm_*.js` 为一次性调试脚本

## 升级须知

- `conf/` 与 `certs/` 不入库（gitignored）：链/连接器 yml、token list、钱包、mTLS 证书
  全在运行时配置里，rebase 上游后需手工核对 `src/templates` 变化
- 改完源码须 `pnpm build` 进 dist 并重启网关进程才生效
- rebase 到新版本上游后重点回归：zap-in 三种广播模式、pumpswap direct-buy
  （用 pumpswap-sim.js 先模拟）、execute-quote 快路径
