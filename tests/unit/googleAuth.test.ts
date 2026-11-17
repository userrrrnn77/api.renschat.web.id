// tests/unit/googleAuth.test.ts
import { describe, test, expect, mock } from "bun:test";
import {
  generatePkce,
  createStateToken,
  verifyStateToken,
  linkOrCreateUser,
} from "../../src/services/auth/google.js";
import { UserModel } from "../../src/models/User.js";

mock.module("../../src/models/User.js", () => ({
  UserModel: {
    findOne: mock(async () => null),
    create: mock(async (data) => ({
      ...data,
      _id: "mockid",
      save: async () => {},
    })),
  },
}));

describe("Google OAuth Service", () => {
  test("generatePkce returns valid lengths and formats", () => {
    const { verifier, challenge, nonce, state } = generatePkce();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(nonce).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("createStateToken and verifyStateToken work", async () => {
    const { verifier, nonce, state } = generatePkce();
    const token = await createStateToken(state, nonce, verifier);
    const parsed = await verifyStateToken(token);
    expect(parsed.state).toBe(state);
    expect(parsed.nonce).toBe(nonce);
    expect(parsed.verifier).toBe(verifier);
  });

  test("linkOrCreateUser creates new user if not exists", async () => {
    const payload = {
      sub: "g123",
      email: "a@b.com",
      email_verified: true,
      name: "A",
      picture: "pic.png",
    };
    const user = await linkOrCreateUser(payload);
    expect(user.email).toBe("a@b.com");
    expect(user.googleId).toBe("g123");
    expect(user.authProviders).toContain("google");
  });
});
