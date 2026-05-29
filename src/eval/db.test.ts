// Tests unitaires : on mocke `pg.Pool` pour isoler la cascade applicative
// `deleteBatch` (transaction BEGIN / DELETE analyses / DELETE batches /
// COMMIT, ROLLBACK on error) et on valide la pure function
// `computeBatchMetricsFromRows` pour l'agrégat `n_canon`. Pas de Postgres
// requis — runner Jest standard (cf. project-context : tests sans infra
// quand c'est possible).

// --- mock pg avant tout import du module sous test --------------------------
// `jest.mock` est hoisté par ts-jest au-dessus des imports, donc on peut
// utiliser l'import ESM standard ci-dessous sans craindre l'ordre source.
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};
const mockPool = {
  connect: jest.fn(async () => mockClient),
  query: jest.fn(),
  // `getPool()` câble un handler `error` au boot pour éviter qu'une erreur
  // client idle ne crashe le process — on no-op ici.
  on: jest.fn(),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}));

import {
  deleteBatch,
  computeBatchMetricsFromRows,
  type BatchAnalysisItem,
} from "./db";

beforeEach(() => {
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  mockPool.connect.mockClear();
});

// --- mkRow helper -----------------------------------------------------------
const mkRow = (overrides: Partial<BatchAnalysisItem> = {}): BatchAnalysisItem => ({
  analysis_id: "a1",
  conversation_id: "c1",
  status: "ok",
  is_canon: false,
  created_at: "2026-05-26T16:00:00Z",
  has_canon: true,
  new_label: "INTERESTED",
  new_sub_label: "POSITIVE",
  canon_label: "INTERESTED",
  canon_sub_label: "POSITIVE",
  reason: null,
  verdict: "pass",
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: null,
  cost_usd: 0.001,
  ...overrides,
});

