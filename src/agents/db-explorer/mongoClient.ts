import { MongoClient, type Db } from "mongodb";

let cached: { client: MongoClient; db: Db } | null = null;
let pending: Promise<{ client: MongoClient; db: Db }> | null = null;

const buildClient = (uri: string): MongoClient => {
  return new MongoClient(uri, {
    readPreference: "secondaryPreferred",
    readConcern: { level: "local" },
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    waitQueueTimeoutMS: 5_000,
    maxPoolSize: 5,
  });
};

export const getDb = async (): Promise<Db> => {
  if (cached) return cached.db;
  if (pending) return (await pending).db;

  const uri = process.env.LGM_MONGO_URI;
  if (!uri) {
    throw new Error("LGM_MONGO_URI env var is not set");
  }

  let client: MongoClient;
  try {
    client = buildClient(uri);
  } catch (e) {
    throw new Error(`Invalid LGM_MONGO_URI: ${(e as Error).message}`);
  }

  client.on("error", () => {
    cached = null;
    pending = null;
  });
  client.on("close", () => {
    cached = null;
    pending = null;
  });

  pending = (async () => {
    await client.connect();
    const db = client.db();
    if (!db.databaseName || db.databaseName === "admin" || db.databaseName === "test") {
      await client.close().catch(() => undefined);
      throw new Error(
        "LGM_MONGO_URI must include a non-admin default database name.",
      );
    }
    cached = { client, db };
    pending = null;
    return cached;
  })().catch((e) => {
    pending = null;
    throw e;
  });

  return (await pending).db;
};

// Test-only reset hook. Production code never calls this.
export const __resetForTests = (): void => {
  cached = null;
  pending = null;
};
