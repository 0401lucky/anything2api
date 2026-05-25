import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeQuotedPrintable,
  extractHtmlTitle,
  extractMagicLoginLink,
  generateEmailPrefix,
  isValidMagicLoginCandidate,
  looksLikeWelcomeMail,
  registerOne,
  type RegisterDependencies,
} from "../src/register.js";

test("decodeQuotedPrintable decodes soft wraps and escaped bytes", () => {
  const value = "https://www.anything.com/ls/click?token=3Dabc=\r\n123";
  assert.equal(decodeQuotedPrintable(value), "https://www.anything.com/ls/click?token=abc123");
});

test("extractMagicLoginLink prefers sign-in anchors", () => {
  const html = `
    <html>
      <body>
        <a href="https://www.anything.com/other">Other</a>
        <a href="https://www.anything.com/ls/click?token=abc">Sign in to Anything</a>
      </body>
    </html>
  `;

  assert.equal(extractMagicLoginLink(html), "https://www.anything.com/ls/click?token=abc");
});

test("extractMagicLoginLink falls back to raw quoted-printable urls", () => {
  const raw = "Click here: https://www.anything.com/ls/click?upn=3Dabc=\r\n123";
  assert.equal(extractMagicLoginLink(raw), "https://www.anything.com/ls/click?upn=abc123");
});

test("extractHtmlTitle extracts normalized title", () => {
  const html = "<title>\n  Sign up for an account  </title>";
  assert.equal(extractHtmlTitle(html), "Sign up for an account");
});

test("generateEmailPrefix returns lowercase letters and digits", () => {
  const prefix = generateEmailPrefix();
  assert.match(prefix, /^[a-z0-9]+$/);
  assert.ok(prefix.length >= 6);
});

test("registerOne uses the mailbox returned by the provider even when it differs from prefix", async () => {
  const logs: string[] = [];
  const persisted: unknown[] = [];

  const dependencies: RegisterDependencies = {
    async createTemporaryMailbox(prefix) {
      assert.ok(prefix);
      return {
        mail: "server-picked-random@razkord.top",
        key: "jwt-token",
      };
    },
    async signupAnything(email) {
      assert.equal(email, "server-picked-random@razkord.top");
      return {
        success: true,
        user: {
          id: "user-1",
        },
        projectGroup: {
          id: "pg-1",
        },
      };
    },
    async pollMagicLoginEmail(mailbox) {
      assert.equal(mailbox.mail, "server-picked-random@razkord.top");
      return {
        status: "received",
        subject: "Magic Login Link",
        raw: "<a href=\"https://www.anything.com/ls/click?token=abc\">Sign in</a>",
        headers: {
          subject: "Magic Login Link",
        },
        magicLink: "https://www.anything.com/ls/click?token=abc",
      };
    },
    async openMagicLinkDirect(magicLink) {
      assert.equal(magicLink, "https://www.anything.com/ls/click?token=abc");
      return {
        finalUrl: "https://www.anything.com/dashboard",
        title: "Anything Dashboard",
        redirectChain: ["https://www.anything.com/dashboard"],
      };
    },
    async appendRegisteredResult(record) {
      persisted.push(record);
    },
    log(message) {
      logs.push(message);
    },
  };

  const result = await registerOne(1, dependencies);

  assert.deepEqual(result, {
    email: "server-picked-random@razkord.top",
    user_id: "user-1",
    project_group_id: "pg-1",
    magic_link_subject: "Magic Login Link",
    final_url: "https://www.anything.com/dashboard",
    title: "Anything Dashboard",
  });
  assert.equal(persisted.length, 1);
  assert.ok(logs.some((message) => message.includes("临时邮箱创建成功: server-picked-random@razkord.top")));
});

test("isValidMagicLoginCandidate ignores unrelated newsletter links", () => {
  assert.equal(isValidMagicLoginCandidate("Welcome to Anything (1/7)", "https://app.loops.so/unsubscribe/abc"), false);
  assert.equal(
    isValidMagicLoginCandidate("Magic Login Link", "https://www.anything.com/ls/click?token=abc"),
    true,
  );
});

test("looksLikeWelcomeMail matches onboarding subjects", () => {
  assert.equal(looksLikeWelcomeMail("Welcome to Anything"), true);
  assert.equal(looksLikeWelcomeMail("Welcome to Anything (1/7)"), true);
  assert.equal(looksLikeWelcomeMail("Magic Login Link"), false);
});
