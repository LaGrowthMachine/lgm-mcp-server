import {
  Binary,
  Decimal128,
  EJSON,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from "bson";
import type { Db } from "mongodb";
import type { ValidationResult } from "./validator";

export interface RunQueryResult {
  ok: true;
  output: unknown;
  durationMs: number;
  warnings?: string[];
  truncated?: boolean;
}

export interface RunQueryError {
  ok: false;
  error: string;
  hint?: string;
  durationMs: number;
}

const MAX_TIME_MS = 10_000;
const RESULT_BYTE_BUDGET = 50_000;
const REGEX_LITERAL_MAX = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_SKIP = 100_000;
const ALLOWED_REGEX_FLAGS = /^[imsx]*$/;
const REGEX_FLAGS_MAX = 4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

class InterpreterError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

const evalNode = (node: AstNode): unknown => {
  if (!node) return undefined;
  switch (node.type) {
    case "Literal":
      // acorn literal: regex literals carry `regex: { pattern, flags }`
      if (node.regex && typeof node.regex.pattern === "string") {
        if (node.regex.pattern.length > REGEX_LITERAL_MAX) {
          throw new InterpreterError(
            `regex literal exceeds ${REGEX_LITERAL_MAX} chars (anti-ReDoS)`,
          );
        }
        const flags = node.regex.flags || "";
        if (flags.length > REGEX_FLAGS_MAX || !ALLOWED_REGEX_FLAGS.test(flags)) {
          throw new InterpreterError(
            `regex flags must be a subset of [i, m, s, x]`,
          );
        }
        return new RegExp(node.regex.pattern, flags);
      }
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) {
        throw new InterpreterError("template expressions not allowed");
      }
      return node.quasis.map((q: AstNode) => q.value.cooked).join("");
    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const prop of node.properties) {
        const key =
          prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key.type === "Literal"
              ? String(prop.key.value)
              : null;
        if (key === null) throw new InterpreterError("unsupported object key");
        obj[key] = evalNode(prop.value);
      }
      return obj;
    }
    case "ArrayExpression":
      return node.elements.map((el: AstNode) => evalNode(el));
    case "UnaryExpression": {
      const v = evalNode(node.argument) as number;
      if (node.operator === "-") return -v;
      if (node.operator === "+") return +v;
      if (node.operator === "!") return !v;
      throw new InterpreterError(`unary operator ${node.operator} not supported`);
    }
    case "BinaryExpression": {
      const l = evalNode(node.left) as number;
      const r = evalNode(node.right) as number;
      switch (node.operator) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        default: throw new InterpreterError(`binary operator ${node.operator} not supported`);
      }
    }
    case "Identifier":
      switch (node.name) {
        case "undefined": return undefined;
        case "Infinity": return Infinity;
        case "NaN": return NaN;
        default: throw new InterpreterError(`identifier ${node.name} not supported`);
      }
    case "CallExpression":
    case "NewExpression":
      return evalBsonHelper(node);
    default:
      throw new InterpreterError(`expression type ${node.type} not supported`);
  }
};

const requireString = (helperName: string, value: unknown): string => {
  if (typeof value !== "string") {
    throw new InterpreterError(
      `${helperName}() requires a string argument (got ${typeof value})`,
    );
  }
  return value;
};

