// Stylométrie pure TS — aucune dépendance NLP. Le noyau partagé entre la
// génération du profil (analyse d'un corpus SENDER) et la validation d'une
// reply générée (mêmes métriques sur 1 texte, comparées au profil).
//
// Toutes les fonctions sont déterministes (pas d'aléa, pas d'I/O). Les
// métriques sont normalisées (per-message, per-100-words, per-1k-tokens) pour
// rester comparables quel que soit le volume du corpus.

export interface LengthMetrics {
  msg_words_avg: number | null;
  sentence_words_avg: number | null;
  word_chars_avg: number | null;
}

export interface VocabMetrics {
  ttr: number | null; // type/token ratio
  hapax_ratio: number | null; // ratio mots vus 1 fois / mots uniques
  yule_k: number | null; // mesure de richesse lexicale
}

export interface PunctuationMetrics {
  period: number;
  comma: number;
  exclamation: number;
  question: number;
  ellipsis: number;
  colon: number;
  semicolon: number;
  dash: number;
}

export interface MfwEntry {
  word: string;
  freq_per_1k: number;
}

export interface StyleMetrics {
  length: LengthMetrics;
  vocab: VocabMetrics;
  punctuation_per_100w: PunctuationMetrics;
  mfw_top30: MfwEntry[];
}

const EMPTY_PUNCT: PunctuationMetrics = {
  period: 0,
  comma: 0,
  exclamation: 0,
  question: 0,
  ellipsis: 0,
  colon: 0,
  semicolon: 0,
  dash: 0,
};

const NULL_METRICS: StyleMetrics = {
  length: {
    msg_words_avg: null,
    sentence_words_avg: null,
    word_chars_avg: null,
  },
  vocab: { ttr: null, hapax_ratio: null, yule_k: null },
  punctuation_per_100w: EMPTY_PUNCT,
  mfw_top30: [],
};

// Tokenisation simple : minuscule + split sur whitespace/ponctuation tout en
// gardant les apostrophes intra-mot ("aujourd'hui", "c'est"). Pas de
// stemming, pas de stopwords — on veut le signal brut du style.
export const tokenize = (text: string): string[] => {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // Caractères de mot : lettres (Unicode), chiffres, apostrophe interne.
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
};

// Découpe en phrases. Coupe sur [.!?…]+ suivi d'un espace ou fin de chaîne.
// Trim + filter empty. Conservative : un texte sans ponctuation termine sa
// vie en une seule "phrase" (= length entière).
export const splitSentences = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/[.!?…]+(?=\s|$)/u);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
};

const countPunctuation = (s: string): PunctuationMetrics => {
  const acc: PunctuationMetrics = { ...EMPTY_PUNCT };
  for (const c of s) {
    if (c === ".") acc.period++;
    else if (c === ",") acc.comma++;
    else if (c === "!") acc.exclamation++;
    else if (c === "?") acc.question++;
    else if (c === "…") acc.ellipsis++;
    else if (c === ":") acc.colon++;
    else if (c === ";") acc.semicolon++;
    else if (c === "-" || c === "—" || c === "–") acc.dash++;
  }
  return acc;
};

// "..." séquence ASCII → comptée comme ellipsis (1 par triple-dot) en plus
// des periods individuels. Approximation : on remplace "..." par "…" avant
// le counting pour ne pas compter 3 points distincts.
const normalizeEllipsis = (s: string): string => s.replace(/\.{3,}/g, "…");

// Yule's K : mesure indépendante de la taille du corpus.
// K = 10000 × (M2 - M1) / M1²
// M1 = nombre total de tokens, M2 = Σ (i² × Vi) où Vi = nb de types apparaissant i fois.
// P13: sous 30 tokens la mesure n'est pas statistiquement signifiante (variance
// énorme, valeurs aberrantes) — on renvoie null pour signaler "skip" en amont.
const YULE_K_MIN_TOKENS = 30;
const computeYuleK = (freqs: Map<string, number>, totalTokens: number): number | null => {
  if (totalTokens < YULE_K_MIN_TOKENS) return null;
  const freqOfFreq = new Map<number, number>();
  for (const f of freqs.values()) {
    freqOfFreq.set(f, (freqOfFreq.get(f) ?? 0) + 1);
  }
  let m2 = 0;
  for (const [f, v] of freqOfFreq.entries()) m2 += f * f * v;
  const m1 = totalTokens;
  if (m1 === 0) return null;
  return (10000 * (m2 - m1)) / (m1 * m1);
};

