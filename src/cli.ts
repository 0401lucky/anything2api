import { AccountPool } from "./account-pool.js";
import { startApiServer } from "./api-server.js";
import { loginInteractive, summarizeSession, tryLoadSessionFromPath } from "./account.js";
import { packAccount, unpackAccount } from "./auth/packager.js";
import { formatError } from "./util/error.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  switch (command) {
    case "serve": {
      await startApiServer(console.log);
      return;
    }

    case "login": {
      const session = await loginInteractive({ log: console.log });
      console.log(summarizeSession(session));
      const pool = new AccountPool(console.log);
      await pool.addPreparedSession(session);
      return;
    }

    case "accounts": {
      const sub = process.argv[3] ?? "list";
      const pool = new AccountPool(console.log);

      if (sub === "list") {
        const accounts = await pool.listAccounts();
        console.log(JSON.stringify(accounts, null, 2));
        return;
      }

      if (sub === "remove") {
        const id = process.argv[4];
        if (!id) throw new Error("用法: accounts remove <accountId>");
        await pool.removeAccount(id);
        return;
      }

      if (sub === "reactivate") {
        const id = process.argv[4];
        if (!id) throw new Error("用法: accounts reactivate <accountId>");
        const result = await pool.reactivateAccount(id);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (sub === "export") {
        const id = process.argv[4];
        const out = process.argv[5];
        if (!id || !out) throw new Error("用法: accounts export <accountId> <out.tar.gz>");
        const accounts = await pool.listAccounts();
        const account = accounts.find((a) => a.accountId === id);
        if (!account) throw new Error(`未找到账号: ${id}`);
        await packAccount(account.accountDir, out);
        console.log(`已导出到 ${out}`);
        return;
      }

      if (sub === "import") {
        const archive = process.argv[4];
        if (!archive) throw new Error("用法: accounts import <archive.tar.gz>");
        const accountDir = await unpackAccount(archive);
        const sessionPath = `${accountDir}/session.json`;
        const session = await tryLoadSessionFromPath(sessionPath);
        await pool.addPreparedSession(session);
        console.log(`已导入: ${session.email} → ${accountDir}`);
        return;
      }

      throw new Error(`accounts 子命令未知: ${sub}`);
    }

    case "pool-status": {
      const pool = new AccountPool(console.log);
      const accounts = await pool.listAccounts();
      console.log(JSON.stringify(accounts, null, 2));
      return;
    }

    default:
      throw new Error(`未知命令: ${command}`);
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${formatError(error)}`);
  process.exitCode = 1;
});
