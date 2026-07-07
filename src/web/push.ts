import { WebAuthStore, type PushSubscriptionRow, type VapidKeysRow } from "./auth-store.ts";
import type { PushNotifier, PushPayload } from "../hooks.ts";

function b64url(data: ArrayBuffer | Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function makeVapidJwt(endpoint: string, vapidPrivateKeyB64: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = JSON.stringify({ alg: "ES256", typ: "JWT" });
  const payload = JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:agvsr@localhost",
  });
  const toSign = `${b64url(new TextEncoder().encode(header))}.${b64url(new TextEncoder().encode(payload))}`;
  const privKeyBytes = fromB64url(vapidPrivateKeyB64);
  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    privKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(toSign),
  );
  return `${toSign}.${b64url(sig)}`;
}

async function encryptPayload(
  payloadBytes: Uint8Array,
  subscription: PushSubscriptionRow,
): Promise<{ body: Uint8Array }> {
  const uaPublicRaw = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);

  // Server ephemeral ECDH key pair
  const serverEphemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const serverPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverEphemeral.publicKey),
  );

  // Import subscriber public key for ECDH
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH shared secret (32 bytes for P-256)
  const ecdhSecretBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    serverEphemeral.privateKey,
    256,
  );
  const ecdhSecret = new Uint8Array(ecdhSecretBits);

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"+ua_pub+as_pub, len=32)
  const ecdhKey = await crypto.subtle.importKey("raw", ecdhSecret, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\x00"),
    uaPublicRaw,
    serverPublicRaw,
  );
  const ikmBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo },
    ecdhKey,
    256,
  );
  const ikm = new Uint8Array(ikmBits);

  // Random salt for CEK/nonce derivation
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ikmKey = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);

  // CEK = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\0", len=16)
  const cekBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("Content-Encoding: aes128gcm\x00"),
    },
    ikmKey,
    128,
  );

  // Nonce = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\0", len=12)
  const nonceBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("Content-Encoding: nonce\x00"),
    },
    ikmKey,
    96,
  );

  const cekKey = await crypto.subtle.importKey("raw", cekBits, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);

  // Pad: content + 0x02 (last-record delimiter)
  const padded = concat(payloadBytes, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceBits }, cekKey, padded),
  );

  // Header: salt(16) + rs(4, big-endian=4096) + idlen(1=65) + as_public(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concat(salt, rs, new Uint8Array([65]), serverPublicRaw);

  return { body: concat(header, ciphertext) };
}

export async function sendPush(
  subscription: PushSubscriptionRow,
  vapidKeys: VapidKeysRow,
  payloadBytes: Uint8Array,
): Promise<{ pruneEndpoint: boolean }> {
  const { body } = await encryptPayload(payloadBytes, subscription);
  const jwt = await makeVapidJwt(subscription.endpoint, vapidKeys.privateKey);
  const authorization = `vapid t=${jwt}, k=${vapidKeys.publicKey}`;

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      Authorization: authorization,
      TTL: "86400",
    },
    body,
  });

  if (res.status === 404 || res.status === 410) {
    return { pruneEndpoint: true };
  }
  return { pruneEndpoint: false };
}

export function createPushNotifier(storeFile: string): PushNotifier {
  let store: WebAuthStore | null = null;

  function getStore(): WebAuthStore {
    if (!store) store = new WebAuthStore(storeFile);
    return store;
  }

  return (payload: PushPayload): void => {
    Promise.resolve()
      .then(async () => {
        const s = getStore();
        const vapidKeys = await s.getOrCreateVapidKeys();
        const subscriptions = s.listPushSubscriptions();
        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        for (const sub of subscriptions) {
          try {
            const result = await sendPush(sub, vapidKeys, payloadBytes);
            if (result.pruneEndpoint) {
              s.removePushSubscription(sub.endpoint);
            }
          } catch {
            // fire-and-forget: swallow per-subscription errors
          }
        }
      })
      .catch(() => {
        // fire-and-forget: swallow all errors
      });
  };
}

// Exported for testing only: derive CEK and nonce given subscriber key material.
export async function deriveEncryptionKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublicRaw: Uint8Array,
  serverPublicRaw: Uint8Array,
  salt: Uint8Array,
): Promise<{ cek: ArrayBuffer; nonce: ArrayBuffer }> {
  const ecdhKey = await crypto.subtle.importKey("raw", ecdhSecret, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info\x00"),
    uaPublicRaw,
    serverPublicRaw,
  );
  const ikmBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo },
    ecdhKey,
    256,
  );
  const ikmKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(ikmBits),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const cek = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("Content-Encoding: aes128gcm\x00"),
    },
    ikmKey,
    128,
  );
  const nonce = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: new TextEncoder().encode("Content-Encoding: nonce\x00"),
    },
    ikmKey,
    96,
  );
  return { cek, nonce };
}
