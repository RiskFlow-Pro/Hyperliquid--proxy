// ─── HYPERLIQUID PROXY ───────────────────────────────────────────────────────
// Headers attesi dal frontend:
//   x-hl-key    → private key dell'API Wallet (hex, 66 char con 0x)
//   x-hl-wallet → indirizzo EVM principale (main wallet)
//   x-hl-agent  → indirizzo API wallet agente (opzionale, per subaccount)
// ─────────────────────────────────────────────────────────────────────────────

import express    from 'express';
import cors       from 'cors';
import { ethers } from 'ethers';
import * as msgpack from '@msgpack/msgpack';

const app  = express();
const PORT = process.env.PORT || 3000;

const HL_INFO     = 'https://api.hyperliquid.xyz/info';
const HL_EXCHANGE = 'https://api.hyperliquid.xyz/exchange';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'hl-proxy' }));

app.post('/info', async (req, res) => {
  try {
    const r = await fetch(HL_INFO, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── EIP-712 signing ──────────────────────────────────────────────────────────
// Hyperliquid richiede:
// 1. msgpack encode di {action, nonce} → keccak256 → connectionId
// 2. EIP-712 sign di Agent{source, connectionId}
function buildActionHash(action, nonce, vaultAddress) {
  const obj = vaultAddress
    ? { ...action, nonce, vaultAddress }
    : { ...action, nonce };
  const encoded = msgpack.encode(obj, { sortKeys: true });
  return ethers.keccak256(encoded);
}

async function signL1Action(signer, action, nonce, vaultAddress) {
  const connectionId = buildActionHash(action, nonce, vaultAddress);

  const domain = {
    name:              'Exchange',
    version:           '1',
    chainId:           1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };

  const types = {
    Agent: [
      { name: 'source',       type: 'bytes32' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  const value = {
    source:       ethers.zeroPadValue(ethers.toUtf8Bytes('a'), 32), // 'a' = mainnet
    connectionId,
  };

  const sig = await signer.signTypedData(domain, types, value);
  return ethers.Signature.from(sig);
}

// ── /exchange ────────────────────────────────────────────────────────────────
app.post('/exchange', async (req, res) => {
  const rawKey     = req.headers['x-hl-key']    || '';
  const mainWallet = req.headers['x-hl-wallet'] || '';
  const agentWallet= req.headers['x-hl-agent']  || '';

  if (!rawKey || !mainWallet) {
    return res.status(401).json({ error: 'Mancano x-hl-key o x-hl-wallet' });
  }

  try {
    const privateKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
    const signer     = new ethers.Wallet(privateKey);

    const { action, nonce, vaultAddress } = req.body;

    console.log('[debug] key len:', rawKey.length, '| agent:', agentWallet || 'none');
    console.log('[debug] action:', JSON.stringify(action));
    console.log('[debug] nonce:', nonce);

    if (!action || nonce === undefined) {
      return res.status(400).json({ error: 'Body mancante: action e nonce richiesti' });
    }

    const sig = await signL1Action(signer, action, nonce, vaultAddress || null);

    const payload = {
      action,
      nonce,
      signature: { r: sig.r, s: sig.s, v: sig.v },
      ...(vaultAddress ? { vaultAddress } : {}),
    };

    const hlRes = await fetch(HL_EXCHANGE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await hlRes.json();
    console.log('[debug] HL response:', JSON.stringify(data));
    res.status(hlRes.status).json(data);

  } catch (e) {
    console.error('[hl-proxy] /exchange error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`hl-proxy listening on :${PORT}`));