// Profil = (description + metrics) sur un corpus = liste de messages SENDER.
// Corpus vide ⇒ NULL_METRICS (pas de crash, pas d'inférence).
export const computeMetrics = (corpus: string[]): StyleMetrics => {
  const cleaned = corpus
    .map((s) => (typeof s === "string" ? s : ""))
    .filter((s) => s.trim().length > 0)
    .map(normalizeEllipsis);
  if (cleaned.length === 0) return { ...NULL_METRICS };

  let totalTokens = 0;
  let totalWordChars = 0;
  let totalSentences = 0;
  let totalSentenceWords = 0;
  const tokenFreqs = new Map<string, number>();
  const allPunct: PunctuationMetrics = { ...EMPTY_PUNCT };

  const msgTokenCounts: number[] = [];

  for (const text of cleaned) {
    const tokens = tokenize(text);
    msgTokenCounts.push(tokens.length);
    totalTokens += tokens.length;
    for (const t of tokens) {
      totalWordChars += t.length;
      tokenFreqs.set(t, (tokenFreqs.get(t) ?? 0) + 1);
    }
    const sentences = splitSentences(text);
    for (const s of sentences) {
      const sTok = tokenize(s);
      if (sTok.length === 0) continue;
      totalSentences++;
      totalSentenceWords += sTok.length;
    }
    const p = countPunctuation(text);
    allPunct.period += p.period;
    allPunct.comma += p.comma;
    allPunct.exclamation += p.exclamation;
    allPunct.question += p.question;
    allPunct.ellipsis += p.ellipsis;
    allPunct.colon += p.colon;
    allPunct.semicolon += p.semicolon;
    allPunct.dash += p.dash;
  }

  if (totalTokens === 0) return { ...NULL_METRICS };

  const length: LengthMetrics = {
    msg_words_avg:
      msgTokenCounts.length > 0
        ? msgTokenCounts.reduce((a, b) => a + b, 0) / msgTokenCounts.length
        : null,
    sentence_words_avg:
      totalSentences > 0 ? totalSentenceWords / totalSentences : null,
    word_chars_avg: totalTokens > 0 ? totalWordChars / totalTokens : null,
  };

  const uniqueTypes = tokenFreqs.size;
  const hapax = [...tokenFreqs.values()].filter((v) => v === 1).length;
  const vocab: VocabMetrics = {
    ttr: totalTokens > 0 ? uniqueTypes / totalTokens : null,
    hapax_ratio: uniqueTypes > 0 ? hapax / uniqueTypes : null,
    yule_k: computeYuleK(tokenFreqs, totalTokens),
  };

  const scale = 100 / totalTokens;
  const punctuation_per_100w: PunctuationMetrics = {
    period: allPunct.period * scale,
    comma: allPunct.comma * scale,
    exclamation: allPunct.exclamation * scale,
    question: allPunct.question * scale,
    ellipsis: allPunct.ellipsis * scale,
    colon: allPunct.colon * scale,
    semicolon: allPunct.semicolon * scale,
    dash: allPunct.dash * scale,
  };

  const mfw_top30: MfwEntry[] = [...tokenFreqs.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 30)
    .map(([word, count]) => ({ word, freq_per_1k: (count * 1000) / totalTokens }));

  return { length, vocab, punctuation_per_100w, mfw_top30 };
};

export type CompareVerdict = "pass" | "fail" | "skip";

export interface DimensionBreakdown {
  verdict: CompareVerdict;
  delta_relative: number | null;
  reply_value: number | null;
  profile_value: number | null;
}

export interface CompareResult {
  score: number | null; // pass / (pass + fail), null si aucune dim comparable
  breakdown: {
    length: DimensionBreakdown;
    punctuation: DimensionBreakdown;
    vocab: DimensionBreakdown;
  };
}

const TOLERANCE = 0.25; // 25 % d'écart relatif accepté par dimension.

// TTR (type/token ratio) décroît monotoniquement avec la taille du corpus :
// une reply de 30 mots aura toujours TTR ≈ 0.9 vs un corpus de 5000 msgs où
// TTR ≈ 0.04. La comparaison directe produit un faux fail systématique. On
// skip vocab tant que la reply est sous ce seuil (toutes les replies réelles
// le sont). Un fix propre passerait par MFW cosine similarity (Burrows-style).
const MIN_REPLY_WORDS_FOR_VOCAB = 200;

