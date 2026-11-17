// src/services/auth/google.ts
import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  jwtVerify as verifyJwt,
} from "jose";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { UserModel } from "../../models/User.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleUserPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture?: string;
  nonce?: string;
}

export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const state = randomBytes(16).toString("base64url");

  return { verifier, challenge, nonce, state };
}

export async function buildAuthUrl(
  state: string,
  challenge: string,
  nonce: string,
): Promise<string> {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function createStateToken(
  state: string,
  nonce: string,
  verifier: string,
): Promise<string> {
  return new SignJWT({ state, nonce, verifier })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
}

export async function verifyStateToken(
  token: string,
): Promise<{ state: string; nonce: string; verifier: string }> {
  const { payload } = await verifyJwt(token, secret, { algorithms: ["HS256"] });
  return {
    state: payload.state as string,
    nonce: payload.nonce as string,
    verifier: payload.verifier as string,
  };
}

export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<string> {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status}`);
  }

  const data = await res.json();
  return data.id_token as string;
}

const JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<GoogleUserPayload> {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: "https://accounts.google.com",
    audience: env.GOOGLE_CLIENT_ID!,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Invalid nonce");
  }
  if (!payload.email_verified) {
    throw new Error("Email not verified by Google");
  }

  return payload as unknown as GoogleUserPayload;
}

export async function linkOrCreateUser(payload: GoogleUserPayload) {
  let user = await UserModel.findOne({ googleId: payload.sub });

  if (!user) {
    user = await UserModel.findOne({ email: payload.email });
    if (user) {
      user.googleId = payload.sub;
      if (!user.authProviders) user.authProviders = [];
      if (!user.authProviders.includes("google"))
        user.authProviders.push("google");
      if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
      await user.save();
    } else {
      user = await UserModel.create({
        email: payload.email,
        name: payload.name,
        googleId: payload.sub,
        avatarUrl: payload.picture,
        authProviders: ["google"],
        timezone: env.DEFAULT_TIMEZONE,
      });
    }
  }
  return user;
}
