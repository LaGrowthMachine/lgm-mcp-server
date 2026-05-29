// Adapté de harness/.claude/skills/db-explorer-init/bin/src/validator.ts (2026-05-12).
// Allègements 2026-05-13 (LAGM-16436) : le slave readonly enforce l'absence
// d'écriture et d'exec arbitraire au niveau DB. Le validator garde uniquement
// ce qui ne peut PAS être garanti côté DB :
//   - Forme structurelle (chaîne `db.<col>.<op>(...)`, args statiques)
//   - Exécution JS server-side ($where / $function / $accumulator)
//   - Sanity checks (collections `system.*` / contenant `$`, .limit() incompatible)
//   - Cap aggregate pipeline (MAX_AGG_STAGES) — cost guardrail
//
// Ce que le validator NE bloque PLUS (et délègue à la DB readonly + à la doctrine
// `SKILL.md`) :
//   - Mutations (insert/update/delete/drop/bulkWrite/eval/runCommand) — DB refuse
//   - $out / $merge — DB refuse (écritures)
//   - $lookup / $unionWith / $graphLookup — coûteux mais pas dangereux, doctrine guide
//   - Tenant filter obligatoire — doctrine guide (objectif #3)
//   - Projection obligatoire / .limit() explicite — clamp côté interpreter + doctrine

import { parse } from "acorn";

export class ValidationError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

const ROOT_OPS = new Set([
  "find", "findOne",
  "count", "countDocuments", "estimatedDocumentCount",
  "distinct",
  "aggregate",
  "getIndexes",
  "stats",
]);

const CHAIN_OPS = new Set([
  "limit", "skip", "sort", "project", "projection",
  "batchSize", "hint", "comment", "allowDiskUse",
  "count", "toArray", "itcount", "explain", "pretty",
  "max", "min", "returnKey", "showRecordId", "maxTimeMS",
]);

const ALLOWED_IDENTIFIERS = new Set([
  "db",
  "ObjectId", "ISODate", "NumberInt", "NumberLong", "NumberDecimal",
  "BinData", "UUID", "MinKey", "MaxKey", "Timestamp",
  "RegExp", "Date",
  "undefined", "Infinity", "NaN",
]);

// Only JS-exec keys remain — these run user code server-side regardless of
// readonly user privileges, so DB-level guard cannot stop them.
const FORBIDDEN_AGG_KEYS = new Set([
  "$function",
  "$where",
  "$accumulator",
]);

// Ops that do not accept .limit() in any form.
const NO_LIMIT_OPS = new Set([
  "countDocuments",
  "count",
  "estimatedDocumentCount",
  "distinct",
  "getIndexes",
  "stats",
  "findOne",
]);

// Aggregate pipeline stage cap — cost guardrail.
const MAX_AGG_STAGES = 10;

const isReservedCollection = (name: string): boolean =>
  /^system($|\.)/.test(name) || name.includes("$");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

export type ValidationResult = {
  rootOp: string;
  chainOps: string[];
  chainOpsWithArgs: { name: string; args: AstNode[] }[];
  argsAst: AstNode[];
  collection: string;
  rootCallEnd: number;
  expressionEnd: number;
  limitArg?: { start: number; end: number; value: number };
};