const evalBsonHelper = (node: AstNode): unknown => {
  const name = node.callee?.name;
  const args = node.arguments.map((a: AstNode) => evalNode(a));
  switch (name) {
    case "ObjectId": {
      if (args.length === 0) {
        throw new InterpreterError("ObjectId() requires a 24-char hex argument");
      }
      const s = requireString("ObjectId", args[0]);
      try {
        return new ObjectId(s);
      } catch (e) {
        throw new InterpreterError(`invalid ObjectId: ${(e as Error).message}`);
      }
    }
    case "ISODate":
    case "Date": {
      if (args.length === 0) return new Date();
      const s = requireString(name, args[0]);
      const d = new Date(s);
      if (isNaN(d.getTime())) throw new InterpreterError(`invalid date: ${s}`);
      return d;
    }
    case "NumberInt": {
      const n = Number(args[0]);
      if (!Number.isFinite(n)) {
        throw new InterpreterError(`NumberInt() requires a finite number`);
      }
      return n;
    }
    case "NumberLong":
      return Long.fromString(requireString("NumberLong", args[0]));
    case "NumberDecimal":
      return Decimal128.fromString(requireString("NumberDecimal", args[0]));
    case "BinData": {
      const subtype = Number(args[0]);
      if (!Number.isFinite(subtype) || subtype < 0 || subtype > 255) {
        throw new InterpreterError(`BinData() subtype must be a byte (0–255)`);
      }
      const b64 = requireString("BinData", args[1]);
      if (!/^[A-Za-z0-9+/=]*$/.test(b64)) {
        throw new InterpreterError(`BinData() payload is not valid base64`);
      }
      return new Binary(Buffer.from(b64, "base64"), subtype);
    }
    case "UUID":
      return new UUID(requireString("UUID", args[0]));
    case "MinKey":
      return new MinKey();
    case "MaxKey":
      return new MaxKey();
    case "Timestamp": {
      const arg = args[0];
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
        throw new InterpreterError(`Timestamp() requires an object {t, i}`);
      }
      const { t, i } = arg as { t?: unknown; i?: unknown };
      if (typeof t !== "number" || typeof i !== "number") {
        throw new InterpreterError(`Timestamp() requires numeric {t, i}`);
      }
      return new Timestamp({ t, i });
    }
    case "RegExp": {
      const pattern = requireString("RegExp", args[0]);
      const flags = args[1] === undefined ? "" : requireString("RegExp", args[1]);
      if (pattern.length > REGEX_LITERAL_MAX) {
        throw new InterpreterError(
          `regex literal exceeds ${REGEX_LITERAL_MAX} chars (anti-ReDoS)`,
        );
      }
      if (flags.length > REGEX_FLAGS_MAX || !ALLOWED_REGEX_FLAGS.test(flags)) {
        throw new InterpreterError(
          `regex flags must be a subset of [i, m, s, x]`,
        );
      }
      return new RegExp(pattern, flags);
    }
    default:
      throw new InterpreterError(`unsupported helper: ${name}`);
  }
};

const evalArgs = (args: AstNode[]): unknown[] => args.map((a) => evalNode(a));

const clampLimit = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(n)));
};

const clampMaxTimeMS = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MAX_TIME_MS;
  return Math.min(MAX_TIME_MS, Math.floor(n));
};

const clampSkip = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_SKIP, Math.floor(n));
};

// Clamp user-supplied maxTimeMS to [1, MAX_TIME_MS]; otherwise apply MAX_TIME_MS.
const withMaxTime = (opts: unknown): Record<string, unknown> => {
  const base =
    typeof opts === "object" && opts !== null
      ? (opts as Record<string, unknown>)
      : {};
  const userValue = base.maxTimeMS;
  const clamped =
    userValue === undefined ? MAX_TIME_MS : clampMaxTimeMS(userValue);
  return { ...base, maxTimeMS: clamped };
};

interface TrimmedResult {
  output: unknown;
  truncated: boolean;
}

const trimResult = (result: unknown): TrimmedResult => {
  if (!Array.isArray(result)) {
    const s = EJSON.stringify(result, { relaxed: true });
    if (s.length <= RESULT_BYTE_BUDGET) {
      return { output: EJSON.parse(s, { relaxed: true }), truncated: false };
    }
    return {
      output: "<single document exceeds 50KB — use projection>",
      truncated: true,
    };
  }
  const kept: unknown[] = [];
  let size = 0;
  for (const doc of result) {
    const s = EJSON.stringify(doc, { relaxed: true });
    if (size + s.length > RESULT_BYTE_BUDGET) break;
    kept.push(EJSON.parse(s, { relaxed: true }));
    size += s.length;
  }
  return { output: kept, truncated: kept.length < result.length };
};

