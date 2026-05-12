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
    expect(ok("db.audiences.aggregate([{$match: {userId: ObjectId('507f1f77bcf86cd799439011')}}, {$group: {_id: '$type', n: {$sum: 1}}}])")).not.toThrow();
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

describe("validator — PATCH 6: tenant filter required on user-scoped collections", () => {
  it("accepts find with userId on leads", () => {
    expect(ok("db.leads.find({userId: ObjectId('507f1f77bcf86cd799439011')}).project({_id: 1}).limit(10)")).not.toThrow();
  });

  it("accepts find with identityId on actions", () => {
    expect(ok("db.actions.find({identityId: ObjectId('507f1f77bcf86cd799439011')}).limit(10)")).not.toThrow();
  });

  it("accepts find with memberId on identities", () => {
    expect(ok("db.identities.find({memberId: ObjectId('507f1f77bcf86cd799439011')}).limit(10)")).not.toThrow();
  });

  it("rejects find on leads without tenant key", () => {
    expect(bad("db.leads.find({deleted: false}, {_id: 1}).limit(10)")).toThrow(/tenant filter required.*leads/);
  });

  it("rejects findOne on campaigns without tenant key", () => {
    expect(bad("db.campaigns.findOne({name: 'x'})")).toThrow(/tenant filter required.*campaigns/);
  });

  it("rejects aggregate on campaigns whose first $match has no tenant key", () => {
    expect(bad("db.campaigns.aggregate([{$match: {deleted: false}}, {$group: {_id: '$status', n: {$sum: 1}}}])")).toThrow(/tenant filter required.*campaigns/);
  });

  it("rejects aggregate on audiences whose first stage is not $match", () => {
    expect(bad("db.audiences.aggregate([{$group: {_id: '$type', n: {$sum: 1}}}])")).toThrow(/tenant filter required.*audiences/);
  });

  it("accepts aggregate on inboxConversations with tenant key in first $match", () => {
    expect(ok("db.inboxConversations.aggregate([{$match: {userId: ObjectId('507f1f77bcf86cd799439011')}}, {$group: {_id: '$status', n: {$sum: 1}}}])")).not.toThrow();
  });

  it("rejects distinct on logs without tenant key in filter", () => {
    expect(bad("db.logs.distinct('type')")).toThrow(/tenant filter required.*logs/);
  });

  it("accepts distinct on logs with tenant key", () => {
    expect(ok("db.logs.distinct('type', {identityId: ObjectId('507f1f77bcf86cd799439011')})")).not.toThrow();
  });

  it("rejects tenant only nested under $or (no top-level key)", () => {
    expect(bad("db.leads.find({$or: [{userId: ObjectId('507f1f77bcf86cd799439011')}, {userId: ObjectId('507f1f77bcf86cd799439012')}]}, {_id: 1}).limit(10)")).toThrow(/tenant filter required/);
  });
});

describe("validator — PATCH 7: explicit .limit() on find", () => {
  it("rejects find without .limit()", () => {
    expect(bad("db.users.find({email: 'a@b.c'})")).toThrow(/explicit \.limit/);
  });

  it("accepts find with .limit()", () => {
    expect(ok("db.users.find({email: 'a@b.c'}).limit(10)")).not.toThrow();
  });

  it("does not affect findOne", () => {
    expect(ok("db.users.findOne({email: 'a@b.c'})")).not.toThrow();
  });

  it("does not affect aggregate", () => {
    expect(ok("db.users.aggregate([{$match: {email: 'a@b.c'}}])")).not.toThrow();
  });
});

describe("validator — PATCH 8: projection required on fat find", () => {
  it("accepts find on leads with .project()", () => {
    expect(ok("db.leads.find({userId: ObjectId('507f1f77bcf86cd799439011')}).project({_id: 1, firstname: 1}).limit(10)")).not.toThrow();
  });

  it("accepts find on inboxMessages with .projection()", () => {
    expect(ok("db.inboxMessages.find({userId: ObjectId('507f1f77bcf86cd799439011')}).projection({_id: 1, status: 1}).limit(10)")).not.toThrow();
  });

  it("rejects find on leads without .project() chain", () => {
    expect(bad("db.leads.find({userId: ObjectId('507f1f77bcf86cd799439011')}, {_id: 1}).limit(10)")).toThrow(/projection required.*leads/);
  });

  it("rejects find on inboxConversations without .project()", () => {
    expect(bad("db.inboxConversations.find({userId: ObjectId('507f1f77bcf86cd799439011')}).limit(10)")).toThrow(/projection required.*inboxConversations/);
  });

  it("findOne on fat collections is exempt (single-doc, trim handles bloat)", () => {
    expect(ok("db.inboxConversations.findOne({userId: ObjectId('507f1f77bcf86cd799439011')})")).not.toThrow();
  });

  it("does not apply to non-fat collections", () => {
    expect(ok("db.campaigns.find({userId: ObjectId('507f1f77bcf86cd799439011')}).limit(10)")).not.toThrow();
  });
});

describe("validator — PATCH 6 hardening: tenant value must be ObjectId or $in:[ObjectId,...]", () => {
  it("accepts userId: { $in: [ObjectId(...), ObjectId(...)] }", () => {
    expect(ok("db.leads.find({userId: {$in: [ObjectId('507f1f77bcf86cd799439011'), ObjectId('507f1f77bcf86cd799439012')]}}).project({_id:1}).limit(10)")).not.toThrow();
  });

  it("rejects userId: null", () => {
    expect(bad("db.leads.find({userId: null}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });

  it("rejects userId: { $ne: ObjectId(...) }", () => {
    expect(bad("db.leads.find({userId: {$ne: ObjectId('507f1f77bcf86cd799439011')}}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });

  it("rejects userId: { $exists: true }", () => {
    expect(bad("db.leads.find({userId: {$exists: true}}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });

  it("rejects userId: { $in: [] } (empty array)", () => {
    expect(bad("db.leads.find({userId: {$in: []}}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });

  it("rejects userId: { $in: ['raw-string'] } (non-ObjectId)", () => {
    expect(bad("db.leads.find({userId: {$in: ['hex']}}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });

  it("rejects userId: 'raw-hex-string'", () => {
    expect(bad("db.leads.find({userId: '507f1f77bcf86cd799439011'}).project({_id:1}).limit(10)")).toThrow(/tenant filter required/);
  });
});

describe("validator — PATCH 9: aggregate pipeline stage cap", () => {
  it("accepts aggregate with 10 stages", () => {
    const stages = Array.from({length: 9}, () => "{$project: {a: 1}}").join(", ");
    const expr = `db.audiences.aggregate([{$match: {userId: ObjectId('507f1f77bcf86cd799439011')}}, ${stages}])`;
    expect(ok(expr)).not.toThrow();
  });

  it("rejects aggregate with 11 stages", () => {
    const stages = Array.from({length: 10}, () => "{$project: {a: 1}}").join(", ");
    const expr = `db.audiences.aggregate([{$match: {userId: ObjectId('507f1f77bcf86cd799439011')}}, ${stages}])`;
    expect(bad(expr)).toThrow(/exceeds 10 stages/);
  });
});
