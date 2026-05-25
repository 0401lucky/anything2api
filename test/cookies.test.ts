import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCookieHeader,
  findCookieValue,
  mergeCookies,
  normalizeImportedCookies,
  parseSetCookieHeaders,
} from "../src/cookies.js";

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

test("findCookieValue returns the exact cookie value", () => {
  const cookies = normalizeImportedCookies("refresh_token=refresh; lS_authToken=auth");
  assert.equal(findCookieValue(cookies, "lS_authToken"), "auth");
  assert.equal(findCookieValue(cookies, "missing"), null);
});

test("parseSetCookieHeaders parses combined Set-Cookie values", () => {
  const cookies = parseSetCookieHeaders([
    "lS_authToken=auth; Path=/; Domain=www.anything.com; HttpOnly; Secure; SameSite=Lax, refresh_token=refresh; Path=/; Secure",
  ]);

  assert.equal(cookies.length, 2);
  assert.equal(cookies[0]?.name, "lS_authToken");
  assert.equal(cookies[0]?.domain, "www.anything.com");
  assert.equal(cookies[0]?.httpOnly, true);
  assert.equal(cookies[1]?.name, "refresh_token");
});

test("mergeCookies replaces cookies by domain path and name", () => {
  const base = normalizeImportedCookies("refresh_token=old; lS_authToken=auth");
  const merged = mergeCookies(base, [{ name: "refresh_token", value: "new", domain: "www.anything.com", path: "/" }]);

  assert.equal(findCookieValue(merged, "refresh_token"), "new");
  assert.equal(findCookieValue(merged, "lS_authToken"), "auth");
  assert.equal(buildCookieHeader(merged).match(/refresh_token=/g)?.length, 1);
});

test("normalizeImportedCookies requires a likely auth cookie", () => {
  assert.throws(() => normalizeImportedCookies("foo=bar"), /refresh_token/);
});
