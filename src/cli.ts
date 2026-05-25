import { AccountPool } from "./account-pool.js";
import { startApiServer } from "./api-server.js";
import { loadLatestSession, registerAndLogin, summarizeSession } from "./account.js";
import { closeBrowserSession, openBrowserSession, runPromptInBrowser } from "./browser.js";
import { formatError } from "./register.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  switch (command) {
    case "register":
    case "login": {
      const created = await registerAndLogin(console.log);
      console.log(summarizeSession(created.session));
      return;
    }

    case "explore": {
      const prompt = process.argv.slice(3).join(" ").trim() || "hello from codex";
      const session = await loadLatestSession();
      if (!session) {
        throw new Error("没有可复用会话，请先执行 login/register");
      }

      const browser = await openBrowserSession(session.accountDir, session.fingerprint);
      try {
        const result = await runPromptInBrowser(browser, session.finalUrl, prompt, console.log);
        console.log(
          JSON.stringify(
            {
              pageUrl: result.pageUrl,
              text: result.text,
              requests: result.requests,
              responses: result.responses,
              domSnapshot: result.domSnapshot,
            },
            null,
            2,
          ),
        );
      } finally {
        await closeBrowserSession(browser);
      }
      return;
    }

    case "serve": {
      await startApiServer(console.log);
      return;
    }

    case "pool-fill": {
      const size = Number.parseInt(process.argv[3] ?? process.env.POOL_SIZE ?? "3", 10);
      const pool = new AccountPool(console.log);
      await pool.ensureMinimumAccounts(size);
      const accounts = await pool.listAccounts();
      console.log(JSON.stringify(accounts, null, 2));
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
