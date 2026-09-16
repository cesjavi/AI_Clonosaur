/** Pure WebCrypto primitives for the web build's vault — the browser
 * equivalent of `src-tauri/src/vault.rs`'s `derive_key`/`encrypt_bytes`/
 * `decrypt_bytes`. Deliberately isolated from OPFS/SQLite/Worker concerns so
 * it can be unit tested directly (Node's `crypto.subtle` implements the same
 * WebCrypto API the browser does).
 *
 * Key derivation uses PBKDF2 instead of Argon2id (what the desktop vault
 * uses): WebCrypto has no native Argon2 implementation, and pulling in a
 * WASM Argon2 library for this one feature would add a new dependency and a
 * new, unverified attack/parsing surface. PBKDF2-SHA256 at a high iteration
 * count is a native, well-supported browser primitive that OWASP still rates
 * as an acceptable password-based KDF for this threat model (protecting a
 * local file, not an online-guessing target). */

const SALT_LEN = 16;
const NONCE_LEN = 12;
/** OWASP's 2023 minimum recommendation for PBKDF2-HMAC-SHA256. */
const PBKDF2_ITERATIONS = 600_000;

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomSalt(): Uint8Array {
  return randomBytes(SALT_LEN);
}

/** Derives a 256-bit AES-GCM key from a password + salt via PBKDF2-SHA256. */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `[12-byte random nonce][ciphertext || 16-byte GCM tag]` — same layout as
 * vault.rs's `encrypt_bytes`, so the two are conceptually interchangeable
 * even though they're never actually read by each other. A fresh random
 * nonce every call is required for AES-GCM: reusing one with the same key
 * breaks its security guarantees entirely. */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, plaintext as BufferSource),
  );
  const out = new Uint8Array(NONCE_LEN + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, NONCE_LEN);
  return out;
}

/** Wrong password and tampered/corrupted data both surface as the same
 * generic GCM authentication failure — by design, AES-GCM never
 * distinguishes the two, so neither do we. */
export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < NONCE_LEN) {
    throw new Error("el archivo cifrado es inválido o está corrupto");
  }
  const nonce = data.subarray(0, NONCE_LEN);
  const ciphertext = data.subarray(NONCE_LEN);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, ciphertext);
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("contraseña incorrecta");
  }
}
