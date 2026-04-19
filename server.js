// ─── HYPERLIQUID PROXY ───────────────────────────────────────────────────────
// Deploy su Render (free tier) come gli altri proxy RiskFlow.
// Firma le richieste autenticate con EIP-712 usando ethers v6 + msgpack.
//
// Headers attesi dal frontend:
//   x-hl-key     → private key dell'API Wallet (hex, con o senza 0x)
//   x-hl-wallet  → indirizzo EVM pubblico dell'account principale (es. 0x...)
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

// ── Healthcheck ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, service: 'hl-proxy' }));

// ── /info — endpoint pubblico, solo relay ────────────────────────────────────
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

// ── Helpers firma EIP-712 ────────────────────────────────────────────────────
// Hyperliquid calcola l'actionHash con msgpack encoding dell'action,
// poi firma un Agent EIP-712 che contiene quell'hash come connectionId.
// Ref: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing

function actionHash(action, vaultAddress, nonce) {
  // Serializza action + nonce (+ vault se presente) con msgpack
  const data = vaultAddress
    ? { ...action, nonce, vaultAddress }
    : { ...action, nonce };

  const encoded = msgpack.encode(data, { forceIntegerToFloat: false, sortKeys: true });
  return ethers.keccak256(encoded);
}

async function signL1Action(signer, action, vaultAddress, nonce) {
  const hash = actionHash(action, vaultAddress, nonce);

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
    connectionId: hash,
  };

  const signature = await signer.signTypedData(domain, types, value);
  return ethers.Signature.from(signature);
}

// ── /exchange — endpoint autenticato ─────────────────────────────────────────
app.post('/exchange', async (req, res) => {
  const rawKey     = req.headers['x-hl-key']    || '';
  const walletAddr = req.headers['x-hl-wallet'] || '';

  if (!rawKey || !walletAddr) {
    return res.status(401).json({ error: 'Mancano x-hl-key o x-hl-wallet' });
  }

  try {
    const privateKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
    const signer     = new ethers.Wallet(privateKey);

    const { action, nonce, vaultAddress } = req.body;
    if (!action || nonce === undefined) {
      return res.status(400).json({ error: 'Body mancante: action e nonce richiesti' });
    }

    const sig = await signL1Action(signer, action, vaultAddress || null, nonce);

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
    res.status(hlRes.status).json(data);

  } catch (e) {
    console.error('[hl-proxy] /exchange error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`hl-proxy listening on :${PORT}`));
