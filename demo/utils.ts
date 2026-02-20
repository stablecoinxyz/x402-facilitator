import fs from "fs";
import path from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain, Hex } from "viem";
import { base } from "viem/chains";

export const DATA_DIR = path.join(__dirname, ".data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Network configurations
export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  sbcAddress: `0x${string}`;
  sbcDecimals: number;
  networkId: string; // for x402 header
  explorerTxUrl: string | null; // e.g. "https://basescan.org/tx/" or null
}

export const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    name: "Base (Mainnet)",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    sbcAddress: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798",
    sbcDecimals: 18,
    networkId: "base",
    explorerTxUrl: "https://basescan.org/tx/",
  },
  "base-sepolia": {
    name: "Base Sepolia (Testnet)",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    sbcAddress: "0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16",
    sbcDecimals: 6,
    networkId: "base-sepolia",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
  },
  radius: {
    name: "Radius (Mainnet)",
    chainId: 723,
    rpcUrl: "https://rpc.radiustech.xyz",
    sbcAddress: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb",
    sbcDecimals: 6,
    networkId: "radius",
    explorerTxUrl: null,
  },
  "radius-testnet": {
    name: "Radius (Testnet)",
    chainId: 72344,
    rpcUrl: "https://rpc.testnet.radiustech.xyz",
    sbcAddress: "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb",
    sbcDecimals: 6,
    networkId: "radius-testnet",
    explorerTxUrl: "https://testnet.radiustech.xyz/testnet/explorer",
  },
};

/** Parse --network <name> from process.argv, defaults to 'base' */
export function getNetwork(): NetworkConfig {
  const args = process.argv;
  const idx = args.indexOf("--network");
  const key = idx !== -1 && args[idx + 1] ? args[idx + 1] : "base";
  const network = NETWORKS[key];
  if (!network) {
    console.error(`Unknown network: ${key}`);
    console.error(`Available networks: ${Object.keys(NETWORKS).join(", ")}`);
    process.exit(1);
  }
  return network;
}

/** Create a viem chain object for a network config */
function toViemChain(network: NetworkConfig) {
  if (network.networkId === "base") return base;
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
  });
}

/** Create a public client for the given network */
export function getPublicClient(network: NetworkConfig) {
  return createPublicClient({
    chain: toViemChain(network),
    transport: http(network.rpcUrl),
  });
}

/** Get the viem chain object for the given network */
export function getViemChain(network: NetworkConfig) {
  return toViemChain(network);
}

export function loadOrGenerateKey(name: string): Hex {
  const filePath = path.join(DATA_DIR, `${name}.key`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8").trim() as Hex;
  } else {
    const key = generatePrivateKey();
    fs.writeFileSync(filePath, key);
    return key;
  }
}

export function getAccount(name: string) {
  const key = loadOrGenerateKey(name);
  return privateKeyToAccount(key);
}
