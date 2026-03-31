import { Request, Response } from 'express';
import { config } from '../config';

/**
 * GET /supported - x402 V2 Capability Discovery
 *
 * Returns list of payment kinds (network/scheme combinations) that this facilitator supports,
 * along with extensions and signers per the v2 spec.
 */
export function getSupportedNetworks(req: Request, res: Response) {
  const kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
    extra: { assetTransferMethod: string; name: string; version: string };
  }> = [];

  // Collect configured signer addresses keyed by CAIP-2 namespace
  const signers: Record<string, string[]> = {};

  // Helper: push both v2 and v1 kind entries for a network
  function addKind(network: string, extra: { assetTransferMethod: string; name: string; version: string }) {
    kinds.push({ x402Version: 2, scheme: 'exact', network, extra });
    kinds.push({ x402Version: 1, scheme: 'exact', network, extra });
  }

  // Add Base Mainnet if configured
  if (config.baseFacilitatorAddress && config.baseFacilitatorPrivateKey) {
    addKind('eip155:8453', { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' });
    addKind('eip155:8453', { assetTransferMethod: 'erc2612', name: 'USD Coin', version: '2' });
    addSigner(signers, 'eip155:*', config.baseFacilitatorAddress);
  }

  // Add Base Sepolia if configured
  if (config.baseSepoliaFacilitatorAddress && config.baseSepoliaFacilitatorPrivateKey) {
    addKind('eip155:84532', { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' });
    addKind('eip155:84532', { assetTransferMethod: 'erc2612', name: 'USD Coin', version: '2' });
    addSigner(signers, 'eip155:*', config.baseSepoliaFacilitatorAddress);
  }

  // Add Radius Mainnet if configured
  if (config.radiusFacilitatorAddress && config.radiusFacilitatorPrivateKey) {
    addKind('eip155:723487', { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' });
    addSigner(signers, 'eip155:*', config.radiusFacilitatorAddress);
  }

  // Add Radius Testnet if configured
  if (config.radiusTestnetFacilitatorAddress && config.radiusTestnetFacilitatorPrivateKey) {
    addKind('eip155:72344', { assetTransferMethod: 'erc2612', name: 'Stable Coin', version: '1' });
    addSigner(signers, 'eip155:*', config.radiusTestnetFacilitatorAddress);
  }

  // Add Solana mainnet if configured
  if (config.solanaFacilitatorAddress && config.solanaFacilitatorPrivateKey) {
    addKind('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', { assetTransferMethod: 'delegated-spl', name: 'SBC', version: '1' });
    addSigner(signers, 'solana:*', config.solanaFacilitatorAddress);
  }

  const data = { kinds, extensions: [], signers };

  // If browser, render HTML; otherwise return JSON for machines
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.send(renderSupportedHTML(data));
  } else {
    res.json(data);
  }
}

const NETWORK_LABELS: Record<string, { name: string; type: string }> = {
  'eip155:8453': { name: 'Base', type: 'Mainnet' },
  'eip155:84532': { name: 'Base Sepolia', type: 'Testnet' },
  'eip155:723487': { name: 'Radius', type: 'Mainnet' },
  'eip155:72344': { name: 'Radius', type: 'Testnet' },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', type: 'Mainnet' },
};

function renderSupportedHTML(data: {
  kinds: Array<{ x402Version: number; scheme: string; network: string; extra: { assetTransferMethod: string; name: string; version: string } }>;
  extensions: unknown[];
  signers: Record<string, string[]>;
}) {
  const networkCards = data.kinds.map((k, i) => {
    const label = NETWORK_LABELS[k.network] || { name: k.network, type: '' };
    const isMainnet = label.type === 'Mainnet';
    return `
      <div class="card reveal" style="animation-delay: ${i * 0.1}s">
        <div class="card-header">
          <span class="network-name">${label.name}</span>
          <span class="badge ${isMainnet ? 'badge-main' : 'badge-test'}">${label.type}</span>
        </div>
        <div class="card-rows">
          <div class="row"><span class="label">CAIP-2</span><code>${k.network}</code></div>
          <div class="row"><span class="label">Scheme</span><span>${k.scheme}</span></div>
          <div class="row"><span class="label">Transfer</span><span>${k.extra.assetTransferMethod}</span></div>
          <div class="row"><span class="label">Token</span><span>${k.extra.name} v${k.extra.version}</span></div>
          <div class="row"><span class="label">x402</span><span>v${k.x402Version}</span></div>
        </div>
      </div>`;
  }).join('');

  const signerRows = Object.entries(data.signers).map(([ns, addrs]) =>
    addrs.map(addr => `
      <div class="signer-row reveal">
        <code class="ns">${ns}</code>
        <code class="addr">${addr}</code>
      </div>`).join('')
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Supported Networks — SBC x402 Facilitator</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --purple: #6938EF;
      --purple-light: #8760F2;
      --purple-lighter: #A588F5;
      --bg: #0a0a0f;
      --bg-card: rgba(255,255,255,0.03);
      --text: #e1d7fc;
      --text-muted: #8a80a4;
      --border: rgba(105,56,239,0.15);
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      top: -40%;
      left: 50%;
      transform: translateX(-50%);
      width: 800px;
      height: 800px;
      background: radial-gradient(circle, rgba(105,56,239,0.12) 0%, transparent 70%);
      pointer-events: none;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 80px 24px 60px;
      position: relative;
      z-index: 1;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.85rem;
      margin-bottom: 40px;
      transition: color 0.2s;
    }
    .back:hover { color: var(--text); }
    .page-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--purple-lighter);
      margin-bottom: 8px;
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 8px;
      color: #fff;
    }
    .desc {
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 48px;
    }
    .section-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
      margin-bottom: 56px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      backdrop-filter: blur(8px);
      transition: all 0.3s ease;
    }
    .card:hover {
      border-color: rgba(105,56,239,0.35);
      transform: translateY(-2px);
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .network-name {
      font-size: 1.15rem;
      font-weight: 600;
      color: #fff;
    }
    .badge {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 10px;
      border-radius: 20px;
    }
    .badge-main { background: rgba(34,197,94,0.12); color: #22c55e; }
    .badge-test { background: rgba(250,204,21,0.12); color: #facc15; }
    .card-rows { display: flex; flex-direction: column; gap: 10px; }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
    }
    .label {
      color: var(--text-muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8rem;
      color: var(--purple-lighter);
    }
    .signers { margin-bottom: 56px; }
    .signer-row {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      transition: all 0.3s ease;
    }
    .signer-row:hover { border-color: rgba(105,56,239,0.3); }
    .ns {
      font-size: 0.75rem;
      color: var(--text-muted);
      min-width: 72px;
    }
    .addr {
      font-size: 0.78rem;
      color: var(--text);
      word-break: break-all;
    }
    .json-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text);
      background: var(--bg-card);
      border: 1px solid var(--border);
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
    }
    .json-toggle:hover {
      border-color: rgba(105,56,239,0.4);
      background: rgba(105,56,239,0.08);
    }
    .json-block {
      display: none;
      margin-top: 16px;
      padding: 20px;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow-x: auto;
    }
    .json-block.open { display: block; }
    .json-block pre {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.78rem;
      line-height: 1.6;
      color: var(--text);
    }
    .reveal {
      opacity: 0;
      transform: translateY(16px);
      animation: fadeUp 0.5s ease-out forwards;
    }
    @keyframes fadeUp {
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 600px) {
      h1 { font-size: 1.5rem; }
      .grid { grid-template-columns: 1fr; }
      .signer-row { flex-direction: column; gap: 4px; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">&larr; Home</a>

    <p class="page-title">x402 v2 Capability Discovery</p>
    <h1>Supported Networks</h1>
    <p class="desc">
      This endpoint is part of the <strong>x402 protocol</strong>. Resource servers query it to discover which
      payment networks, schemes, and signer addresses this facilitator supports.
    </p>

    <p class="section-label">Payment Kinds</p>
    <div class="grid">${networkCards}</div>

    <p class="section-label">Facilitator Signers</p>
    <div class="signers">${signerRows}</div>

    <button class="json-toggle" onclick="document.getElementById('raw').classList.toggle('open');this.querySelector('.arrow').textContent=document.getElementById('raw').classList.contains('open')?'&#x25B2;':'&#x25BC;'">
      Raw JSON <span class="arrow">&#x25BC;</span>
    </button>
    <div class="json-block" id="raw">
      <pre>${JSON.stringify(data, null, 2)}</pre>
    </div>
  </div>
</body>
</html>`;
}

/** Add a signer address to a namespace, avoiding duplicates */
function addSigner(signers: Record<string, string[]>, namespace: string, address: string) {
  if (!signers[namespace]) {
    signers[namespace] = [];
  }
  if (!signers[namespace].includes(address)) {
    signers[namespace].push(address);
  }
}
