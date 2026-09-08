const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const CRYPTO_KEY_CACHE_MAX_ENTRIES = 4;
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function cachedCryptoKey(
  cache: Map<string, Promise<CryptoKey>>,
  secret: string,
  create: () => Promise<CryptoKey>,
) {
  const cached = cache.get(secret);
  if (cached) {
    return cached;
  }

  const pending = create().catch((error) => {
    cache.delete(secret);
    throw error;
  });
  cache.set(secret, pending);
  if (cache.size > CRYPTO_KEY_CACHE_MAX_ENTRIES) {
    const oldestSecret = cache.keys().next().value;
    if (oldestSecret !== undefined) {
      cache.delete(oldestSecret);
    }
  }
  return pending;
}

export function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeBase64UrlJson(value: unknown) {
  return bytesToBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));
}

export function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(TEXT_DECODER.decode(base64UrlToBytes(value))) as T;
}

export async function signPayload(payload: string, secret: string) {
  const key = await cachedCryptoKey(
    hmacKeyCache,
    secret,
    () => crypto.subtle.importKey(
      "raw",
      TEXT_ENCODER.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );
  const signature = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSignedValue(payload: unknown, secret: string) {
  const encodedPayload = encodeBase64UrlJson(payload);
  const signature = await signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifySignedValue<T>(value: string, secret: string): Promise<T | undefined> {
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    return undefined;
  }

  const expectedSignature = await signPayload(encodedPayload, secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return undefined;
  }

  try {
    return decodeBase64UrlJson<T>(encodedPayload);
  } catch {
    return undefined;
  }
}

export async function aesGcmKey(secret: string) {
  return cachedCryptoKey(
    aesKeyCache,
    secret,
    async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        TEXT_ENCODER.encode(`esa-mcp-worker token encryption:${secret}`),
      );
      return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    },
  );
}

export async function encryptText(value: string, secret: string) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesGcmKey(secret),
    TEXT_ENCODER.encode(value),
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptText(value: string, secret: string) {
  const [encodedIv, encodedCiphertext] = value.split(".");
  if (!encodedIv || !encodedCiphertext) {
    return undefined;
  }

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(encodedIv) },
      await aesGcmKey(secret),
      base64UrlToBytes(encodedCiphertext),
    );
    return TEXT_DECODER.decode(decrypted);
  } catch {
    return undefined;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = TEXT_ENCODER.encode(a);
  const bBytes = TEXT_ENCODER.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);

  for (let i = 0; i < length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }

  return diff === 0;
}
