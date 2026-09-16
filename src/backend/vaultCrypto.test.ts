import { describe, expect, it } from "vitest";
import { decryptBytes, deriveKey, encryptBytes, randomSalt } from "./vaultCrypto";

describe("deriveKey + encryptBytes + decryptBytes", () => {
  it("round-trips plaintext through encrypt then decrypt", async () => {
    const salt = randomSalt();
    const key = await deriveKey("correct horse battery staple", salt);
    const plaintext = new TextEncoder().encode("hello vault");

    const encrypted = await encryptBytes(key, plaintext);
    const decrypted = await decryptBytes(key, encrypted);

    expect(new TextDecoder().decode(decrypted)).toBe("hello vault");
  });

  it("fails to decrypt with the wrong password", async () => {
    const salt = randomSalt();
    const rightKey = await deriveKey("right password", salt);
    const wrongKey = await deriveKey("wrong password", salt);
    const encrypted = await encryptBytes(rightKey, new TextEncoder().encode("secret data"));

    await expect(decryptBytes(wrongKey, encrypted)).rejects.toThrow("contraseña incorrecta");
  });

  it("fails to decrypt truncated or corrupt data", async () => {
    const key = await deriveKey("password", randomSalt());
    await expect(decryptBytes(key, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "el archivo cifrado es inválido o está corrupto",
    );
  });

  it("produces different ciphertext for the same plaintext on repeated calls", async () => {
    // Each call must use a fresh random nonce — reusing one with the same
    // key would break AES-GCM's security guarantees entirely.
    const key = await deriveKey("password", randomSalt());
    const plaintext = new TextEncoder().encode("same plaintext");
    const a = await encryptBytes(key, plaintext);
    const b = await encryptBytes(key, plaintext);
    expect(a).not.toEqual(b);
  });

  it("derives different keys from the same password with different salts", async () => {
    const keyA = await deriveKey("same password", randomSalt());
    const keyB = await deriveKey("same password", randomSalt());
    const plaintext = new TextEncoder().encode("data");
    const encrypted = await encryptBytes(keyA, plaintext);
    await expect(decryptBytes(keyB, encrypted)).rejects.toThrow("contraseña incorrecta");
  });
});
