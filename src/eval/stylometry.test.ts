import {
  tokenize,
  splitSentences,
  computeMetrics,
  compareMetrics,
} from "./stylometry";

describe("tokenize", () => {
  it("lowercases and splits on whitespace + punctuation", () => {
    expect(tokenize("Hello, world!")).toEqual(["hello", "world"]);
  });

  it("preserves intra-word apostrophes", () => {
    expect(tokenize("c'est aujourd'hui")).toEqual(["c'est", "aujourd'hui"]);
  });

  it("handles unicode letters", () => {
    expect(tokenize("où très")).toEqual(["où", "très"]);
  });

  it("returns empty array for empty/blank string", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("splits on . ! ? followed by space or end", () => {
    expect(splitSentences("Hello. How are you? Fine!")).toEqual([
      "Hello",
      "How are you",
      "Fine",
    ]);
  });

  it("returns single chunk when no terminal punctuation", () => {
    expect(splitSentences("just one sentence")).toEqual(["just one sentence"]);
  });

  it("returns empty array for empty input", () => {
    expect(splitSentences("")).toEqual([]);
  });
});

describe("computeMetrics — empty corpus", () => {
  it("returns null metrics when corpus is empty", () => {
    const m = computeMetrics([]);
    expect(m.length.msg_words_avg).toBeNull();
    expect(m.length.sentence_words_avg).toBeNull();
    expect(m.length.word_chars_avg).toBeNull();
    expect(m.vocab.ttr).toBeNull();
    expect(m.vocab.hapax_ratio).toBeNull();
    expect(m.vocab.yule_k).toBeNull();
    expect(m.mfw_top30).toEqual([]);
  });

  it("returns null metrics when all corpus entries are blank", () => {
    const m = computeMetrics(["", "  ", "\n"]);
    expect(m.length.msg_words_avg).toBeNull();
  });
});

describe("computeMetrics — known corpus", () => {
  it("computes plausible length / vocab / punctuation", () => {
    const corpus = [
      "Hello world. This is a test.",
      "Another short message. With two sentences.",
    ];
    const m = computeMetrics(corpus);
    // 6 + 6 tokens across 2 messages → 6 avg
    expect(m.length.msg_words_avg).toBeCloseTo(6, 1);
    // 4 sentences total, ~2-3 words each
    expect(m.length.sentence_words_avg).toBeGreaterThan(2);
    expect(m.length.sentence_words_avg).toBeLessThan(4);
    // TTR ∈ (0, 1]
    expect(m.vocab.ttr).not.toBeNull();
    expect(m.vocab.ttr!).toBeGreaterThan(0);
    expect(m.vocab.ttr!).toBeLessThanOrEqual(1);
    // periods present → > 0 per 100 words
    expect(m.punctuation_per_100w.period).toBeGreaterThan(0);
    // MFW non vide
    expect(m.mfw_top30.length).toBeGreaterThan(0);
    expect(m.mfw_top30[0].word).toBeDefined();
    expect(m.mfw_top30[0].freq_per_1k).toBeGreaterThan(0);
  });

  it("MFW top is sorted by frequency desc", () => {
    const corpus = ["the the the the cat dog bird"];
    const m = computeMetrics(corpus);
    expect(m.mfw_top30[0].word).toBe("the");
  });

  it("hapax_ratio = unique-once / unique-total", () => {
    const corpus = ["aa aa bb cc"]; // tokens: aa, aa, bb, cc → 3 unique, 2 hapax (bb, cc)
    const m = computeMetrics(corpus);
    expect(m.vocab.hapax_ratio).toBeCloseTo(2 / 3, 5);
  });
});

describe("compareMetrics", () => {
  it("returns pass on identical metrics", () => {
    // Corpus long ≥ MIN_REPLY_WORDS_FOR_VOCAB (200 mots/msg) pour que la
    // dimension vocab soit comparée et non skippée.
    const longMsg =
      "Bonjour, ravi d'échanger avec vous sur ce sujet. Je voulais partager quelques pensées sur notre collaboration potentielle. ".repeat(
        12,
      );
    const corpus = [longMsg];
    const m = computeMetrics(corpus);
    const result = compareMetrics(m, m);
    expect(result.score).toBe(1);
    expect(result.breakdown.length.verdict).toBe("pass");
    expect(result.breakdown.vocab.verdict).toBe("pass");
    expect(result.breakdown.punctuation.verdict).toBe("pass");
  });

  it("skips vocab when reply is too short (TTR length-bias)", () => {
    const shortReply = computeMetrics(["Hello, just checking in. Talk soon!"]);
    const profile = computeMetrics([
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(50),
    ]);
    const result = compareMetrics(shortReply, profile);
    expect(result.breakdown.vocab.verdict).toBe("skip");
    expect(result.breakdown.vocab.delta_relative).toBeNull();
  });

  it("flags fail on large length divergence", () => {
    const tiny = computeMetrics(["hi."]);
    const big = computeMetrics([
      "this is a much much longer message with many more words than the previous one indeed.",
    ]);
    const result = compareMetrics(tiny, big);
    expect(result.breakdown.length.verdict).toBe("fail");
    expect(result.score).toBeLessThan(1);
  });

  it("skips dimensions when profile is null", () => {
    const empty = computeMetrics([]);
    const reply = computeMetrics(["Hello world."]);
    const result = compareMetrics(reply, empty);
    expect(result.breakdown.length.verdict).toBe("skip");
    expect(result.breakdown.vocab.verdict).toBe("skip");
    expect(result.score).toBeNull();
  });

  // P14: comparaison symétrique. Les deltas sont des distances normalisées
  // |a-b|/|ref|, mais le verdict pass/fail et le score doivent être
  // identiques quel que soit l'ordre des arguments. On vérifie l'invariant
  // sur deux corpus non triviaux et distincts.
  it("compareMetrics is symmetric on score and verdicts", () => {
    const corpusA = [
      "Bonjour, ravi d'échanger avec vous sur ce sujet passionnant.",
      "Pour résumer, je propose qu'on programme un appel la semaine prochaine.",
      "À très vite, n'hésitez pas à me poser des questions.",
    ];
    const corpusB = [
      "Hey, super content de te lire ! On peut caler un call rapide ?",
      "Dispo demain ou jeudi, dis-moi ce qui marche pour toi.",
      "Hâte d'en discuter, à plus.",
    ];
    const a = computeMetrics(corpusA);
    const b = computeMetrics(corpusB);
    const ab = compareMetrics(a, b);
    const ba = compareMetrics(b, a);
    expect(ab.score).toBe(ba.score);
    expect(ab.breakdown.length.verdict).toBe(ba.breakdown.length.verdict);
    expect(ab.breakdown.punctuation.verdict).toBe(
      ba.breakdown.punctuation.verdict,
    );
    expect(ab.breakdown.vocab.verdict).toBe(ba.breakdown.vocab.verdict);
  });
});
