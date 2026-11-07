const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

function keyFromHex(keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || "")) throw new Error("Token encryption key must be 32 bytes encoded as 64 hexadecimal characters.");
  return Buffer.from(keyHex, "hex");
}

function encryptToken(plaintext, keyHex) {
  if (typeof plaintext !== "string" || !plaintext) throw new Error("Token value is required.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromHex(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptToken(encoded, keyHex) {
  const [version, ivText, tagText, ciphertextText, ...extra] = String(encoded || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText || extra.length) throw new Error("Encrypted token has an unsupported format.");
  const decipher = createDecipheriv("aes-256-gcm", keyFromHex(keyHex), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

module.exports = { decryptToken, encryptToken };
