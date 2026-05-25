import { AccountPool } from "./account-pool.js";
import { startApiServer } from "./api-server.js";
import { formatError } from "./util/error.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  switch (command) {
    case "register":
    case "login":
    case "pool-fill":
      throw new Error("此命令将在 Task 13 重写。请直接跑 'serve'，账号通过控制台添加。");

    case "explore":
      throw new Error("explore 命令已废弃");

    case "serve": {
      await startApiServer(console.log);
      return;
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