export function validate(expr: string): ValidationResult {
  const trimmed = expr.trim().replace(/;+$/, "");
  let program: AstNode;
  try {
    program = parse(trimmed, { ecmaVersion: "latest", sourceType: "script" });
  } catch (e) {
    throw new ValidationError(
      `cannot parse expression: ${(e as Error).message}`,
      `pass a single mongo expression like db.users.findOne({...})`,
    );
  }
  if (!program.body || program.body.length !== 1) {
    throw new ValidationError(
      `expected exactly one statement, got ${program.body?.length ?? 0}`,
      `no semicolons / multi-statements; one expression per call`,
    );
  }
  const stmt = program.body[0];
  if (stmt.type !== "ExpressionStatement") {
    throw new ValidationError(
      `top-level must be an expression, got ${stmt.type}`,
      `no var/let/const/function/etc. — just a mongo expression`,
    );
  }
  const top = stmt.expression;
  if (top.type !== "CallExpression") {
    throw new ValidationError(
      `expression must be a method call (got ${top.type})`,
      `e.g. db.users.findOne({...})`,
    );
  }

  const chainOps: string[] = [];
  const chainOpsWithArgs: { name: string; args: AstNode[] }[] = [];
  let limitArg: ValidationResult["limitArg"] | undefined;
  let current: AstNode = top;
  while (!isRootCall(current)) {
    if (current.type !== "CallExpression" || current.callee?.type !== "MemberExpression") {
      throw new ValidationError(
        `expression must form a chain rooted at db.<col>.<op>(...)`,
        `e.g. db.users.find({...}) or db.getCollection('users').find({...})`,
      );
    }
    const methodName = readMethodName(current.callee, "chain");
    if (!CHAIN_OPS.has(methodName)) {
      throw new ValidationError(
        `chain method not allowed: .${methodName}()`,
        `allowed chain ops: ${[...CHAIN_OPS].join(", ")}`,
      );
    }
    chainOps.unshift(methodName);
    chainOpsWithArgs.unshift({ name: methodName, args: current.arguments });
    validateArgs(current.arguments, methodName);
    if (methodName === "limit" && current.arguments.length === 1) {
      const a = current.arguments[0];
      if (a.type === "Literal" && typeof a.value === "number") {
        limitArg = { start: a.start, end: a.end, value: a.value };
      }
    }
    current = current.callee.object;
  }

  if (current.type !== "CallExpression" || !current.callee || current.callee.type !== "MemberExpression") {
    throw new ValidationError(
      `root operation must be a method call on a collection`,
      `e.g. db.users.find({...}) or db.getCollection('users').find({...})`,
    );
  }
  const rootOp = readMethodName(current.callee, "root");
  if (!ROOT_OPS.has(rootOp)) {
    throw new ValidationError(
      `root operation not allowed: .${rootOp}()`,
      `allowed root ops: ${[...ROOT_OPS].join(", ")}`,
    );
  }
  validateArgs(current.arguments, rootOp);

  if (NO_LIMIT_OPS.has(rootOp) && chainOps.includes("limit")) {
    throw new ValidationError(
      `.limit() is not supported on .${rootOp}()`,
      `remove .limit() — this op does not return a cursor`,
    );
  }

  const target = current.callee.object;
  const collection = readCollectionTarget(target);

  if (isReservedCollection(collection)) {
    throw new ValidationError(
      `collection name not allowed: ${collection}`,
      `system collections and names containing '$' are blocked`,
    );
  }

  // Aggregate: structural checks + cap.
  if (rootOp === "aggregate") {
    const pipeline = current.arguments[0];
    if (!pipeline || pipeline.type !== "ArrayExpression") {
      throw new ValidationError(
        `aggregate requires an array literal as first argument`,
        `e.g. db.users.aggregate([{$match:{...}}, {$group:{...}}])`,
      );
    }
    for (const stage of pipeline.elements) {
      if (!stage || stage.type !== "ObjectExpression") {
        throw new ValidationError(
          `each aggregate pipeline stage must be an object literal`,
          `got element of type ${stage?.type ?? "null"}`,
        );
      }
    }
    if (pipeline.elements.length > MAX_AGG_STAGES) {
      throw new ValidationError(
        `aggregate pipeline exceeds ${MAX_AGG_STAGES} stages on '${collection}' (got ${pipeline.elements.length})`,
        `split the work or simplify — fewer, well-indexed stages run faster`,
      );
    }
    walkForbiddenKeys(pipeline);
  }

  // find/findOne filters: walk for $where etc. at top level.
  if (rootOp === "find" || rootOp === "findOne") {
    const filter = current.arguments[0];
    if (filter) walkForbiddenKeys(filter);
  }

  return {
    rootOp,
    chainOps,
    chainOpsWithArgs,
    argsAst: current.arguments,
    collection,
    rootCallEnd: current.end,
    expressionEnd: top.end,
    limitArg,
  };
}

function isRootCall(node: AstNode): boolean {
  if (!node || node.type !== "CallExpression") return false;
  if (!node.callee || node.callee.type !== "MemberExpression" || node.callee.computed) return false;
  const target = node.callee.object;
  if (target?.type === "MemberExpression" && !target.computed
      && target.object?.type === "Identifier" && target.object.name === "db") {
    return true;
  }
  if (target?.type === "CallExpression"
      && target.callee?.type === "MemberExpression" && !target.callee.computed
      && target.callee.object?.type === "Identifier" && target.callee.object.name === "db"
      && target.callee.property?.type === "Identifier" && target.callee.property.name === "getCollection") {
    return true;
  }
  return false;
}

function readMethodName(memberExpr: AstNode, kind: "root" | "chain"): string {
  if (memberExpr.computed) {
    throw new ValidationError(
      `computed property access not allowed (.[expr])`,
      `use literal method names: .find(), .limit(), etc.`,
    );
  }
  if (!memberExpr.property || memberExpr.property.type !== "Identifier") {
    throw new ValidationError(`${kind} method must be a plain identifier`);
  }
  return memberExpr.property.name;
}

