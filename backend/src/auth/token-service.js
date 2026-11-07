const GitHubCredential = require("../models/github-credential.model");
const SelectedRepository = require("../models/selected-repository.model");
const { decryptToken, encryptToken } = require("../security/token-vault");
const { refreshUserToken, revokeGrant } = require("./github-client");

function authError(code, message = "Reconnect your GitHub account to continue.") {
  const error = new Error(message);
  error.status = 401;
  error.code = code;
  return error;
}

async function requireAccessToken(config, githubUserId) {
  const credential = await GitHubCredential.findOne({ singletonKey: "primary" })
    .select("+encryptedAccessToken +encryptedRefreshToken");
  if (!credential || credential.status !== "active" || credential.githubUserId !== githubUserId) {
    throw authError("GITHUB_REAUTH_REQUIRED");
  }

  const now = Date.now();
  if (credential.accessTokenExpiresAt?.getTime() > now + 60_000) {
    return decryptToken(credential.encryptedAccessToken, config.TOKEN_ENCRYPTION_KEY);
  }
  if (!credential.refreshTokenExpiresAt || credential.refreshTokenExpiresAt.getTime() <= now) {
    await invalidateCredential(credential);
    throw authError("GITHUB_REAUTH_REQUIRED");
  }

  const refreshToken = decryptToken(credential.encryptedRefreshToken, config.TOKEN_ENCRYPTION_KEY);
  try {
    const fresh = await refreshUserToken(config, refreshToken);
    const refreshedAt = new Date();
    credential.encryptedAccessToken = encryptToken(fresh.access_token, config.TOKEN_ENCRYPTION_KEY);
    credential.encryptedRefreshToken = encryptToken(fresh.refresh_token, config.TOKEN_ENCRYPTION_KEY);
    credential.accessTokenExpiresAt = new Date(refreshedAt.getTime() + fresh.expires_in * 1000);
    credential.refreshTokenExpiresAt = new Date(refreshedAt.getTime() + fresh.refresh_token_expires_in * 1000);
    await credential.save();
    return fresh.access_token;
  } catch (error) {
    if (error.code === "GITHUB_REAUTH_REQUIRED") {
      await invalidateCredential(credential);
      throw authError("GITHUB_REAUTH_REQUIRED");
    }
    throw error;
  }
}

async function invalidateCredential(credential, status = "reauthorization_required") {
  credential.status = status;
  credential.encryptedAccessToken = undefined;
  credential.encryptedRefreshToken = undefined;
  credential.accessTokenExpiresAt = undefined;
  credential.refreshTokenExpiresAt = undefined;
  await credential.save();
  await SelectedRepository.updateMany({ accessStatus: "active" }, { $set: { accessStatus: "reauthorization_required" } });
}

async function revokeConfiguredUser(config) {
  const credential = await GitHubCredential.findOne({ singletonKey: "primary" })
    .select("+encryptedAccessToken +encryptedRefreshToken");
  if (!credential) return false;
  if (credential.status !== "active") {
    await invalidateCredential(credential, "revoked");
    return false;
  }
  const accessToken = decryptToken(credential.encryptedAccessToken, config.TOKEN_ENCRYPTION_KEY);
  let revoked = false;
  try { revoked = await revokeGrant(config, accessToken); } catch { revoked = false; }
  await invalidateCredential(credential, "revoked");
  return revoked;
}

async function invalidateCurrentCredential() {
  const credential = await GitHubCredential.findOne({ singletonKey: "primary" }).select("+encryptedAccessToken +encryptedRefreshToken");
  if (credential && credential.status === "active") await invalidateCredential(credential);
}

module.exports = { invalidateCredential, invalidateCurrentCredential, requireAccessToken, revokeConfiguredUser };
