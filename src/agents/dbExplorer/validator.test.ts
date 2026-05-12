import { validate, ValidationError } from "./validator";

const ok = (expr: string) => () => validate(expr);
const bad = (expr: string) => () => validate(expr);

describe("validator — accepted forms", () => {
  it("findOne with ObjectId", () => {
    expect(ok("db.users.findOne({_id: ObjectId('507f1f77bcf86cd799439011')})")).not.toThrow();
  });

  it("find with chain", () => {
    const r = validate("db.x.find({}).limit(5).sort({_id: -1}).toArray()");
    expect(r.rootOp).toBe("find");
    expect(r.chainOps).toEqual(["limit", "sort", "toArray"]);
    expect(r.limitArg?.value).toBe(5);
  });

  it("aggregate without lookup", () => {
    expect(ok("db.audiences.aggregate([{$match: {ok: true}}, {$group: {_id: '$type', n: {$sum: 1}}}])")).not.toThrow();
  });

  it("db.getCollection('x').find({})", () => {
    expect(ok("db.getCollection('users').find({})")).not.toThrow();
  });

  it("estimatedDocumentCount", () => {
    const r = validate("db.users.estimatedDocumentCount()");
    expect(r.rootOp).toBe("estimatedDocumentCount");
  });

  it("exposes argsAst", () => {
    const r = validate("db.users.find({a: 1})");
    expect(Array.isArray(r.argsAst)).toBe(true);
    expect(r.argsAst.length).toBe(1);
  });

  it("exposes chainOpsWithArgs", () => {
    const r = validate("db.x.find({}).limit(7)");
    expect(r.chainOpsWithArgs.find((c) => c.name === "limit")?.args.length).toBe(1);
  });
});

describe("validator — rejected: mutating root ops", () => {
  for (const op of ["drop", "insertOne", "updateOne", "deleteOne", "bulkWrite", "eval", "runCommand"]) {
    it(`rejects .${op}()`, () => {
      expect(bad(`db.x.${op}({})`)).toThrow(ValidationError);
    });
  }
});

describe("validator — rejected: computed access", () => {
  it("db[x].find() — not recognized as root call", () => {
    // db[x] has computed=true so isRootCall returns false; the chain walker
    // then sees .find() as a chain op (which it is not) and rejects it.
    expect(bad("db[x].find({})")).toThrow(ValidationError);
  });

  it("db.x[op]()", () => {
    expect(bad("db.x['find']({})")).toThrow(ValidationError);
  });
});

describe("validator — forbidden agg keys (depth 1, 2, 5)", () => {
  it("$where at depth 1 in aggregate", () => {
    expect(bad("db.x.aggregate([{$match: {$where: 'this.a==1'}}])")).toThrow(/forbidden key.*\$where/);
  });

  it("$function at depth 2", () => {
    expect(bad("db.x.aggregate([{$project: {y: {$function: {body: 'x', args: [], lang: 'js'}}}}])")).toThrow();
  });

  it("$accumulator deep nested in $facet", () => {
    expect(bad("db.x.aggregate([{$facet: {a: [{$group: {_id: null, n: {$accumulator: {init: '', accumulate: '', merge: '', lang: 'js'}}}}]}}])")).toThrow();
  });

  it("$unionWith blocked Phase 1", () => {
    expect(bad("db.x.aggregate([{$unionWith: {coll: 'y'}}])")).toThrow(/\$unionWith/);
  });

  it("$graphLookup blocked Phase 1", () => {
    expect(bad("db.x.aggregate([{$graphLookup: {from: 'y', startWith: '$a', connectFromField: 'a', connectToField: 'b', as: 'r'}}])")).toThrow();
  });

  it("$lookup blocked Phase 1", () => {
    expect(bad("db.x.aggregate([{$lookup: {from: 'y', localField: 'a', foreignField: 'b', as: 'r'}}])")).toThrow(/\$lookup/);
  });

  it("$out blocked", () => {
    expect(bad("db.x.aggregate([{$out: 'sink'}])")).toThrow();
  });

  it("$merge blocked", () => {
    expect(bad("db.x.aggregate([{$merge: {into: 'sink'}}])")).toThrow();
  });
});

describe("validator — PATCH 2: forbidden keys in find/findOne filters", () => {
  it("rejects top-level $where in find", () => {
    expect(bad("db.users.find({$where: 'this.a==1'})")).toThrow(/\$where/);
  });

  it("rejects $where nested in findOne filter", () => {
    expect(bad("db.users.findOne({a: 1, $or: [{$where: 'true'}]})")).toThrow(/\$where/);
  });
});

describe("validator — PATCH 3: reserved collections", () => {
  it("rejects system.users", () => {
    expect(bad("db.system.users.find({})")).toThrow(/not allowed|collection|reserved/);
  });

  it("rejects collection with $ via getCollection", () => {
    expect(bad("db.getCollection('$cmd').findOne({})")).toThrow(/not allowed/);
  });

  it("rejects system.indexes via getCollection", () => {
    expect(bad("db.getCollection('system.indexes').find({})")).toThrow(/not allowed/);
  });

  it("rejects bare 'system' collection via getCollection (regex tightened)", () => {
    expect(bad("db.getCollection('system').find({})")).toThrow(/not allowed/);
  });

  it("still accepts systemX (no dot or boundary match)", () => {
    expect(ok("db.systemX.find({}).limit(5)")).not.toThrow();
  });
});

describe("validator — PATCH (review): computed key rejected", () => {
  it("rejects [\"$out\"] computed key in aggregate stage", () => {
    // ESLint-style template-key bypass attempt.
    expect(bad("db.x.aggregate([{['$out']: 'sink'}])")).toThrow();
  });
});

describe("validator — PATCH (review): aggregate pipeline stages must be objects", () => {
  it("rejects null stage in pipeline", () => {
    expect(bad("db.x.aggregate([null, {$match: {a: 1}}])")).toThrow(/object literal/);
  });

  it("rejects array stage in pipeline", () => {
    expect(bad("db.x.aggregate([[1, 2]])")).toThrow(/object literal/);
  });
});

describe("validator — PATCH 4: .limit on incompatible ops", () => {
  for (const op of ["countDocuments", "distinct", "getIndexes", "stats", "findOne"]) {
    it(`rejects .${op}().limit()`, () => {
      // distinct takes a field arg
      const expr = op === "distinct"
        ? `db.x.distinct('f').limit(5)`
        : `db.x.${op}().limit(5)`;
      expect(bad(expr)).toThrow(/not supported on/);
    });
  }
});
