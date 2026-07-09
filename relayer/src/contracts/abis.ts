import { parseAbi } from "viem";

export const gasFlowDelegatorAbi = parseAbi([
  "function execute((address to, uint256 value, bytes data)[] calls, bytes signature, address feeToken, uint256 maxFeeAmount, uint256 authGasOverhead, uint256 deadline) external payable",
  "function nonce() external view returns (uint256)",
  "function config() external view returns (address)",
  "function FIXED_GAS_OVERHEAD() external view returns (uint256)",
  "event CallExecuted(address indexed to, uint256 value)",
  "event BatchExecuted(uint256 indexed nonce, address indexed relayer, uint256 gasUsed, uint256 ethCompensation, uint256 l1Fee)",
  "event FeeCollected(address indexed token, uint256 feeAmount, uint256 ethCompensation)",
] as const);

export const gasFlowConfigAbi = parseAbi([
  "function priceFeeds(address token) external view returns (address ethUsdFeed, address tokenUsdFeed)",
  "function minFeeRateBps() external view returns (uint256)",
  "function l1FeeBps() external view returns (uint256)",
  "function stakePool() external view returns (address)",
  "function feeTokenDecimals(address token) external view returns (uint8)",
  "function relayers(address) external view returns (bool)",
  "function paused() external view returns (bool)",
  "function delegatorCodeHash() external view returns (bytes32)",
  "function STALENESS_THRESHOLD() external view returns (uint256)",
  "function setStakePool(address _stakePool) external",
  "function processCompensation(address relayer, uint256 ethAmount, address feeToken, uint256 feeAmount) external",
] as const);

export const chainlinkAggregatorAbi = parseAbi([
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
] as const);
