// ─── HYPERLIQUID PROXY ───────────────────────────────────────────────────────
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

// ── Replica esatta del Python SDK action_hash ─────────────────────────────────
// Il Python SDK usa msgpack.packb(action, use_bin_type=True)
// @msgpack/msgpack di default usa bin per i Buffer, str per le stringhe — ok
// Il problema può essere nei numeri: il Python SDK usa float_to_wire() che
// normalizza i float rimuovendo trailing zeros e converte in stringa.
// Ma per i campi dell'azione che sono già stringhe non c'è problema.
// Il vero problema: l'ordine dei campi nell'oggetto JS potrebbe variare.
// Soluzione: ricostruiamo l'oggetto action con ordine deterministico.

function normalizeAction(action) {
  if (action.type === 'order') {
    return {
      type: action.type,
      orders: action.orders.map(o => {
        const order = {
          a: o.a,
          b: o.b,
          p: o.p,
          s: o.s,
          r: o.r,
          t: o.t,
        };
        return order;
      }),
      grouping: action.grouping,
    };
  }
  if (action.type === 'cancel') {
    return {
      type: action.type,
      cancels: action.cancels.map(c => ({ a: c.a, o: c.o })),
    };
  }
  if (action.type === 'updateLeverage') {
    return {
      type: action.type,
      asset: action.asset,
      isCross: action.isCross,
      leverage: action.leverage,
    };
  }
  return action;
}

function buildActionHash(action, vaultAddress, nonce) {
  const normalized = normalizeAction(action);
  const actionBytes = Buffer.from(msgpack.encode(normalized));

  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce));

  let vaultBuf;
  if (!vaultAddress) {
    vaultBuf = Buffer.from([0x00]);
  } else {
    const addrHex = vaultAddress.toLowerCase().replace('0x', '');
    vaultBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(addrHex, 'hex')]);
  }

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

  const types = {
    Agent: [
      { name: 'source',       type: 'string'  },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  const value = { source: 'a', connectionId };

  const sig = await signer.signTypedData(domain, types, value);
  return ethers.Signature.from(sig);
}

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
