// Dev local : charge le .env racine (vars communes) et .env.local par-dessus
// (overrides par-machine non commités). En prod Heroku les config vars sont
// déjà dans l'environnement et dotenv (devDep) est pruné → le require échoue
// et on l'ignore. Importé EN PREMIER dans src/index.ts pour s'exécuter avant
// que src/eval/db.ts ne lise process.env.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv");
  // .env.local first with override=true — convention Vite/Next : override
  // les valeurs du .env partagé pour le poste local.
  dotenv.config({ path: ".env.local", override: true });
  dotenv.config({ path: ".env" });
} catch {
  /* dotenv absent (prod) : no-op */
}

export {};
