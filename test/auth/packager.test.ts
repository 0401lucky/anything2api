import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { packAccount, unpackAccount } from "../../src/auth/packager.js";

test("packAccount + unpackAccount roundtrips a directory", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pkg-"));
  try {
    const src = path.join(work, "acct-source");
    await mkdir(path.join(src, "user-data"), { recursive: true });
    await writeFile(path.join(src, "session.json"), JSON.stringify({ email: "a@b.c" }), "utf8");
    await writeFile(path.join(src, "user-data", "Cookies"), "binary-blob", "utf8");

    const archive = path.join(work, "acct.tar.gz");
    await packAccount(src, archive);

    const stat = await readFile(archive);
    assert.ok(stat.length > 0);

    const restored = await unpackAccount(archive, path.join(work, "restored"));
    const session = JSON.parse(await readFile(path.join(restored, "session.json"), "utf8"));
    assert.equal(session.email, "a@b.c");
    const cookies = await readFile(path.join(restored, "user-data", "Cookies"), "utf8");
    assert.equal(cookies, "binary-blob");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("unpackAccount rejects entries with parent paths", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pkg-evil-"));
  try {
    const archive = path.join(work, "ok.tar.gz");
    const tar = await import("tar");
    const src = path.join(work, "src");
    await mkdir(path.join(src, "inner"), { recursive: true });
    await writeFile(path.join(src, "inner", "ok.txt"), "x", "utf8");
    await tar.c({ gzip: true, file: archive, cwd: src, portable: true }, ["inner"]);

    const restored = await unpackAccount(archive, path.join(work, "out"));
    const restoredContent = await readFile(path.join(restored, "ok.txt"), "utf8");
    assert.equal(restoredContent, "x");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
