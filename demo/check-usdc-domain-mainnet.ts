/**
 * Check the EIP-712 domain of Base Mainnet USDC + SBC contracts.
 * Usage: npx tsx demo/check-usdc-domain-mainnet.ts
 */
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const SBC_ADDRESS = '0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798' as const;

const ABI = [
  { inputs: [], name: 'name', outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'version', outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'DOMAIN_SEPARATOR', outputs: [{ type: 'bytes32' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'eip712Domain', outputs: [
    { name: 'fields', type: 'bytes1' },
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
    { name: 'extensions', type: 'uint256[]' },
  ], stateMutability: 'view', type: 'function' },
] as const;

async function checkDomain(label: string, address: `0x${string}`) {
  const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
  console.log(`\n=== ${label} (${address}) ===`);

  try {
    const name = await client.readContract({ address, abi: ABI, functionName: 'name' });
    console.log(`name(): "${name}"`);
  } catch { console.log('name(): not available'); }

  try {
    const version = await client.readContract({ address, abi: ABI, functionName: 'version' });
    console.log(`version(): "${version}"`);
  } catch { console.log('version(): not available'); }

  try {
    const ds = await client.readContract({ address, abi: ABI, functionName: 'DOMAIN_SEPARATOR' });
    console.log(`DOMAIN_SEPARATOR(): ${ds}`);
  } catch { console.log('DOMAIN_SEPARATOR(): not available'); }

  try {
    const domain = await client.readContract({ address, abi: ABI, functionName: 'eip712Domain' });
    console.log(`eip712Domain():`, domain);
  } catch { console.log('eip712Domain(): not available'); }
}

async function main() {
  await checkDomain('USDC (Base Mainnet)', USDC_ADDRESS);
  await checkDomain('SBC (Base Mainnet)', SBC_ADDRESS);
}

main().catch(console.error);
