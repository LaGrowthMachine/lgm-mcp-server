import { csvEscape, toCsvRow, CSV_BOM } from "./csv";

describe("csvEscape", () => {
  describe("RFC 4180 quoting", () => {
    test("field with comma is quoted", () => {
      expect(csvEscape("a,b")).toBe('"a,b"');
    });

    test("field with double quote is quoted and quote doubled", () => {
      expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    });

    test("field with newline is quoted", () => {
      expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    });

    test("field with carriage return is quoted", () => {
      // \r matches FORMULA_LEAD when it's the first char; here it's mid-field.
      expect(csvEscape("mid\rline")).toBe('"mid\rline"');
    });

    test("plain field is not quoted", () => {
      expect(csvEscape("hello")).toBe("hello");
    });

    test("empty string stays empty", () => {
      expect(csvEscape("")).toBe("");
    });
  });

  describe("formula injection defense", () => {
    test("= prefix is escaped", () => {
      expect(csvEscape("=SUM(1,2)")).toBe('"\'=SUM(1,2)"');
    });

    test("+ prefix is escaped", () => {
      expect(csvEscape("+1")).toBe("'+1");
    });

    test("- prefix is escaped", () => {
      expect(csvEscape("-1")).toBe("'-1");
    });

    test("@ prefix is escaped", () => {
      expect(csvEscape("@cmd")).toBe("'@cmd");
    });

    test("tab prefix is escaped", () => {
      expect(csvEscape("\tinjected")).toBe("'\tinjected");
    });

    test("carriage return prefix is escaped (then quoted since \\r remains)", () => {
      // After '-prefix the field still contains \r → triggers quoting.
      expect(csvEscape("\rinjected")).toBe('"\'\rinjected"');
    });

    test("apostrophe prefix passes through", () => {
      expect(csvEscape("'safe")).toBe("'safe");
    });
  });

  describe("null / undefined / numbers", () => {
    test("null → empty string", () => {
      expect(csvEscape(null)).toBe("");
    });

    test("undefined → empty string", () => {
      expect(csvEscape(undefined)).toBe("");
    });

    test("number is stringified", () => {
      expect(csvEscape(42)).toBe("42");
    });

    test("float is stringified", () => {
      expect(csvEscape(3.14)).toBe("3.14");
    });

    test("zero is preserved (not falsy-coerced to empty)", () => {
      expect(csvEscape(0)).toBe("0");
    });

    test("negative number is emitted as-is (no formula-injection prefix)", () => {
      // Sinon Excel lirait `-1` comme du texte et casserait SUM/AVG.
      expect(csvEscape(-1)).toBe("-1");
    });

    test("scientific notation float is emitted as-is", () => {
      expect(csvEscape(1e-7)).toBe("1e-7");
    });

    test("NaN → empty string", () => {
      expect(csvEscape(NaN)).toBe("");
    });

    test("Infinity → empty string", () => {
      expect(csvEscape(Infinity)).toBe("");
    });
  });
});

describe("toCsvRow", () => {
  test("joins cells with comma", () => {
    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  test("escapes each cell", () => {
    expect(toCsvRow(["hi", "a,b", '"x"'])).toBe('hi,"a,b","""x"""');
  });

  test("empty cells preserved", () => {
    expect(toCsvRow([null, "x", undefined])).toBe(",x,");
  });

  test("mixed types", () => {
    expect(toCsvRow(["text", 123, null, true])).toBe("text,123,,true");
  });

  test("multi-row scenario with \\r\\n line endings", () => {
    const header = toCsvRow(["id", "label", "value"]);
    const r1 = toCsvRow(["1", "hello", "world"]);
    const r2 = toCsvRow(["2", "=cmd", "a,b"]);
    const csv = CSV_BOM + [header, r1, r2].join("\r\n");
    expect(csv).toBe(
      CSV_BOM +
        "id,label,value" +
        "\r\n" +
        "1,hello,world" +
        "\r\n" +
        "2,'=cmd,\"a,b\"",
    );
  });
});
