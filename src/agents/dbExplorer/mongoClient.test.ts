import { __resetForTests, getDb } from "./mongoClient";

const connectMock = jest.fn();
const closeMock = jest.fn();
const onMock = jest.fn();
const dbMock = jest.fn();

jest.mock("mongodb", () => {
  return {
    MongoClient: jest.fn().mockImplementation(() => ({
      connect: connectMock,
      close: closeMock,
      on: onMock,
      db: dbMock,
    })),
  };
});

describe("mongoClient", () => {
  beforeEach(() => {
    __resetForTests();
    connectMock.mockReset();
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    onMock.mockReset();
    dbMock.mockReset();
    delete process.env.LGM_MONGO_URI;
  });

  it("throws when LGM_MONGO_URI is missing", async () => {
    await expect(getDb()).rejects.toThrow(/LGM_MONGO_URI/);
  });

  it("throws when default database name is missing", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017";
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ databaseName: "" });
    await expect(getDb()).rejects.toThrow(/non-admin default database name/);
  });

  it("throws when default db is 'admin'", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017/admin";
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ databaseName: "admin" });
    await expect(getDb()).rejects.toThrow(/non-admin/);
  });

  it("throws when default db is 'test'", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017/test";
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ databaseName: "test" });
    await expect(getDb()).rejects.toThrow(/non-admin/);
  });

  it("succeeds with a valid db name", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017/lgm";
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ databaseName: "lgm" });
    const db = await getDb();
    expect(db).toEqual({ databaseName: "lgm" });
  });

  it("coalesces 10 concurrent getDb() into a single connect()", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017/lgm";
    let resolveConnect: () => void = () => {};
    connectMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolveConnect = resolve; }),
    );
    dbMock.mockReturnValue({ databaseName: "lgm" });

    const promises = Array.from({ length: 10 }, () => getDb());
    resolveConnect();
    await Promise.all(promises);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("caches db across sequential calls", async () => {
    process.env.LGM_MONGO_URI = "mongodb://localhost:27017/lgm";
    connectMock.mockResolvedValue(undefined);
    dbMock.mockReturnValue({ databaseName: "lgm" });
    await getDb();
    await getDb();
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
