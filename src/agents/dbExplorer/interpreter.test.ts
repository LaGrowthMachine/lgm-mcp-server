import type { Db } from "mongodb";
import { Decimal128, Long, Binary, EJSON } from "bson";
import { runValidatedQuery } from "./interpreter";
import { validate } from "./validator";

const mockCollection = (overrides: Record<string, unknown> = {}) => ({
  find: jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([{ _id: "a" }]),
  }),
  findOne: jest.fn().mockResolvedValue({ _id: "a" }),
  countDocuments: jest.fn().mockResolvedValue(5),
  estimatedDocumentCount: jest.fn().mockResolvedValue(10),
  distinct: jest.fn().mockResolvedValue(["x", "y"]),
  indexes: jest.fn().mockResolvedValue([{ key: { _id: 1 } }]),
  aggregate: jest.fn().mockReturnValue({
    limit: jest.fn().mockReturnThis(),
    maxTimeMS: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([{ n: 1 }]),
  }),
  ...overrides,
});

const mockDb = (coll: ReturnType<typeof mockCollection>): Db =>
  ({
    collection: jest.fn().mockReturnValue(coll),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

describe("interpreter — happy paths", () => {
  it("find returns array", async () => {
    const coll = mockCollection();
    const v = validate("db.users.find({a: 1}).limit(5)");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    expect(coll.find).toHaveBeenCalled();
  });

  it("findOne returns single doc", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({_id: ObjectId('507f1f77bcf86cd799439011')})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ _id: "a" });
  });

  it("countDocuments returns scalar", async () => {
    const coll = mockCollection();
    const v = validate("db.users.countDocuments({a: 1})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toBe(5);
  });

  it("clamps .limit(1000) to 50", async () => {
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).limit(1000)");
    await runValidatedQuery(mockDb(coll), v);
    expect(cursor.limit).toHaveBeenLastCalledWith(50);
  });

  it("clamps .limit(0) to default 20", async () => {
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).limit(0)");
    await runValidatedQuery(mockDb(coll), v);
    expect(cursor.limit).toHaveBeenLastCalledWith(20);
  });

  it("clamps .limit(-5) to default 20", async () => {
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).limit(-5)");
    await runValidatedQuery(mockDb(coll), v);
    expect(cursor.limit).toHaveBeenLastCalledWith(20);
  });

  it("clamps .maxTimeMS(60_000) to 10_000", async () => {
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).maxTimeMS(60000).limit(5)");
    await runValidatedQuery(mockDb(coll), v);
    expect(cursor.maxTimeMS).toHaveBeenCalledWith(10_000);
  });
});

describe("interpreter — BSON helpers", () => {
  it("rejects ObjectId() with no args", async () => {
    const coll = mockCollection();
    // validator allows this — interpreter must catch
    const v = validate("db.users.findOne({_id: ObjectId()})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ObjectId/);
  });

  it("rejects invalid ObjectId hex", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({_id: ObjectId('not-a-hex')})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid ISODate", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({d: ISODate('not-a-date')})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid date/);
  });

  it("rejects ReDoS-sized regex literal", async () => {
    const coll = mockCollection();
    const longPattern = "a".repeat(201);
    const v = validate(`db.users.find({n: RegExp("${longPattern}", "i")}).limit(5)`);
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/anti-ReDoS/);
  });

  it("rejects RegExp with disallowed flag (g)", async () => {
    const coll = mockCollection();
    const v = validate(`db.users.find({n: RegExp("a", "g")}).limit(5)`);
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/flags/i);
  });

  it("rejects ObjectId() with non-string arg", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({_id: ObjectId(42)})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/string argument/);
  });

  it("rejects Timestamp() with non-object arg", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({ts: Timestamp(42)})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/object/);
  });

  it("rejects BinData with invalid base64 payload", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({b: BinData(0, 'not!!base64')})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/base64/);
  });

  it("rejects BinData with out-of-range subtype", async () => {
    const coll = mockCollection();
    const v = validate("db.users.findOne({b: BinData(999, 'aGVsbG8=')})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/byte/);
  });
});

describe("interpreter — EJSON trim", () => {
  it("preserves Decimal128 / Binary via EJSON roundtrip (relaxed mode collapses Long → number when safe)", async () => {
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([
        {
          dec: Decimal128.fromString("3.14"),
          big: Long.fromString("9007199254740993"),
          bin: new Binary(Buffer.from("aGVsbG8=", "base64"), 0),
        },
      ]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).limit(1)");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // EJSON relaxed: Decimal128 and Binary keep canonical $-form (no JS equivalent),
      // Long collapses to a JS number when safely representable.
      const s = EJSON.stringify(r.output);
      expect(s).toMatch(/\$numberDecimal/);
      expect(s).toMatch(/\$binary/);
    }
  });

  it("trims array doc-by-doc when cumulative > 50KB", async () => {
    const bigDoc = { pad: "x".repeat(30_000) };
    const cursor = {
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([bigDoc, bigDoc, bigDoc]),
    };
    const coll = mockCollection({ find: jest.fn().mockReturnValue(cursor) });
    const v = validate("db.users.find({}).limit(3)");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Array.isArray(r.output)).toBe(true);
      expect((r.output as unknown[]).length).toBeLessThan(3);
      expect(r.truncated).toBe(true);
    }
  });

  it("flags single doc > 50KB with dedicated message", async () => {
    const huge = { pad: "x".repeat(60_000) };
    const coll = mockCollection({
      findOne: jest.fn().mockResolvedValue(huge),
    });
    const v = validate("db.users.findOne({})");
    const r = await runValidatedQuery(mockDb(coll), v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toMatch(/exceeds 50KB/);
      expect(r.truncated).toBe(true);
    }
  });
});