function readCollectionTarget(node: AstNode): string {
  if (node.type === "MemberExpression") {
    if (node.computed) {
      throw new ValidationError(
        `db[<expr>] not allowed`,
        `use db.<collectionName> or db.getCollection('<name>')`,
      );
    }
    if (node.object?.type !== "Identifier" || node.object.name !== "db") {
      throw new ValidationError(`collection must be accessed via db.<col>`);
    }
    if (!node.property || node.property.type !== "Identifier") {
      throw new ValidationError(`collection name must be an identifier`);
    }
    return node.property.name;
  }
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (callee?.type !== "MemberExpression" || callee.computed) {
      throw new ValidationError(`unsupported collection target`);
    }
    if (callee.object?.type !== "Identifier" || callee.object.name !== "db") {
      throw new ValidationError(`collection must be on db`);
    }
    if (callee.property?.name !== "getCollection") {
      throw new ValidationError(
        `unsupported collection accessor: db.${callee.property?.name}`,
        `use db.<col> or db.getCollection('<col>')`,
      );
    }
    if (
      node.arguments.length !== 1 ||
      node.arguments[0].type !== "Literal" ||
      typeof node.arguments[0].value !== "string"
    ) {
      throw new ValidationError(`db.getCollection requires a single string literal`);
    }
    return node.arguments[0].value;
  }
  throw new ValidationError(
    `collection target must be db.<col> or db.getCollection('<col>')`,
  );
}

function validateArgs(args: AstNode[], methodName: string): void {
  for (const arg of args) {
    walkValueExpr(arg, `argument of .${methodName}()`);
  }
}

function walkValueExpr(node: AstNode, where: string): void {
  if (!node) return;
  switch (node.type) {
    case "Literal":
    case "TemplateLiteral":
      if (node.expressions) for (const e of node.expressions) walkValueExpr(e, where);
      return;
    case "ObjectExpression":
      for (const prop of node.properties) {
        if (prop.type === "SpreadElement") {
          throw new ValidationError(`spread in ${where} not allowed`);
        }
        if (prop.computed) {
          throw new ValidationError(`computed object key in ${where} not allowed`);
        }
        walkValueExpr(prop.value, where);
      }
      return;
    case "ArrayExpression":
      for (const el of node.elements) walkValueExpr(el, where);
      return;
    case "UnaryExpression":
      if (!["-", "+", "!"].includes(node.operator)) {
        throw new ValidationError(`unary operator ${node.operator} not allowed in ${where}`);
      }
      walkValueExpr(node.argument, where);
      return;
    case "BinaryExpression": {
      const ok = ["+", "-", "*", "/", "%"];
      if (!ok.includes(node.operator)) {
        throw new ValidationError(`binary operator ${node.operator} not allowed in ${where}`);
      }
      walkValueExpr(node.left, where);
      walkValueExpr(node.right, where);
      return;
    }
    case "CallExpression": {
      const callee = node.callee;
      if (callee.type !== "Identifier") {
        throw new ValidationError(
          `only top-level helper calls are allowed in ${where} (e.g. ObjectId('...'))`,
        );
      }
      if (!ALLOWED_IDENTIFIERS.has(callee.name)) {
        throw new ValidationError(
          `identifier not allowed: ${callee.name}`,
          `allowed: ${[...ALLOWED_IDENTIFIERS].join(", ")}`,
        );
      }
      for (const a of node.arguments) walkValueExpr(a, where);
      return;
    }
    case "NewExpression": {
      const callee = node.callee;
      if (callee.type !== "Identifier" || !ALLOWED_IDENTIFIERS.has(callee.name)) {
        throw new ValidationError(`new ${callee.name ?? "?"}() not allowed in ${where}`);
      }
      for (const a of node.arguments) walkValueExpr(a, where);
      return;
    }
    case "Identifier":
      if (!ALLOWED_IDENTIFIERS.has(node.name)) {
        throw new ValidationError(
          `identifier not allowed: ${node.name}`,
          `allowed: ${[...ALLOWED_IDENTIFIERS].join(", ")}`,
        );
      }
      return;
    case "MemberExpression":
      throw new ValidationError(
        `member access not allowed in ${where}`,
        `mongo query values must be plain literals/objects/arrays`,
      );
    default:
      throw new ValidationError(`expression type ${node.type} not allowed in ${where}`);
  }
}

function walkForbiddenKeys(node: AstNode): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) walkForbiddenKeys(el);
    return;
  }
  if (node.type === "ObjectExpression") {
    for (const prop of node.properties) {
      if (prop.computed) {
        throw new ValidationError(
          `computed object key not allowed in filter/pipeline`,
          `use plain identifiers or string literals`,
        );
      }
      const key = prop.key;
      const keyName =
        key.type === "Identifier" ? key.name :
        key.type === "Literal" && typeof key.value === "string" ? key.value :
        null;
      if (keyName && FORBIDDEN_AGG_KEYS.has(keyName)) {
        throw new ValidationError(
          `forbidden key: ${keyName}`,
          `${keyName} executes JS server-side and is not allowed`,
        );
      }
      walkForbiddenKeys(prop.value);
    }
    return;
  }
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "range" || k === "start" || k === "end" || k === "type") continue;
    walkForbiddenKeys(node[k]);
  }
}
