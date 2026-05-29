// bin/lgm-mongosh entry point. Mongosh-compatible CLI surface (`--eval "<expr>"`),
// but the underlying engine is the LGM validator + interpreter — same code that
// runs on Heroku. Output: EJSON relaxed on stdout. Errors: stderr + non-zero exit.

// Optional .env loader for local dev. Wrapped because dotenv is a devDep — on
// Heroku (production) it's absent and the catch keeps the CLI runnable there too.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // no-op: .env loading is local-dev only
}

import { EJSON } from "bson";
import { validate, ValidationError } from "../agents/db-explorer/validator";
import { runValidatedQuery } from "../agents/db-explorer/interpreter";
import { getDb } from "../agents/db-explorer/mongoClient";

const USAGE = [
  "Usage: lgm-mongosh --eval '<mongo expression>'",
  "  e.g. lgm-mongosh --eval 'db.users.countDocuments({})'",
  "",
  "Same validator + interpreter as the Heroku db-explorer agent.",
  "Requires LGM_MONGO_URI env var (readonly slave).",
].join("\n");

const parseExpr = (argv: string[]): string | null => {
  let expr: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return null;
    if (a === "--eval" || a === "-e") {
      expr = argv[++i] ?? null;
    } else if (a.startsWith("--eval=")) {
      expr = a.slice("--eval=".length);
    } else if (!a.startsWith("-") && expr === null) {
      expr = a;
    }
  }
  return expr;
};

const main = async (): Promise<void> => {
  const expr = parseExpr(process.argv.slice(2));
  if (!expr) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }

  let validation;
  try {
    validation = validate(expr);
  } catch (e) {
    if (e instanceof ValidationError) {
      process.stderr.write(`ValidationError: ${e.message}\n`);
      if (e.hint) process.stderr.write(`Hint: ${e.hint}\n`);
      process.exit(1);
    }
    throw e;
  }

  const db = await getDb();
  const result = await runValidatedQuery(db, validation);

  if (result.ok) {
    const ejson = EJSON.stringify(
      result.output as Parameters<typeof EJSON.stringify>[0],
      undefined,
      2,
      { relaxed: true },
    );
    process.stdout.write(`${ejson}\n`);
    if (result.truncated) {
      process.stderr.write("(truncated: output exceeded 100KB budget)\n");
    }
    process.exit(0);
  } else {
    process.stderr.write(`InterpreterError: ${result.error}\n`);
    if (result.hint) process.stderr.write(`Hint: ${result.hint}\n`);
    process.exit(1);
  }
};

main().catch((e) => {
  process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
