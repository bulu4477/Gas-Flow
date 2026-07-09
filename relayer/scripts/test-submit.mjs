/**
 * GasFlow Relayer 端到端测试脚本（方案A：直接 transfer，无需 permit）
 *
 * 流程：
 *   1. 检查用户 USDC 余额
 *   2. 构造测试 calls
 *   3. 读取当前 delegator nonce 并本地签名 execute digest
 *   4. 调用 /estimate（带上 signature）获取真实 gas 和 maxFeeAmount
 *   5. 检查 EIP-7702 委托状态，未委托则签 authorization
 *   6. 调用 /submit 提交交易
 *   7. 轮询 /status 等待确认
 *
 * 使用方法：
 *   1. 确保 .env 文件已配置好（和 relayer 用的同一个）
 *   2. 在 .env 里加一行：TEST_USER_PRIVATE_KEY=0x<你的测试用户私钥>
 *   3. 启动 relayer：npm run dev
 *   4. 运行测试：node scripts/test-submit.mjs
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  getAddress,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as dotenv from "dotenv";

dotenv.config();

const FEE_TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3000";
let rawKey = process.env.TEST_USER_PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const DELEGATOR_ADDRESS = process.env.DELEGATOR_CONTRACT_ADDRESS;
const CONFIG_ADDRESS = process.env.CONFIG_CONTRACT_ADDRESS;
const API_KEY = process.env.RELAYER_API_KEY;

if (!rawKey) {
  console.error("❌ 请在 .env 中设置 TEST_USER_PRIVATE_KEY");
  process.exit(1);
}
if (!rawKey.startsWith("0x")) rawKey = "0x" + rawKey;
if (rawKey.length !== 66) {
  console.error(`❌ TEST_USER_PRIVATE_KEY 格式不对（${rawKey.length - 2} 位 hex）`);
  process.exit(1);
}
const USER_PRIVATE_KEY = rawKey;
if (!RPC_URL) { console.error("❌ 请在 .env 中设置 RPC_URL"); process.exit(1); }
if (!DELEGATOR_ADDRESS) { console.error("❌ 请在 .env 中设置 DELEGATOR_CONTRACT_ADDRESS"); process.exit(1); }
if (!CONFIG_ADDRESS) { console.error("❌ 请在 .env 中设置 CONFIG_CONTRACT_ADDRESS"); process.exit(1); }

const account = privateKeyToAccount(USER_PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
const DELEGATOR_NONCE_SLOT = keccak256(stringToBytes("gasflow.delegator.nonce"));

console.log(`测试用户地址: ${account.address}`);
console.log(`Fee Token:    ${FEE_TOKEN}`);
console.log(`Delegator:    ${DELEGATOR_ADDRESS}`);
console.log(`Config:       ${CONFIG_ADDRESS}`);
console.log(`Relayer URL:  ${RELAYER_URL}`);
console.log("---");

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

function stringifyBigInt(_, v) { return typeof v === "bigint" ? v.toString() : v; }

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  return headers;
}

async function postJSON(path, body) {
  const res = await fetch(`${RELAYER_URL}${path}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body, stringifyBigInt),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getJSON(path) {
  const res = await fetch(`${RELAYER_URL}${path}`, { headers: buildHeaders() });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function computeBatchDigest(chainId, nonce, calls, feeToken, maxFeeAmount, authGasOverhead, deadline) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        {
          type: "tuple[]",
          components: [
            { type: "address", name: "to" },
            { type: "uint256", name: "value" },
            { type: "bytes", name: "data" },
          ],
        },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [BigInt(chainId), nonce, calls, feeToken, maxFeeAmount, authGasOverhead, deadline],
    ),
  );
}

async function main() {
  console.log("\n[1/7] 检查用户 USDC 余额...");
  const balance = await publicClient.readContract({
    address: FEE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  });
  console.log(`  USDC 余额: ${balance} (raw, 6 decimals)`);
  if (balance < 1000n) console.warn("  ⚠️  余额太少，建议至少有 0.001 USDC 用于测试");

  console.log("\n[2/7] 构造测试 calls...");
  // 用四个 call 组成更复杂的 batch：
  // 1) 转 1 个 USDC 到 burn 地址
  // 2) 转 1000 个 USDC 给自己
  // 3) 再转 2 个 USDC 到 burn 地址
  // 4) 再转 2000 个 USDC 给自己
  const burnAddress = "0x000000000000000000000000000000000000dEaD";
  const calls = [
    { to: FEE_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [burnAddress, 1n] }) },
    { to: FEE_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [account.address, 1000n] }) },
    // { to: "0xB1C9f2643f55A564bAF02945c37aF1A1e307506A", value: 1000000000000000n, data: "0x" },  // 0.001 ETH 转账
  ];
  calls.forEach((call, i) => {
    if (call.data === "0x") {
      console.log(`  Call ${i + 1}: transfer ETH(${call.to}, ${call.value})`);
    } else {
      const amount = i % 2 === 0 ? [1n, 2n][i / 2] : [1000n, 2000n][(i - 1) / 2];
      const to = i % 2 === 0 ? burnAddress : account.address;
      console.log(`  Call ${i + 1}: transfer(${to}, ${amount})`);
    }
  });

  console.log("\n[3/7] 读取当前 delegator nonce...");
  const nonceStorage = await publicClient.getStorageAt({
    address: account.address,
    slot: DELEGATOR_NONCE_SLOT,
  });
  const currentNonce = BigInt(nonceStorage ?? "0x0");
  console.log(`  current nonce: ${currentNonce}`);

  console.log("\n[4/7] 调用 /api/v1/estimate...");
  const estimate = await postJSON("/api/v1/estimate", {
    user: account.address, calls, feeToken: FEE_TOKEN,
  });
  console.log(`  nonce:           ${estimate.nonce}`);
  console.log(`  gasEstimate:     ${estimate.gasEstimate}`);
  console.log(`  authGasOverhead: ${estimate.authGasOverhead}`);
  console.log(`  maxFeeAmount:    ${estimate.maxFeeAmount}`);
  console.log(`  feeTokenDecimals:${estimate.feeTokenDecimals}`);
  console.log(`  rawDigest:       ${estimate.rawDigest}`);
  console.log(`  ethSignedDigest: ${estimate.ethSignedDigest}`);
  console.log(`  deadline:        ${estimate.deadline}`);

  if (BigInt(estimate.nonce) !== currentNonce) {
    console.warn(`  ⚠️ relayer 返回的 nonce 与本地不同: ${estimate.nonce} ≠ ${currentNonce}`);
  }
  const localDigest = computeBatchDigest(
    sepolia.id,
    BigInt(estimate.nonce),
    calls,
    FEE_TOKEN,
    BigInt(estimate.maxFeeAmount),
    BigInt(estimate.authGasOverhead),
    BigInt(estimate.deadline),
  );
  if (estimate.rawDigest !== localDigest) {
    console.error(`  ❌ digest 不匹配! 本地: ${localDigest} Relayer: ${estimate.rawDigest}`);
    process.exit(1);
  }
  console.log("  digest 校验通过 ✓");
  const executeSignature = await account.signMessage({
    message: { raw: localDigest },
  });
  console.log(`  execute signature: ${executeSignature}`);

  console.log("\n[5/7] 检查 EIP-7702 委托状态...");
  const code = await publicClient.getCode({ address: account.address });
  const isDelegated =
    code?.startsWith("0xef0100") &&
    ("0x" + code.slice(8)).toLowerCase() === DELEGATOR_ADDRESS.toLowerCase();
  console.log(`  Code starts with 0xef0100: ${code?.startsWith("0xef0100") ?? false}`);
  console.log(`  Delegated to current Delegator: ${isDelegated}`);

  let authorization = undefined;
  if (!isDelegated) {
    console.log("  未委托到当前 Delegator，正在签名 EIP-7702 authorization...");
    authorization = await walletClient.signAuthorization({
      account, contractAddress: DELEGATOR_ADDRESS,
    });
    console.log(`  authorization: ${JSON.stringify({
      contractAddress: authorization.address,
      chainId: authorization.chainId,
      nonce: authorization.nonce,
      yParity: authorization.yParity,
    })}`);
  } else {
    console.log("  用户已委托 ✓");
  }

  console.log("\n[6/7] 调用 /api/v1/submit...");
  const submitBody = {
    user: account.address,
    calls,
    nonce: estimate.nonce,
    signature: executeSignature,
    feeToken: FEE_TOKEN,
    maxFeeAmount: estimate.maxFeeAmount,
    authGasOverhead: estimate.authGasOverhead,
    deadline: estimate.deadline,
  };
  if (authorization) {
    submitBody.authorization = {
      contractAddress: getAddress(authorization.address),
      chainId: authorization.chainId,
      nonce: authorization.nonce,
      yParity: authorization.yParity,
      r: authorization.r,
      s: authorization.s,
    };
  }
  const submitResult = await postJSON("/api/v1/submit", submitBody);
  console.log(`  ✅ 交易已提交! txHash: ${submitResult.txHash}`);

  console.log("\n[7/7] 等待交易确认...");
  const txHash = submitResult.txHash;
  let confirmed = false;
  let attempts = 0;
  const maxAttempts = 60;

  while (!confirmed && attempts < maxAttempts) {
    attempts++;
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const status = await getJSON(`/api/v1/status/${txHash}`);
      if (status.status === "confirmed") {
        console.log(`  ✅ 交易已确认!`);
        console.log(`  blockNumber: ${status.blockNumber}`);
        console.log(`  gasUsed:     ${status.gasUsed}`);
        if (status.batchExecuted?.length > 0) {
          console.log(`  BatchExecuted 事件:`);
          for (const ev of status.batchExecuted) {
            console.log(`    nonce=${ev.nonce}, gasUsed=${ev.gasUsed}, ethCompensation=${ev.ethCompensation}`);
          }
        }
        if (status.feeCollected?.length > 0) {
          console.log(`  FeeCollected 事件:`);
          for (const ev of status.feeCollected) {
            console.log(`    token=${ev.token}, feeAmount=${ev.feeAmount}, ethCompensation=${ev.ethCompensation}`);
          }
        }
        confirmed = true;
      } else if (status.status === "failed") {
        console.error(`  ❌ 交易失败!`);
        process.exit(1);
      } else {
        process.stdout.write(".");
      }
    } catch {
      process.stdout.write(".");
    }
  }

  if (!confirmed) {
    console.log(`\n  ⏰ 超时，交易仍未确认。可以用 /api/v1/status/${txHash} 手动查询`);
  }
  console.log("\n=== 测试完成 ===");
}

main().catch((err) => {
  console.error("\n❌ 测试失败:", err.message);
  process.exit(1);
});
