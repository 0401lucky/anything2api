import assert from "node:assert/strict";
import test from "node:test";

import { buildCookieHeader, normalizeImportedCookies } from "../src/cookies.js";

test("normalizeImportedCookies accepts Cookie-Editor JSON", () => {
  const cookies = normalizeImportedCookies(JSON.stringify([
    {
      name: "lS_authToken",
      value: "token",
      domain: ".anything.com",
      path: "/",
      expirationDate: 1_999_999_999,
    },
  ]));

  assert.equal(cookies[0]?.name, "lS_authToken");
  assert.equal(cookies[0]?.expires, 1_999_999_999);
  assert.equal(buildCookieHeader(cookies), "lS_authToken=token");
});

test("normalizeImportedCookies accepts cookie header text", () => {
  const cookies = normalizeImportedCookies("foo=bar; lS_authToken=token");
  assert.equal(cookies.length, 2);
  assert.equal(buildCookieHeader(cookies), "foo=bar; lS_authToken=token");
});

test("normalizeImportedCookies accepts refresh_token", () => {
  const cookies = normalizeImportedCookies("foo=bar; refresh_token=token");
  assert.equal(cookies.length, 2);
  assert.equal(buildCookieHeader(cookies), "foo=bar; refresh_token=token");
});

test("normalizeImportedCookies requires a likely auth cookie", () => {
  assert.throws(() => normalizeImportedCookies("foo=bar"), /refresh_token/);
});
