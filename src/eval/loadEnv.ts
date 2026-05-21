// Dev local : charge le .env racine si présent (LGM_MONGO_URI,
// REPLY_MANAGER_BEDROCK_*, EVAL_DATABASE_URL…). En prod Heroku les config
// vars sont déjà dans l'environnement et dotenv (devDep) est pruné →
// le require échoue et on l'ignore. Importé EN PREMIER dans src/index.ts
// pour s'exécuter avant que src/eval/db.ts ne lise process.env.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config();
} catch {
  /* dotenv absent (prod) : no-op */
}

export {};
