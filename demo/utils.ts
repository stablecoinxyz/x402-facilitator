import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

export const DEVNET_URL = 'https://api.devnet.solana.com';
export const DATA_DIR = path.join(__dirname, '.data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

export function loadOrGenerateKeypair(name: string): Keypair {
  const filePath = path.join(DATA_DIR, `${name}.json`);
  if (fs.existsSync(filePath)) {
    const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    return Keypair.fromSecretKey(secretKey);
  } else {
    const keypair = Keypair.generate();
    fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
    return keypair;
  }
}

export function getKeypairPath(name: string): string {
    return path.join(DATA_DIR, `${name}.json`);
}

export async function requestAirdrop(connection: Connection, address: PublicKey) {
  const balance = await connection.getBalance(address);
  if (balance < LAMPORTS_PER_SOL) {
    console.log(`💧 Airdropping 1 SOL to ${address.toBase58().substring(0, 8)}...`);
    try {
      const signature = await connection.requestAirdrop(address, LAMPORTS_PER_SOL);
      const latestBlockHash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: signature,
      });
      console.log('   ✅ Airdrop successful');
    } catch (e) {
      console.log('   ⚠️ Airdrop failed (might be rate limited or already funded). Continuing...');
    }
  } else {
    console.log(`   ✅ Balance sufficient (${balance / LAMPORTS_PER_SOL} SOL)`);
  }
}
