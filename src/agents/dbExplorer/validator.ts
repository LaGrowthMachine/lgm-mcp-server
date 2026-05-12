// Vendored from harness/.claude/skills/db-explorer-init/bin/src/validator.ts (2026-05-12).
// LOCAL PATCHES (do not lose on upstream sync):
//   1. FORBIDDEN_AGG_KEYS étendu : + $unionWith, $graphLookup, $lookup
//   2. walkForbiddenKeys appelé aussi sur les filtres find/findOne (top-level $where etc.)
//   3. Collections réservées : reject /^system\./ ou contient '$'
//   4. Pré-check .limit incompatible : reject sur countDocuments/distinct/
//      getIndexes/stats/findOne
//   5. ValidationResult.argsAst exposé : AST racine des args, consommable
//      par l'interpréteur sans re-parse (anti-TOCTOU)

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

// PATCH 1: extended with $unionWith, $graphLookup, $lookup.
const FORBIDDEN_AGG_KEYS = new Set([
  "$out",
  "$merge",
  "$function",
  "$where",
  "$accumulator",
  "$unionWith",
  "$graphLookup",
  "$lookup",
]);

// PATCH 4: ops that do not accept .limit() in any form.
const NO_LIMIT_OPS = new Set([
  "countDocuments",
  "count",
  "estimatedDocumentCount",
  "distinct",
  "getIndexes",
  "stats",
  "findOne",
]);

// PATCH 3: reserved collection names.
const isReservedCollection = (name: string): boolean =>
  /^system($|\.)/.test(name) || name.includes("$");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

export type ValidationResult = {
  rootOp: string;
  chainOps: string[];
  chainOpsWithArgs: { name: string; args: AstNode[] }[]; // PATCH 5: chain args AST
  argsAst: AstNode[]; // PATCH 5: root call args AST
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

  // PATCH 4: reject .limit on incompatible root ops before runtime.
  if (NO_LIMIT_OPS.has(rootOp) && chainOps.includes("limit")) {
    throw new ValidationError(
      `.limit() is not supported on .${rootOp}()`,
      `remove .limit() — this op does not return a cursor`,
    );
  }

  const target = current.callee.object;
  const collection = readCollectionTarget(target);

  // PATCH 3: reserved collection check.
  if (isReservedCollection(collection)) {
    throw new ValidationError(
      `collection name not allowed: ${collection}`,
      `system collections and names containing '$' are read-only blocked`,
    );
  }

  // Aggregate-specific deep walk for forbidden stage keys.
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
    walkForbiddenKeys(pipeline);
  }

  // PATCH 2: also walk filters on find/findOne (catches top-level $where etc.).
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
        // Computed keys can hide forbidden names like { ["$out"]: 'x' }.
        // walkValueExpr already rejects them in args, but be defensive here.
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
          `${keyName} can write data, execute code, or cross collections`,
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
