// ─── HYPERLIQUID PROXY ───────────────────────────────────────────────────────
// Deploy su Render (free tier) come gli altri proxy RiskFlow.
// Firma le richieste autenticate con EIP-712 usando ethers v6.
//
// Headers attesi dal frontend:
//   x-hl-key     → private key dell'API Wallet (hex, con o senza 0x)
//   x-hl-wallet  → indirizzo EVM pubblico dell'account principale (es. 0x...)
//
// Il proxy NON logga mai le chiavi. Le usa in-memory solo per la firma.
// ─────────────────────────────────────────────────────────────────────────────

import express   from 'express';
import cors      from 'cors';
import { ethers } from 'ethers';

const app  = express();
const PORT = process.env.PORT || 3000;

const HL_INFO     = 'https://api.hyperliquid.xyz/info';
const HL_EXCHANGE = 'https://api.hyperliquid.xyz/exchange';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Healthcheck ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ ok: true, service: 'hl-proxy' }));

// ── /info  — endpoint pubblico, solo relay (no auth) ────────────────────────
// Il frontend chiama direttamente api.hyperliquid.xyz/info senza CORS issues,
// ma offriamo comunque /info sul proxy per uniformità e eventuali IP issues.
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

// ── /exchange — endpoint autenticato, firma EIP-712 ──────────────────────────
// Il frontend manda il body dell'azione già formato (action + nonce + vaultAddress)
// e il proxy aggiunge la firma.
app.post('/exchange', async (req, res) => {
  const rawKey    = req.headers['x-hl-key']    || '';
  const walletAddr = req.headers['x-hl-wallet'] || '';

  if (!rawKey || !walletAddr) {
    return res.status(401).json({ error: 'Mancano x-hl-key o x-hl-wallet' });
  }

  try {
    const privateKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
    const signer     = new ethers.Wallet(privateKey);

    // Verifica che la chiave corrisponda al wallet dichiarato
    // (opzionale ma utile per debug — non blocca se wallet è subaccount)

    const { action, nonce, vaultAddress } = req.body;
    if (!action || nonce === undefined) {
      return res.status(400).json({ error: 'Body mancante: action, nonce richiesti' });
    }

    // ── EIP-712 signing ──────────────────────────────────────────────────────
    // Hyperliquid usa un dominio fisso e una struttura "Agent" per tutte le azioni
    // Ref: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing

    const domain = {
      name:              'Exchange',
      version:           '1',
      chainId:           1337,    // Hyperliquid L1 chain ID
      verifyingContract: '0x0000000000000000000000000000000000000000',
    };

    // Hyperliquid firma il payload come hash keccak256 del JSON dell'azione,
    // poi lo wrappa in un Agent EIP-712
    const actionHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(action))
    );

    const types = {
      Agent: [
        { name: 'source',      type: 'bytes32' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    };

    const value = {
      source:       ethers.zeroPadValue(ethers.toUtf8Bytes('a'), 32), // 'a' = mainnet
      connectionId: actionHash,
    };

    const signature = await signer.signTypedData(domain, types, value);
    const { r, s, v } = ethers.Signature.from(signature);

    const payload = {
      action,
      nonce,
      signature: { r, s, v },
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
    console.error('[hl-proxy] /exchange error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`hl-proxy listening on :${PORT}`));
