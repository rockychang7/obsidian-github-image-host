import assert from "node:assert/strict";
import test from "node:test";

import {
  RENEW_MARGIN_MS,
  canRenew,
  needsRenewal,
  refreshExpired,
  toTokenSet,
  type StoredTokens,
} from "../src/token.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function stored(over: Partial<StoredTokens> = {}): StoredTokens {
  return { token: "t", refreshToken: "", expiresAt: 0, refreshExpiresAt: 0, ...over };
}

// ---- toTokenSet ----

test("turns GitHub's relative lifetimes into absolute timestamps", () => {
  const set = toTokenSet(
    {
      access_token: "gho_abc",
      refresh_token: "ghr_def",
      expires_in: "28800",
      refresh_token_expires_in: "15897600",
    },
    NOW,
  );
  assert.equal(set.accessToken, "gho_abc");
  assert.equal(set.refreshToken, "ghr_def");
  assert.equal(set.expiresAt, NOW + 8 * HOUR);
  assert.equal(set.refreshExpiresAt, NOW + 15_897_600_000);
});

test("leaves the expiry undefined when the app issues non-expiring tokens", () => {
  const set = toTokenSet({ access_token: "gho_abc" }, NOW);
  assert.equal(set.expiresAt, undefined);
  assert.equal(set.refreshToken, undefined);
  assert.equal(set.refreshExpiresAt, undefined);
});

test("ignores lifetimes that are absent, zero or unparseable", () => {
  for (const value of ["", "0", "-1", "nonsense"]) {
    assert.equal(toTokenSet({ access_token: "a", expires_in: value }, NOW).expiresAt, undefined);
  }
});

// ---- needsRenewal ----

test("a token with no recorded expiry never needs renewal", () => {
  // Zero must read as "no expiry known", not as a 1970 timestamp — otherwise
  // every pasted token looks permanently expired and renewal loops forever.
  assert.equal(needsRenewal(stored({ expiresAt: 0 }), NOW), false);
  assert.equal(needsRenewal(stored({ expiresAt: 0 }), NOW + 100 * HOUR), false);
});

test("renews only once the margin is reached", () => {
  const t = stored({ expiresAt: NOW + 8 * HOUR });
  assert.equal(needsRenewal(t, NOW), false);
  assert.equal(needsRenewal(t, NOW + 8 * HOUR - RENEW_MARGIN_MS - 1000), false);
  assert.equal(needsRenewal(t, NOW + 8 * HOUR - RENEW_MARGIN_MS + 1000), true);
});

test("an already expired token needs renewal", () => {
  assert.equal(needsRenewal(stored({ expiresAt: NOW - HOUR }), NOW), true);
});

test("no token means nothing to renew", () => {
  assert.equal(needsRenewal(stored({ token: "", expiresAt: NOW - HOUR }), NOW), false);
});

// ---- refreshExpired / canRenew ----

test("a refresh token with no recorded expiry is not treated as dead", () => {
  assert.equal(refreshExpired(stored({ refreshExpiresAt: 0 }), NOW), false);
});

test("a refresh token past its six months is dead", () => {
  assert.equal(refreshExpired(stored({ refreshExpiresAt: NOW - 1000 }), NOW), true);
  assert.equal(refreshExpired(stored({ refreshExpiresAt: NOW + 1000 }), NOW), false);
});

test("renewal is possible only with a live refresh token", () => {
  assert.equal(canRenew(stored({ refreshToken: "" }), NOW), false);
  assert.equal(canRenew(stored({ refreshToken: "r" }), NOW), true);
  assert.equal(
    canRenew(stored({ refreshToken: "r", refreshExpiresAt: NOW - 1 }), NOW),
    false,
  );
});

// ---- the two real-world configurations ----

test("expiring-token app: fresh credentials are usable and renewable", () => {
  const set = toTokenSet(
    {
      access_token: "a",
      refresh_token: "r",
      expires_in: "28800",
      refresh_token_expires_in: "15897600",
    },
    NOW,
  );
  const t = stored({
    token: set.accessToken,
    refreshToken: set.refreshToken ?? "",
    expiresAt: set.expiresAt ?? 0,
    refreshExpiresAt: set.refreshExpiresAt ?? 0,
  });

  assert.equal(needsRenewal(t, NOW), false, "usable immediately");
  assert.equal(needsRenewal(t, NOW + 8 * HOUR), true, "renews after eight hours");
  assert.equal(canRenew(t, NOW + 8 * HOUR), true, "and can actually do it");
  assert.equal(canRenew(t, NOW + 200 * 24 * HOUR), false, "until the refresh token lapses");
});

test("pasted token: usable forever, never renewable", () => {
  const t = stored({ token: "github_pat_x" });
  assert.equal(needsRenewal(t, NOW + 1000 * HOUR), false);
  assert.equal(canRenew(t, NOW), false);
});