// =============================================================================
// deleteBatch — cascade applicative en transaction
// =============================================================================
describe("deleteBatch — transactional cascade", () => {
  it("BEGIN → DELETE analyses → DELETE batches RETURNING → COMMIT (happy path)", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 3 }) // DELETE analyses
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "..." }] }) // DELETE batches RETURNING
      .mockResolvedValueOnce({ rowCount: 0 }); // COMMIT

    const r = await deleteBatch("00000000-0000-0000-0000-000000000001");

    expect(r).toEqual({ deletedAnalyses: 3, batchExisted: true });
    expect(mockClient.query).toHaveBeenCalledTimes(4);
    expect(mockClient.query.mock.calls[0][0]).toBe("BEGIN");
    // Analyses supprimées D'ABORD (FK ON DELETE SET NULL — il faut purger
    // avant le batch sinon les analyses orphelines silencieusement).
    expect(mockClient.query.mock.calls[1][0]).toMatch(
      /DELETE FROM analyses WHERE batch_id = \$1/,
    );
    expect(mockClient.query.mock.calls[1][1]).toEqual([
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(mockClient.query.mock.calls[2][0]).toMatch(
      /DELETE FROM batches WHERE id = \$1 RETURNING id/,
    );
    expect(mockClient.query.mock.calls[2][1]).toEqual([
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(mockClient.query.mock.calls[3][0]).toBe("COMMIT");
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("returns deletedAnalyses=0 when batch has no analyses", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE analyses (rien)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "..." }] }) // DELETE batches RETURNING
      .mockResolvedValueOnce({ rowCount: 0 }); // COMMIT

    const r = await deleteBatch("00000000-0000-0000-0000-000000000002");
    expect(r).toEqual({ deletedAnalyses: 0, batchExisted: true });
  });

  it("batchExisted=false when batch was already deleted by another request", async () => {
    // Race : un autre client a déjà supprimé le batch entre l'ouverture du
    // modal et l'envoi du DELETE. DELETE FROM batches retourne 0 row, on
    // doit signaler ça à la route pour qu'elle renvoie 404 plutôt que 200.
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE analyses (rien)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // DELETE batches RETURNING — vide
      .mockResolvedValueOnce({ rowCount: 0 }); // COMMIT

    const r = await deleteBatch("00000000-0000-0000-0000-000000000099");
    expect(r).toEqual({ deletedAnalyses: 0, batchExisted: false });
  });

  it("ROLLBACK + rethrow when DELETE analyses fails", async () => {
    const boom = new Error("simulated postgres failure");
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(boom) // DELETE analyses → 💥
      .mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK

    await expect(
      deleteBatch("00000000-0000-0000-0000-000000000003"),
    ).rejects.toThrow("simulated postgres failure");

    expect(mockClient.query.mock.calls[0][0]).toBe("BEGIN");
    expect(mockClient.query.mock.calls[2][0]).toBe("ROLLBACK");
    // DELETE batches n'a JAMAIS été appelé — atomicité préservée.
    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain("COMMIT");
    expect(
      calls.some((q: unknown) =>
        typeof q === "string" && /DELETE FROM batches/.test(q),
      ),
    ).toBe(false);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it("ROLLBACK + rethrow when DELETE batches fails (mid-transaction)", async () => {
    const boom = new Error("FK error or pg crash");
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 5 }) // DELETE analyses
      .mockRejectedValueOnce(boom) // DELETE batches → 💥
      .mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK

    await expect(
      deleteBatch("00000000-0000-0000-0000-000000000004"),
    ).rejects.toThrow("FK error or pg crash");

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain("COMMIT");
    expect(calls).toContain("ROLLBACK");
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// computeBatchMetricsFromRows — agrégat n_canon
// =============================================================================
describe("computeBatchMetricsFromRows — n_canon aggregate", () => {
  it("returns n_canon=0 when no analysis in batch is canon", async () => {
    const rows: BatchAnalysisItem[] = [
      mkRow({ analysis_id: "a1", is_canon: false }),
      mkRow({ analysis_id: "a2", is_canon: false }),
      mkRow({ analysis_id: "a3", is_canon: false, verdict: "skipped" }),
    ];
    const m = computeBatchMetricsFromRows(rows);
    expect(m.n_canon).toBe(0);
    expect(m.n_total).toBe(3);
  });

  it("counts is_canon analyses (warning trigger côté UI)", async () => {
    const rows: BatchAnalysisItem[] = [
      mkRow({ analysis_id: "a1", is_canon: true }),
      mkRow({
        analysis_id: "a2",
        conversation_id: "c2",
        is_canon: true,
      }),
      mkRow({ analysis_id: "a3", is_canon: false }),
    ];
    const m = computeBatchMetricsFromRows(rows);
    expect(m.n_canon).toBe(2);
  });

  it("treats n_canon orthogonally to verdict buckets", async () => {
    // is_canon doit être agrégé indépendamment du verdict — une analyse
    // canon avec verdict skipped ou error compte quand même côté warning.
    const rows: BatchAnalysisItem[] = [
      mkRow({ analysis_id: "a1", is_canon: true, verdict: "pass" }),
      mkRow({ analysis_id: "a2", is_canon: true, verdict: "regression" }),
      mkRow({
        analysis_id: "a3",
        is_canon: true,
        verdict: "skipped",
        status: "skipped",
      }),
      mkRow({ analysis_id: "a4", is_canon: false, verdict: "no_canon" }),
    ];
    const m = computeBatchMetricsFromRows(rows);
    expect(m.n_canon).toBe(3);
    expect(m.n_pass).toBe(1);
    expect(m.n_regression).toBe(1);
    expect(m.n_skipped).toBe(1);
    expect(m.n_no_canon).toBe(1);
  });

  it("empty rows → n_canon=0, n_total=0", async () => {
    const m = computeBatchMetricsFromRows([]);
    expect(m.n_canon).toBe(0);
    expect(m.n_total).toBe(0);
  });
});
