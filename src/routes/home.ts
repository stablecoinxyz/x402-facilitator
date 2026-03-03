import { Request, Response } from 'express';

export function homePage(_req: Request, res: Response) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SBC x402 Facilitator</title>
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

    /* Ambient background glow */
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
      z-index: 0;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 0 24px;
      position: relative;
      z-index: 1;
    }

    /* --- Hero Section --- */
    .hero {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 32px;
    }

    .logo-container {
      position: relative;
      opacity: 0;
      animation: fadeUp 0.8s ease-out 0.2s forwards;
    }

    .logo-container svg {
      width: 80px;
      height: 80px;
      filter: drop-shadow(0 0 40px rgba(105,56,239,0.4));
    }

    .logo-ring {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 120px;
      height: 120px;
      border: 1px solid rgba(105,56,239,0.2);
      border-radius: 50%;
      animation: pulse-ring 3s ease-in-out infinite;
    }

    .logo-ring:nth-child(2) {
      width: 160px;
      height: 160px;
      animation-delay: 0.5s;
      border-color: rgba(105,56,239,0.1);
    }

    @keyframes pulse-ring {
      0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      50% { transform: translate(-50%, -50%) scale(1.1); opacity: 0.3; }
    }

    h1 {
      font-size: 2.8rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.1;
      opacity: 0;
      animation: fadeUp 0.8s ease-out 0.4s forwards;
    }

    h1 span {
      background: linear-gradient(135deg, #fff 0%, var(--purple-lighter) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .subtitle {
      font-size: 1.15rem;
      color: var(--text-muted);
      max-width: 480px;
      line-height: 1.6;
      opacity: 0;
      animation: fadeUp 0.8s ease-out 0.6s forwards;
    }

    .cta-group {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      justify-content: center;
      opacity: 0;
      animation: fadeUp 0.8s ease-out 0.8s forwards;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 14px 28px;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.2s ease;
    }

    .btn-primary {
      background: var(--purple);
      color: #fff;
      box-shadow: 0 0 24px rgba(105,56,239,0.3);
    }

    .btn-primary:hover {
      background: var(--purple-light);
      box-shadow: 0 0 40px rgba(105,56,239,0.5);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      backdrop-filter: blur(8px);
    }

    .btn-secondary:hover {
      border-color: rgba(105,56,239,0.4);
      background: rgba(105,56,239,0.08);
      transform: translateY(-1px);
    }

    .scroll-hint {
      position: absolute;
      bottom: 40px;
      opacity: 0;
      animation: fadeIn 1s ease-out 1.2s forwards;
    }

    .scroll-hint span {
      display: block;
      width: 2px;
      height: 24px;
      margin: 0 auto;
      background: var(--purple);
      border-radius: 2px;
      animation: scroll-bob 2s ease-in-out infinite;
    }

    @keyframes scroll-bob {
      0%, 100% { transform: translateY(0); opacity: 0.4; }
      50% { transform: translateY(8px); opacity: 1; }
    }

    /* --- Sections --- */
    section {
      padding: 100px 0;
    }

    .section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--purple-lighter);
      margin-bottom: 12px;
    }

    .section-heading {
      font-size: 1.8rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 48px;
    }

    /* --- Features --- */
    .features {
      display: grid;
      gap: 20px;
    }

    .feature-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      backdrop-filter: blur(8px);
      transition: all 0.3s ease;
    }

    .feature-card:hover {
      border-color: rgba(105,56,239,0.3);
      background: rgba(105,56,239,0.04);
      transform: translateY(-2px);
    }

    .feature-icon {
      font-size: 1.5rem;
      margin-bottom: 16px;
    }

    .feature-card h3 {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: #fff;
    }

    .feature-card p {
      font-size: 0.9rem;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* --- Endpoints --- */
    .endpoints {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .endpoint {
      display: flex;
      align-items: center;
      gap: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      backdrop-filter: blur(8px);
      transition: all 0.3s ease;
    }

    .endpoint:hover {
      border-color: rgba(105,56,239,0.3);
    }

    .method {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      min-width: 52px;
      text-align: center;
    }

    .method-get { background: rgba(34,197,94,0.12); color: #22c55e; }
    .method-post { background: rgba(59,130,246,0.12); color: #3b82f6; }

    .endpoint-path {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.9rem;
      color: #fff;
    }

    .endpoint-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-left: auto;
    }

    /* --- Networks --- */
    .networks {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }

    .network {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      backdrop-filter: blur(8px);
      transition: all 0.3s ease;
    }

    .network:hover {
      border-color: rgba(105,56,239,0.3);
      transform: translateY(-2px);
    }

    .network-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: #fff;
      margin-bottom: 4px;
    }

    .network-type {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    /* --- Footer --- */
    footer {
      border-top: 1px solid var(--border);
      padding: 40px 0;
      text-align: center;
    }

    footer p {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    footer a {
      color: var(--purple-lighter);
      text-decoration: none;
    }

    footer a:hover { text-decoration: underline; }

    /* --- Scroll Animations --- */
    .reveal {
      opacity: 0;
      transform: translateY(30px);
      transition: opacity 0.6s ease-out, transform 0.6s ease-out;
    }

    .reveal.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .reveal-delay-1 { transition-delay: 0.1s; }
    .reveal-delay-2 { transition-delay: 0.2s; }
    .reveal-delay-3 { transition-delay: 0.3s; }
    .reveal-delay-4 { transition-delay: 0.4s; }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* --- Flow Animation --- */
    .flow-wrap {
      position: relative;
      padding: 48px 0;
    }

    .flow-line {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--border);
      transform: translateX(-50%);
    }

    .flow-line::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 0%;
      background: linear-gradient(180deg, var(--purple), var(--purple-lighter));
      border-radius: 2px;
      transition: height 2s ease-out;
    }

    .flow-line.animate::after { height: 100%; }

    .flow-nodes {
      display: flex;
      justify-content: space-between;
      margin-bottom: 32px;
    }

    .flow-node {
      width: 120px;
      text-align: center;
    }

    .flow-node-icon {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.4rem;
      margin: 0 auto 8px;
      transition: all 0.4s ease;
    }

    .flow-node-icon.active {
      border-color: var(--purple);
      box-shadow: 0 0 20px rgba(105,56,239,0.3);
      background: rgba(105,56,239,0.1);
    }

    .flow-node-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .flow-steps {
      display: flex;
      flex-direction: column;
      gap: 0;
      position: relative;
    }

    .flow-step {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 16px 0;
      opacity: 0;
      transform: translateX(-20px);
      transition: all 0.5s ease-out;
    }

    .flow-step.from-right {
      transform: translateX(20px);
      flex-direction: row-reverse;
      text-align: right;
    }

    .flow-step.visible {
      opacity: 1;
      transform: translateX(0);
    }

    .flow-step-num {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--purple);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      flex-shrink: 0;
      box-shadow: 0 0 16px rgba(105,56,239,0.3);
    }

    .flow-step-content {
      flex: 1;
    }

    .flow-step-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #fff;
      margin-bottom: 2px;
    }

    .flow-step-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .flow-step-tag {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(105,56,239,0.1);
      color: var(--purple-lighter);
      display: inline-block;
      margin-top: 4px;
    }

    .flow-packet {
      position: absolute;
      width: 10px;
      height: 10px;
      background: var(--purple);
      border-radius: 50%;
      box-shadow: 0 0 12px var(--purple);
      opacity: 0;
      pointer-events: none;
    }

    @keyframes packetMove {
      0% { opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { opacity: 0; }
    }

    @media (max-width: 600px) {
      h1 { font-size: 2rem; }
      .section-heading { font-size: 1.4rem; }
      .endpoint { flex-wrap: wrap; gap: 8px; }
      .endpoint-desc { margin-left: 0; }
      .flow-node-label { font-size: 0.65rem; }
      .flow-step { gap: 12px; }
    }
  </style>
</head>
<body>

  <!-- Hero -->
  <div class="hero">
    <div class="logo-container">
      <div class="logo-ring"></div>
      <div class="logo-ring"></div>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 24C18.6274 24 24 18.6274 24 12C24 5.37267 18.6274 0.00012207 12 0.00012207C5.37258 0.00012207 0 5.37267 0 12C0 18.6274 5.37258 24 12 24Z" fill="#6938EF"/>
        <path d="M12 22.5C17.799 22.5 22.5 17.799 22.5 12.0001C22.5 6.2011 17.799 1.50012 12 1.50012C6.20101 1.50012 1.5 6.2011 1.5 12.0001C1.5 17.799 6.20101 22.5 12 22.5Z" fill="#8760F2"/>
        <path d="M12 21C16.9706 21 21 16.9706 21 12.0001C21 7.02953 16.9706 3.00012 12 3.00012C7.02944 3.00012 3 7.02953 3 12.0001C3 16.9706 7.02944 21 12 21Z" fill="#A588F5"/>
        <path d="M12 19.5C16.1421 19.5 19.5 16.1422 19.5 12.0001C19.5 7.85796 16.1421 4.50012 12 4.50012C7.85786 4.50012 4.5 7.85796 4.5 12.0001C4.5 16.1422 7.85786 19.5 12 19.5Z" fill="#C3AFF9"/>
        <path d="M12 18C15.3137 18 18 15.3138 18 12.0001C18 8.6864 15.3137 6.00012 12 6.00012C8.68629 6.00012 6 8.6864 6 12.0001C6 15.3138 8.68629 18 12 18Z" fill="#E1D7FC"/>
        <path d="M12 16.5001C14.4853 16.5001 16.5 14.4854 16.5 12.0001C16.5 9.51483 14.4853 7.50012 12 7.50012C9.51472 7.50012 7.5 9.51483 7.5 12.0001C7.5 14.4854 9.51472 16.5001 12 16.5001Z" fill="white"/>
        <path d="M12 15.0001C13.6569 15.0001 15 13.6569 15 12.0001C15 10.3433 13.6569 9.00012 12 9.00012C10.3431 9.00012 9 10.3433 9 12.0001C9 13.6569 10.3431 15.0001 12 15.0001Z" fill="#6938EF"/>
      </svg>
    </div>

    <h1><span>SBC x402 Facilitator</span></h1>

    <p class="subtitle">
      Payment facilitator for the x402 protocol. Verifies and settles
      stablecoin payments across EVM and Solana networks.
    </p>

    <div class="cta-group">
      <a href="https://docs.stablecoin.xyz" class="btn btn-primary" target="_blank" rel="noopener">
        Read the Docs
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l9.2-9.2M17 17V7H7"/></svg>
      </a>
      <a href="/supported" class="btn btn-secondary">
        View Capabilities
      </a>
    </div>

    <div class="scroll-hint"><span></span></div>
  </div>

  <!-- What it does -->
  <section>
    <div class="container">
      <div class="reveal">
        <p class="section-title">What it does</p>
        <h2 class="section-heading">Trustless payment verification &amp; settlement</h2>
      </div>

      <div class="features">
        <div class="feature-card reveal reveal-delay-1">
          <div class="feature-icon">&#x1f50d;</div>
          <h3>Payment Verification</h3>
          <p>Validates ERC-2612 permit signatures and Solana transfer instructions, ensuring payment authenticity before resource access is granted.</p>
        </div>
        <div class="feature-card reveal reveal-delay-2">
          <div class="feature-icon">&#x26a1;</div>
          <h3>On-Chain Settlement</h3>
          <p>Executes the actual token transfers on-chain after verification, moving funds from payer to resource server via permit-based transfers.</p>
        </div>
        <div class="feature-card reveal reveal-delay-3">
          <div class="feature-icon">&#x1f310;</div>
          <h3>Multi-Chain Support</h3>
          <p>Supports Base, Radius, and Solana networks across both mainnet and testnet environments with a unified API interface.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- x402 Payment Flow Animation -->
  <section>
    <div class="container">
      <div class="reveal">
        <p class="section-title">How it works</p>
        <h2 class="section-heading">The x402 payment flow</h2>
      </div>

      <div class="reveal flow-wrap" id="flow">
        <div class="flow-nodes">
          <div class="flow-node">
            <div class="flow-node-icon" id="node-agent">&#x1f916;</div>
            <div class="flow-node-label">Agent</div>
          </div>
          <div class="flow-node">
            <div class="flow-node-icon" id="node-server">&#x1f5a5;&#xfe0f;</div>
            <div class="flow-node-label">Resource Server</div>
          </div>
          <div class="flow-node">
            <div class="flow-node-icon" id="node-facilitator">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 24C18.6274 24 24 18.6274 24 12C24 5.37267 18.6274 0 12 0C5.37258 0 0 5.37267 0 12C0 18.6274 5.37258 24 12 24Z" fill="#6938EF"/><path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" fill="#A588F5"/><path d="M12 16.5C14.4853 16.5 16.5 14.4853 16.5 12C16.5 9.51472 14.4853 7.5 12 7.5C9.51472 7.5 7.5 9.51472 7.5 12C7.5 14.4853 9.51472 16.5 12 16.5Z" fill="white"/><path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" fill="#6938EF"/></svg>
            </div>
            <div class="flow-node-label">Facilitator</div>
          </div>
        </div>

        <div class="flow-steps" id="flow-steps">
          <div class="flow-step" data-step="1">
            <div class="flow-step-num">1</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Agent requests resource</div>
              <div class="flow-step-desc">Agent sends HTTP request to a paid API endpoint</div>
              <span class="flow-step-tag">GET /api/data</span>
            </div>
          </div>

          <div class="flow-step from-right" data-step="2">
            <div class="flow-step-num">2</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Server responds 402</div>
              <div class="flow-step-desc">Server returns payment requirements in the response header</div>
              <span class="flow-step-tag">HTTP 402 Payment Required</span>
            </div>
          </div>

          <div class="flow-step" data-step="3">
            <div class="flow-step-num">3</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Agent signs payment</div>
              <div class="flow-step-desc">Creates an ERC-2612 permit signature authorizing the transfer</div>
              <span class="flow-step-tag">X-PAYMENT header</span>
            </div>
          </div>

          <div class="flow-step from-right" data-step="4">
            <div class="flow-step-num">4</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Server forwards to Facilitator</div>
              <div class="flow-step-desc">Payment header is sent to the Facilitator for verification</div>
              <span class="flow-step-tag">POST /verify</span>
            </div>
          </div>

          <div class="flow-step" data-step="5">
            <div class="flow-step-num">5</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Facilitator verifies</div>
              <div class="flow-step-desc">Validates signature, amount, expiry, and on-chain balances</div>
              <span class="flow-step-tag">&#x2713; valid</span>
            </div>
          </div>

          <div class="flow-step from-right" data-step="6">
            <div class="flow-step-num">6</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Resource delivered</div>
              <div class="flow-step-desc">Server returns the paid content to the agent</div>
              <span class="flow-step-tag">HTTP 200 OK</span>
            </div>
          </div>

          <div class="flow-step" data-step="7">
            <div class="flow-step-num">7</div>
            <div class="flow-step-content">
              <div class="flow-step-title">Facilitator settles on-chain</div>
              <div class="flow-step-desc">Executes permitTransferFrom to move tokens from agent to server</div>
              <span class="flow-step-tag">POST /settle &rarr; tx hash</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- API Endpoints -->
  <section>
    <div class="container">
      <div class="reveal">
        <p class="section-title">API</p>
        <h2 class="section-heading">Endpoints</h2>
      </div>

      <div class="endpoints">
        <div class="endpoint reveal reveal-delay-1">
          <span class="method method-get">GET</span>
          <span class="endpoint-path">/supported</span>
          <span class="endpoint-desc">Capability discovery</span>
        </div>
        <div class="endpoint reveal reveal-delay-2">
          <span class="method method-post">POST</span>
          <span class="endpoint-path">/verify</span>
          <span class="endpoint-desc">Payment verification</span>
        </div>
        <div class="endpoint reveal reveal-delay-3">
          <span class="method method-post">POST</span>
          <span class="endpoint-path">/settle</span>
          <span class="endpoint-desc">Payment settlement</span>
        </div>
        <div class="endpoint reveal reveal-delay-4">
          <span class="method method-get">GET</span>
          <span class="endpoint-path">/health</span>
          <span class="endpoint-desc">Health check</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Networks -->
  <section>
    <div class="container">
      <div class="reveal">
        <p class="section-title">Networks</p>
        <h2 class="section-heading">Supported chains</h2>
      </div>

      <div class="networks">
        <div class="network reveal reveal-delay-1">
          <div class="network-name">Base</div>
          <div class="network-type">Mainnet &amp; Sepolia</div>
        </div>
        <div class="network reveal reveal-delay-2">
          <div class="network-name">Radius</div>
          <div class="network-type">Mainnet &amp; Testnet</div>
        </div>
        <div class="network reveal reveal-delay-3">
          <div class="network-name">Solana</div>
          <div class="network-type">Mainnet</div>
        </div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer>
    <div class="container">
      <p>
        Built by <a href="https://stablecoin.xyz" target="_blank" rel="noopener">Stablecoin</a>
        &nbsp;&middot;&nbsp;
        <a href="https://docs.stablecoin.xyz" target="_blank" rel="noopener">Documentation</a>
        &nbsp;&middot;&nbsp;
        <a href="/supported">API Capabilities</a>
      </p>
    </div>
  </footer>

  <script>
    // Intersection Observer for scroll animations
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

    // Flow step sequenced animation
    let flowStarted = false;
    const flowObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !flowStarted) {
          flowStarted = true;
          animateFlow();
        }
      });
    }, { threshold: 0.2 });

    const flowEl = document.getElementById('flow');
    if (flowEl) flowObserver.observe(flowEl);

    function animateFlow() {
      const steps = document.querySelectorAll('.flow-step');
      const nodes = ['node-agent', 'node-server', 'node-facilitator'];
      // Which nodes light up at each step
      const stepNodes = [
        [0],     // 1: agent
        [1],     // 2: server
        [0],     // 3: agent signs
        [1, 2],  // 4: server -> facilitator
        [2],     // 5: facilitator verifies
        [1, 0],  // 6: server -> agent
        [2],     // 7: facilitator settles
      ];

      steps.forEach((step, i) => {
        setTimeout(() => {
          step.classList.add('visible');
          // Clear previous active nodes
          nodes.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active');
          });
          // Activate current step's nodes
          if (stepNodes[i]) {
            stepNodes[i].forEach(nodeIdx => {
              const el = document.getElementById(nodes[nodeIdx]);
              if (el) el.classList.add('active');
            });
          }
        }, i * 600);
      });
    }
  </script>

</body>
</html>`);
}