export const runValidatedQuery = async (
  db: Db,
  validation: ValidationResult,
): Promise<RunQueryResult | RunQueryError> => {
  const t0 = Date.now();
  try {
    const args = evalArgs(validation.argsAst);
    const coll = db.collection(validation.collection);
    const rootOp = validation.rootOp;

    // Dispatch root op → driver call.
    const dispatch: Record<string, () => unknown> = {
      find: () => coll.find((args[0] ?? {}) as Record<string, unknown>, withMaxTime(args[1])),
      findOne: () => coll.findOne((args[0] ?? {}) as Record<string, unknown>, withMaxTime(args[1])),
      countDocuments: () =>
        coll.countDocuments((args[0] ?? {}) as Record<string, unknown>, withMaxTime(args[1])),
      count: () =>
        coll.countDocuments((args[0] ?? {}) as Record<string, unknown>, withMaxTime(args[1])),
      estimatedDocumentCount: () => coll.estimatedDocumentCount(withMaxTime(args[0])),
      distinct: () =>
        coll.distinct(
          String(args[0]),
          (args[1] ?? {}) as Record<string, unknown>,
          withMaxTime(args[2]),
        ),
      aggregate: () =>
        coll.aggregate(
          (args[0] ?? []) as Record<string, unknown>[],
          { ...withMaxTime(args[1]), allowDiskUse: false },
        ),
      getIndexes: () => coll.indexes(),
      stats: () => coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray(),
    };

    if (!dispatch[rootOp]) {
      return {
        ok: false,
        error: `unsupported root op at runtime: ${rootOp}`,
        durationMs: Date.now() - t0,
      };
    }

    // Cursor-returning ops apply chainOps; scalar/promise ops resolve directly.
    const cursorReturns = new Set(["find", "aggregate"]);
    let result: unknown;
    if (cursorReturns.has(rootOp)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cursor: any = dispatch[rootOp]();
      const chain = validation.chainOpsWithArgs;
      const hasLimit = chain.some((c) => c.name === "limit");
      if (!hasLimit) {
        cursor = cursor.limit(DEFAULT_LIMIT);
      }
      for (const { name, args: chainArgs } of chain) {
        const evaluated = chainArgs.map((a: AstNode) => evalNode(a));
        if (name === "limit") {
          cursor = cursor.limit(clampLimit(evaluated[0]));
        } else if (name === "skip") {
          cursor = cursor.skip(clampSkip(evaluated[0]));
        } else if (name === "maxTimeMS") {
          cursor = cursor.maxTimeMS(clampMaxTimeMS(evaluated[0]));
        } else if (name === "allowDiskUse") {
          // The root op already forces allowDiskUse:false. Drop any cursor-level
          // override so the model cannot re-enable disk spills.
          continue;
        } else if (name === "hint") {
          const v = evaluated[0];
          if (typeof v === "string" && v.startsWith("$")) {
            return {
              ok: false,
              error: `.hint('${v}') is not allowed`,
              durationMs: Date.now() - t0,
            };
          }
          cursor = cursor.hint(v as never);
        } else if (
          name === "toArray" ||
          name === "explain" ||
          name === "count" ||
          name === "itcount" ||
          name === "pretty"
        ) {
          continue;
        } else if (typeof cursor[name] === "function") {
          cursor = cursor[name](...evaluated);
        } else {
          return {
            ok: false,
            error: `chain op .${name}() not supported by cursor`,
            durationMs: Date.now() - t0,
          };
        }
      }
      result = await cursor.toArray();
    } else {
      const r = dispatch[rootOp]();
      result = await Promise.resolve(r);
    }

    const trimmed = trimResult(result);
    return {
      ok: true,
      output: trimmed.output,
      durationMs: Date.now() - t0,
      truncated: trimmed.truncated || undefined,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      error: e.message || String(err),
      hint: (err as InterpreterError).hint,
      durationMs: Date.now() - t0,
    };
  }
};