const compareScalar = (
  replyV: number | null | undefined,
  profileV: number | null | undefined,
): DimensionBreakdown => {
  if (
    replyV === null ||
    replyV === undefined ||
    profileV === null ||
    profileV === undefined ||
    !Number.isFinite(replyV) ||
    !Number.isFinite(profileV)
  ) {
    return {
      verdict: "skip",
      delta_relative: null,
      reply_value: replyV ?? null,
      profile_value: profileV ?? null,
    };
  }
  if (profileV === 0 && replyV === 0) {
    return {
      verdict: "pass",
      delta_relative: 0,
      reply_value: replyV,
      profile_value: profileV,
    };
  }
  if (profileV === 0) {
    return {
      verdict: "skip",
      delta_relative: null,
      reply_value: replyV,
      profile_value: profileV,
    };
  }
  const delta = Math.abs(replyV - profileV) / Math.abs(profileV);
  return {
    verdict: delta <= TOLERANCE ? "pass" : "fail",
    delta_relative: delta,
    reply_value: replyV,
    profile_value: profileV,
  };
};

// Distance L1 sur le vecteur ponctuation (per-100w) → compactée en delta_relative
// vs la "masse" du profil (somme des taux), pour rester sur la même échelle
// que les autres dimensions.
const comparePunctuation = (
  reply: PunctuationMetrics,
  profile: PunctuationMetrics,
): DimensionBreakdown => {
  const keys: (keyof PunctuationMetrics)[] = [
    "period",
    "comma",
    "exclamation",
    "question",
    "ellipsis",
    "colon",
    "semicolon",
    "dash",
  ];
  let l1 = 0;
  let profileMass = 0;
  let replyMass = 0;
  for (const k of keys) {
    l1 += Math.abs(reply[k] - profile[k]);
    profileMass += profile[k];
    replyMass += reply[k];
  }
  // P12: reply avec 0 token (empty/whitespace) ⇒ replyMass = 0 ⇒ l1 vaut
  // exactement la masse du profil ⇒ delta = 1.0 ⇒ toujours "fail". Pas un
  // signal stylométrique mais un signal d'absence — on skip.
  if (replyMass === 0 && profileMass > 0) {
    return {
      verdict: "skip",
      delta_relative: null,
      reply_value: 0,
      profile_value: profileMass,
    };
  }
  if (profileMass === 0 && l1 === 0) {
    return {
      verdict: "pass",
      delta_relative: 0,
      reply_value: 0,
      profile_value: 0,
    };
  }
  if (profileMass === 0) {
    return {
      verdict: "skip",
      delta_relative: null,
      reply_value: replyMass,
      profile_value: 0,
    };
  }
  const delta = l1 / profileMass;
  // `reply_value`/`profile_value` exposent les *masses* (densités totales par
  // 100 mots) — utiles pour l'UI ("16 marques / 100 mots"). Le `delta_relative`
  // reste la distance L1 normalisée sur la composition 8-marques : un total
  // similaire avec une répartition différente peut générer un gros delta —
  // c'est le signal qu'on veut. Le client doit communiquer cette nuance.
  return {
    verdict: delta <= TOLERANCE ? "pass" : "fail",
    delta_relative: delta,
    reply_value: replyMass,
    profile_value: profileMass,
  };
};

export const compareMetrics = (
  reply: StyleMetrics,
  profile: StyleMetrics,
): CompareResult => {
  const length = compareScalar(
    reply.length.msg_words_avg,
    profile.length.msg_words_avg,
  );
  const punctuation = comparePunctuation(
    reply.punctuation_per_100w,
    profile.punctuation_per_100w,
  );
  const replyWords = reply.length.msg_words_avg;
  const vocab: DimensionBreakdown =
    replyWords !== null && replyWords < MIN_REPLY_WORDS_FOR_VOCAB
      ? {
          verdict: "skip",
          delta_relative: null,
          reply_value: reply.vocab.ttr,
          profile_value: profile.vocab.ttr,
        }
      : compareScalar(reply.vocab.ttr, profile.vocab.ttr);

  const dims = [length, punctuation, vocab];
  const pass = dims.filter((d) => d.verdict === "pass").length;
  const fail = dims.filter((d) => d.verdict === "fail").length;
  const denom = pass + fail;
  return {
    score: denom > 0 ? pass / denom : null,
    breakdown: { length, punctuation, vocab },
  };
};
