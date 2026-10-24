import { describe, expect, test } from "bun:test";
import { CodexLatestResolutionError, compareVersionTuples, extractCatalogEntries, isLatestAlias, parseLatestAlias, parseVersionTuple, resolveLatestFamily } from "../src/codex-resolver";
import { AUTO_MODEL, candidatesFor } from "../src/proxy";
import { configFromEnv } from "../src/config";

const entry = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, display_name: slug, supported_reasoning_levels: [{ effort: "low" }], ...extra });

describe("latest alias parsing", () => {
  test("recognizes only the three documented family aliases", () => {
    expect(parseLatestAlias("luna:latest")).toBe("luna");
    expect(parseLatestAlias(" Sol:latest ")).toBe("sol");
    expect(parseLatestAlias("ASTRA:LATEST")).toBe("astra");
    expect(parseLatestAlias("gpt-6-luna")).toBeNull();
    expect(parseLatestAlias("terra:latest")).toBeNull();
    expect(parseLatestAlias("luna:6.10")).toBeNull();
    expect(isLatestAlias("sol:latest")).toBe(true);
    expect(isLatestAlias("chatgpt-6.1-sol")).toBe(false);
  });

  test("version tuples compare numerically, not lexicographically", () => {
    expect(parseVersionTuple("6.10")).toEqual([6, 10]);
    expect(compareVersionTuples([6, 10], [6, 9])).toBeGreaterThan(0);
    expect(compareVersionTuples([6, 1], [6, 1, 0])).toBe(0);
    expect(parseVersionTuple("six")).toBeUndefined();
  });
});

