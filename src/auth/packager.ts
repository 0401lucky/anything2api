import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";

export async function packAccount(sourceDir: string, archivePath: string): Promise<void> {
  await mkdir(path.dirname(archivePath), { recursive: true });
  const parent = path.dirname(sourceDir);
  const folder = path.basename(sourceDir);
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: parent,
      portable: true,
    },
    [folder],
  );
}

export async function unpackAccount(archivePath: string, targetParent?: string): Promise<string> {
  let dest: string;
  if (targetParent) {
    await mkdir(targetParent, { recursive: true });
    dest = targetParent;
  } else {
    dest = await mkdtemp(path.join(os.tmpdir(), "anything-account-"));
  }
  let firstEntry: string | undefined;

  await tar.x({
    gzip: true,
    file: archivePath,
    cwd: dest,
    strict: true,
    filter: (entryPath) => {
      const normalized = path.normalize(entryPath);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new Error(`非法 tar 路径: ${entryPath}`);
      }
      if (!firstEntry) firstEntry = entryPath.split(/[\\/]/)[0];
      return true;
    },
  });

  if (!firstEntry) throw new Error("归档为空");
  return path.join(dest, firstEntry);
}
