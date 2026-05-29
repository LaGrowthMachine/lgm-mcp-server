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

  it("find without explicit .limit() is allowed (interpreter clamps)", () => {
    expect(ok("db.users.find({email: 'a@b.c'})")).not.toThrow();
  });

  it("find on user-scoped collection without tenant key is allowed (doctrine guides)", () => {
    expect(ok("db.leads.find({deleted: false})")).not.toThrow();
  });

  it("find on fat collection without projection is allowed (doctrine guides)", () => {
    expect(ok("db.leads.find({userId: ObjectId('507f1f77bcf86cd799439011')}).limit(5)")).not.toThrow();
  });

  it("aggregate with $match + $group", () => {
    expect(ok("db.audiences.aggregate([{$match: {type: 'csv'}}, {$group: {_id: '$type', n: {$sum: 1}}}])")).not.toThrow();
  });

  it("aggregate with $lookup is allowed (DB readonly enforces safety)", () => {
    expect(ok("db.users.aggregate([{$lookup: {from: 'identities', localField: '_id', foreignField: 'userId', as: 'ids'}}])")).not.toThrow();
  });

  it("aggregate with $out is allowed at validator level (DB readonly refuses the write)", () => {
    expect(ok("db.x.aggregate([{$out: 'sink'}])")).not.toThrow();
  });

  it("db.getCollection('x').find({})", () => {
    expect(ok("db.getCollection('users').find({}).limit(5)")).not.toThrow();
  });

  it("estimatedDocumentCount", () => {
    const r = validate("db.users.estimatedDocumentCount()");
    expect(r.rootOp).toBe("estimatedDocumentCount");
  });

  it("exposes argsAst", () => {
    const r = validate("db.users.find({a: 1}).limit(10)");
    expect(Array.isArray(r.argsAst)).toBe(true);
    expect(r.argsAst.length).toBe(1);
  });

  it("exposes chainOpsWithArgs", () => {
    const r = validate("db.x.find({}).limit(7)");
    expect(r.chainOpsWithArgs.find((c) => c.name === "limit")?.args.length).toBe(1);
  });
});

describe("validator — rejected: ops outside the read-only allowlist", () => {
  for (const op of ["drop", "insertOne", "updateOne", "deleteOne", "bulkWrite", "eval", "runCommand"]) {
    it(`rejects .${op}() via ROOT_OPS allowlist`, () => {
      expect(bad(`db.x.${op}({})`)).toThrow(ValidationError);
    });
  }
});

describe("validator — rejected: computed access", () => {
  it("db[x].find() — not recognized as root call", () => {
    expect(bad("db[x].find({})")).toThrow(ValidationError);
  });

  it("db.x[op]()", () => {
    expect(bad("db.x['find']({})")).toThrow(ValidationError);
  });
});

describe("validator — forbidden JS-exec keys (depth 1, 2, 5)", () => {
  it("$where at depth 1 in aggregate", () => {
    expect(bad("db.x.aggregate([{$match: {$where: 'this.a==1'}}])")).toThrow(/forbidden key.*\$where/);
  });

  it("$function at depth 2", () => {
    expect(bad("db.x.aggregate([{$project: {y: {$function: {body: 'x', args: [], lang: 'js'}}}}])")).toThrow();
  });

  it("$accumulator deep nested in $facet", () => {
    expect(bad("db.x.aggregate([{$facet: {a: [{$group: {_id: null, n: {$accumulator: {init: '', accumulate: '', merge: '', lang: 'js'}}}}]}}])")).toThrow();
  });
});

describe("validator — forbidden JS-exec keys in find/findOne filters", () => {
  it("rejects top-level $where in find", () => {
    expect(bad("db.users.find({$where: 'this.a==1'})")).toThrow(/\$where/);
  });

  it("rejects $where nested in findOne filter", () => {
    expect(bad("db.users.findOne({a: 1, $or: [{$where: 'true'}]})")).toThrow(/\$where/);
  });
});

describe("validator — reserved collections", () => {
  it("rejects system.users", () => {
    expect(bad("db.system.users.find({})")).toThrow(/not allowed|collection|reserved/);
  });

  it("rejects collection with $ via getCollection", () => {
    expect(bad("db.getCollection('$cmd').findOne({})")).toThrow(/not allowed/);
  });

  it("rejects system.indexes via getCollection", () => {
    expect(bad("db.getCollection('system.indexes').find({})")).toThrow(/not allowed/);
  });

  it("rejects bare 'system' collection via getCollection", () => {
    expect(bad("db.getCollection('system').find({})")).toThrow(/not allowed/);
  });

  it("still accepts systemX (no dot or boundary match)", () => {
    expect(ok("db.systemX.find({}).limit(5)")).not.toThrow();
  });
});

describe("validator — computed key bypass", () => {
  it('rejects ["$where"] computed key in aggregate stage', () => {
    expect(bad("db.x.aggregate([{['$where']: 'true'}])")).toThrow();
  });
});

describe("validator — aggregate pipeline stages must be objects", () => {
  it("rejects null stage in pipeline", () => {
    expect(bad("db.x.aggregate([null, {$match: {a: 1}}])")).toThrow(/object literal/);
  });

  it("rejects array stage in pipeline", () => {
    expect(bad("db.x.aggregate([[1, 2]])")).toThrow(/object literal/);
  });
});

describe("validator — .limit on incompatible ops", () => {
  for (const op of ["countDocuments", "distinct", "getIndexes", "stats", "findOne"]) {
    it(`rejects .${op}().limit()`, () => {
      const expr = op === "distinct"
        ? `db.x.distinct('f').limit(5)`
        : `db.x.${op}().limit(5)`;
      expect(bad(expr)).toThrow(/not supported on/);
    });
  }
});

describe("validator — aggregate pipeline stage cap", () => {
  it("accepts aggregate with 10 stages", () => {
    const stages = Array.from({length: 9}, () => "{$project: {a: 1}}").join(", ");
    const expr = `db.audiences.aggregate([{$match: {type: 'csv'}}, ${stages}])`;
    expect(ok(expr)).not.toThrow();
  });

  it("rejects aggregate with 11 stages", () => {
    const stages = Array.from({length: 10}, () => "{$project: {a: 1}}").join(", ");
    const expr = `db.audiences.aggregate([{$match: {type: 'csv'}}, ${stages}])`;
    expect(bad(expr)).toThrow(/exceeds 10 stages/);
  });
});