describe("resolveLatestFamily", () => {
  test("picks the numerically highest version (6.10 over 6.9)", () => {
    expect(resolveLatestFamily("luna", [entry("gpt-6.9-luna"), entry("gpt-6.10-luna"), entry("gpt-6.1-luna")])).toBe("gpt-6.10-luna");
  });

  test("resolves all three families independently", () => {
    const catalog = [entry("gpt-6.10-luna"), entry("gpt-6.9-sol"), entry("chatgpt-6.11-astra"), entry("gpt-6.1-sol")];
    expect(resolveLatestFamily("luna", catalog)).toBe("gpt-6.10-luna");
    expect(resolveLatestFamily("sol", catalog)).toBe("gpt-6.9-sol");
    expect(resolveLatestFamily("astra", catalog)).toBe("chatgpt-6.11-astra");
  });

  test("response order does not decide the winner", () => {
    expect(resolveLatestFamily("sol", [entry("gpt-6.10-sol"), entry("gpt-6.9-sol")])).toBe("gpt-6.10-sol");
    expect(resolveLatestFamily("sol", [entry("gpt-6.9-sol"), entry("gpt-6.10-sol")])).toBe("gpt-6.10-sol");
  });

  test("duplicate IDs are deduplicated", () => {
    expect(resolveLatestFamily("luna", [entry("gpt-6.10-luna"), entry("gpt-6.10-luna"), entry("gpt-6.9-luna")])).toBe("gpt-6.10-luna");
  });

  test("preview and unrelated variants are excluded", () => {
    expect(resolveLatestFamily("luna", [entry("gpt-6.11-luna-preview"), entry("gpt-6.9-luna"), entry("gpt-6.12-luna-mini")])).toBe("gpt-6.9-luna");
  });

  test("the virtual router model is never a candidate", () => {
    expect(() => resolveLatestFamily("luna", [entry(AUTO_MODEL)])).toThrow(CodexLatestResolutionError);
  });

  test("missing family fails instead of falling back", () => {
    let caught: unknown;
    try { resolveLatestFamily("astra", [entry("gpt-6.10-luna")]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodexLatestResolutionError);
    expect((caught as CodexLatestResolutionError).kind).toBe("missing");
    expect((caught as Error).message).toContain("astra");
  });

  test("a tie between distinct IDs at the highest version is ambiguous", () => {
    let caught: unknown;
    try { resolveLatestFamily("luna", [entry("gpt-6.10-luna"), entry("chatgpt-6.10-luna")]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodexLatestResolutionError);
    expect((caught as CodexLatestResolutionError).kind).toBe("ambiguous");
  });

  test("explicit family metadata works when the ID has no family suffix", () => {
    expect(resolveLatestFamily("luna", [entry("provider-luna-2026", { family: "luna", version: "2.1" }), entry("provider-luna-old", { family: "luna", version: "1.9" })])).toBe("provider-luna-2026");
  });

  test("an entry advertised as current wins over a higher unadvertised version", () => {
    expect(resolveLatestFamily("sol", [entry("gpt-6.10-sol"), entry("gpt-6.9-sol", { is_latest: true })])).toBe("gpt-6.9-sol");
  });

  test("two entries advertised as current are ambiguous", () => {
    expect(() => resolveLatestFamily("sol", [entry("gpt-6.10-sol", { is_latest: true }), entry("gpt-6.9-sol", { is_latest: true })])).toThrow(/advertised as current/);
  });

  test("a superseded entry is not latest when its successor is present", () => {
    expect(resolveLatestFamily("luna", [entry("gpt-6.10-luna", { successor: "gpt-6.9-luna" }), entry("gpt-6.9-luna")])).toBe("gpt-6.9-luna");
  });

  test("capabilities are not inferred from display names", () => {
    // A misleading display name on an unrelated ID must not make it a Luna.
    expect(() => resolveLatestFamily("luna", [entry("gpt-6.10-sol", { display_name: "Luna" })])).toThrow(CodexLatestResolutionError);
  });

  test("OpenAI-style id fields are accepted", () => {
    expect(resolveLatestFamily("luna", [{ id: "gpt-6.10-luna" }, { id: "gpt-6.9-luna" }])).toBe("gpt-6.10-luna");
  });
});

describe("extractCatalogEntries", () => {
  test("supports models, data, and array payloads and rejects malformed data", () => {
    expect(extractCatalogEntries({ models: [entry("gpt-6-luna")] })).toHaveLength(1);
    expect(extractCatalogEntries({ data: [{ id: "gpt-6-luna" }] })).toHaveLength(1);
    expect(extractCatalogEntries([entry("gpt-6-luna")])).toHaveLength(1);
    expect(extractCatalogEntries({ models: "nope" })).toEqual([]);
    expect(extractCatalogEntries(null)).toEqual([]);
    expect(extractCatalogEntries({ models: [null, "x", entry("gpt-6-luna")] })).toHaveLength(1);
  });
});

describe("candidatesFor with latest aliases", () => {
  const catalogOf = (models: Array<ReturnType<typeof entry> & Record<string, unknown>>) => new Map(models.map(model => [model.slug, model]));

  test("resolves alias tiers from the catalog with its metadata", () => {
    const config = configFromEnv({ CODING_ROUTER_FAST_MODEL_CODEX: "luna:latest", CODING_ROUTER_BALANCED_MODEL_CODEX: "sol:latest", CODING_ROUTER_STRONG_MODEL_CODEX: "sol:latest" });
    const catalog = catalogOf([
      { slug: "gpt-6.10-luna", display_name: "Luna", context_window: 200_000, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
      { slug: "gpt-6.9-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "high" }] },
    ]);
    const result = candidatesFor(config, catalog as never);
    expect(result.find(c => c.tier === "fast")).toMatchObject({ id: "gpt-6.10-luna", capacity: { contextWindow: 200_000 }, defaultEffort: "medium" });
    expect(result.find(c => c.tier === "balanced")!.id).toBe("gpt-6.9-sol");
    expect(result.map(c => c.id)).not.toContain("luna:latest");
  });

  test("a pinned resolution wins over a newer catalog entry", () => {
    const config = configFromEnv({ CODING_ROUTER_FAST_MODEL_CODEX: "luna:latest" });
    const catalog = catalogOf([entry("gpt-6.9-luna"), entry("gpt-6.10-luna")]);
    const result = candidatesFor(config, catalog as never, new Map([["luna", "gpt-6.9-luna"]]));
    expect(result.find(c => c.tier === "fast")!.id).toBe("gpt-6.9-luna");
  });

  test("disabled Long alias is not among candidates", () => {
    const config = configFromEnv({ CODING_ROUTER_LONG_MODEL_CODEX: "astra:latest" });
    expect(candidatesFor(config, new Map()).map(c => c.tier)).toEqual(["fast", "balanced", "strong"]);
  });
});
