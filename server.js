// ─── HYPERLIQUID PROXY ───────────────────────────────────────────────────────
// Headers attesi dal frontend:
//   x-hl-key    → private key dell'API Wallet (hex, 66 char con 0x)
//   x-hl-wallet → indirizzo EVM principale (main wallet)
//   x-hl-agent  → indirizzo API wallet agente
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

// ── Signing — replica esatta del Python SDK ufficiale ────────────────────────
// Ref: https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py
//
// action_hash(action, vault_address, nonce):
//   data = msgpack.packb(action)
//   data += nonce.to_bytes(8, "big")
//   data += b"\x00" se vault_address è None, else b"\x01" + address_bytes
//   return keccak256(data)

function buildActionHash(action, vaultAddress, nonce) {
  // 1. msgpack encode dell'action (solo l'action, senza nonce)
  const actionBytes = msgpack.encode(action);

  // 2. nonce come 8 bytes big-endian
  const nonceBuf = Buffer.alloc(8);
  // nonce è un timestamp ms — usa BigInt per i 64 bit
  nonceBuf.writeBigUInt64BE(BigInt(nonce));

  // 3. vault address bytes
  let vaultBuf;
  if (!vaultAddress) {
    vaultBuf = Buffer.from([0x00]);
  } else {
    const addrHex = vaultAddress.toLowerCase().replace('0x', '');
    vaultBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(addrHex, 'hex')]);
  }

  // 4. concatena e keccak256
  const data = Buffer.concat([actionBytes, nonceBuf, vaultBuf]);
  return ethers.keccak256(data);
}

async function signL1Action(signer, action, nonce, vaultAddress) {
  const connectionId = buildActionHash(action, vaultAddress, nonce);

  const domain = {
    name:              'Exchange',
    version:           '1',
    chainId:           1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };

  // IMPORTANTE: source è type "string" non "bytes32" — come nel Python SDK
  const types = {
    Agent: [
      { name: 'source',       type: 'string'  },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  const value = {
    source:       'a', // 'a' = mainnet, 'b' = testnet
    connectionId,
  };

  const sig = await signer.signTypedData(domain, types, value);
  return ethers.Signature.from(sig);
}

// ── /exchange ─────────────────────────────────────────────────────────────────
app.post('/exchange', async (req, res) => {
  const rawKey     = req.headers['x-hl-key']    || '';
  const mainWallet = req.headers['x-hl-wallet'] || '';

  if (!rawKey || !mainWallet) {
    return res.status(401).json({ error: 'Mancano x-hl-key o x-hl-wallet' });
  }

  try {
    const privateKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey;
    const signer     = new ethers.Wallet(privateKey);

    const { action, nonce, vaultAddress } = req.body;

    console.log('[debug] signer address:', signer.address);
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

    const text = await hlRes.text();
    console.log('[debug] HL response:', text);

    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }
    res.status(hlRes.status).json(data);

  } catch (e) {
    console.error('[hl-proxy] /exchange error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`hl-proxy listening on :${PORT}`));
