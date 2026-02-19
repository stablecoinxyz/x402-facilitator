import fs from 'fs';
import path from 'path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, Hex } from 'viem';
import { base } from 'viem/chains';

export const DATA_DIR = path.join(__dirname, '.data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

export const publicClient = createPublicClient({
  chain: base,
  transport: http()
});

export function loadOrGenerateKey(name: string): Hex {
  const filePath = path.join(DATA_DIR, `${name}.key`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8').trim() as Hex;
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
