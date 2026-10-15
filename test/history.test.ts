import { describe, expect, test } from "bun:test";
import { utimesSync, readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleLogs, sessionHistory, sanitizeRecord, REDACTED, REDACTED_ERROR } from "../src/history";

async function createFile(dir: string, name: string, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "test\n");
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
  return path;
}

const DAY_MS = 86_400_000;

describe("cleanupStaleLogs", () => {
  test("deletes old session logs beyond retention period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old-session.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-recent-session.jsonl", 1 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining).toEqual(["codex-recent-session.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves recent files within retention period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-a.jsonl", 2 * DAY_MS);
      await createFile(dir, "codex-b.jsonl", 3 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining.sort()).toEqual(["codex-a.jsonl", "codex-b.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("file just inside retention is preserved; file just outside is deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-inside.jsonl", 5 * DAY_MS - 60_000);
      await createFile(dir, "codex-outside.jsonl", 5 * DAY_MS + 60_000);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining).toContain("codex-inside.jsonl");
      expect(remaining).not.toContain("codex-outside.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores unrelated files and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "other-file.txt", 10 * DAY_MS);
      await createFile(dir, "notes.jsonl", 10 * DAY_MS);
      await mkdir(join(dir, "codex-subdir.jsonl"));

      cleanupStaleLogs(dir, 5);

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["codex-subdir.jsonl", "notes.jsonl", "other-file.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no-ops when directory does not exist", () => {
    expect(() => cleanupStaleLogs("/nonexistent/path/jev-test", 5)).not.toThrow();
  });

  test("no-ops when directory is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      expect(() => cleanupStaleLogs(dir, 5)).not.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("continues when individual file deletion fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-a.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-b.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-c.jsonl", 10 * DAY_MS);

      const immutable = join(dir, "codex-b.jsonl");
      const { chattr } = await (async () => {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`chattr +i "${immutable}"`, { stdio: "ignore" });
          return { chattr: true };
        } catch {
          return { chattr: false };
        }
      })();

      if (!chattr) {
        await chmod(join(dir, "codex-b.jsonl"), 0o000);
        await chmod(dir, 0o500);
      }

      cleanupStaleLogs(dir, 5);

      if (!chattr) {
        await chmod(dir, 0o700);
      } else {
        const { execSync } = await import("node:child_process");
        execSync(`chattr -i "${immutable}"`, { stdio: "ignore" });
      }

      const remaining = await readdir(dir);
      expect(remaining).toContain("codex-b.jsonl");
    } finally {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips cleanup for non-positive or invalid retentionDays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 100 * DAY_MS);

      cleanupStaleLogs(dir, 0);
      cleanupStaleLogs(dir, -5);
      cleanupStaleLogs(dir, NaN);

      const remaining = await readdir(dir);
      expect(remaining).toEqual(["codex-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pi agent cleanup deletes only pi-prefixed logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "pi-old-session.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-recent-session.jsonl", 1 * DAY_MS);
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5, "pi");

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["codex-old.jsonl", "pi-recent-session.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("codex agent cleanup does not delete pi-prefixed logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5, "codex");

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["pi-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default agent cleanup is codex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["pi-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionHistory", () => {
  test("startup cleanup recognizes unified logs for every agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      for (const agent of ["codex", "pi", "claude"] as const) {
        await createFile(dir, "jev-old.jsonl", 10 * DAY_MS);
        await createFile(dir, "jev-recent.jsonl", DAY_MS);
        cleanupStaleLogs(dir, 5, agent);
        expect(existsSync(join(dir, "jev-old.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "jev-recent.jsonl"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("creates unified log file for Pi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("test-session", dir, "pi");
      expect(hist.path).toContain("jev-test-session.jsonl");
      hist.append({ id: "test" });
      const content = readFileSync(hist.path, "utf-8");
      expect(content).toContain('"id":"test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates unified log file by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("test-session", dir);
      expect(hist.path).toContain("jev-test-session.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsupported agent prefix", () => {
    expect(() => sessionHistory("test", undefined, "other" as any)).toThrow("Unsupported agent prefix");
  });

  test("sanitizes session id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("../../../etc/passwd", dir, "pi");
      expect(hist.path).not.toContain("..");
      expect(hist.path).toContain("jev-etcpasswd.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeRecord", () => {

  const baseRecord = {
    id: "test-id",
    at: "2026-10-15T12:00:00Z",
    prompt: "my secret password is hunter2",
    jev: {
      request: {
        state: {
          request: "my secret password is hunter2",
          recent_context: {
            previous_user_request: "previous user text with apikey=abc123",
            previous_assistant_excerpt: "here is the token: sk-1234",
          },
        },
      },
      response: { answers: {} },
      ms: 42,
    },
    decision: { tier: "fast", reason: "jev/no-change", model: "gpt-6-luna", effort: "low" },
  };

  const notSensitive = (field: string) => ({
    [field]: { type: "choice", choice: "not_sensitive", confidence: 0.85 },
  });

  const sensitive = (field: string) => ({
    [field]: { type: "choice", choice: "sensitive", confidence: 0.95 },
  });

  test("sensitive current message redacts prompt and jev.request.state.request", () => {
    const classification = {
      ...sensitive("current_message_sensitive"),
      ...notSensitive("previous_user_message_sensitive"),
      ...notSensitive("previous_assistant_response_sensitive"),
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
    expect(result.jev.request.state.request).toBe(REDACTED);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(baseRecord.jev.request.state.recent_context.previous_user_request);
    expect(result.jev.request.state.recent_context.previous_assistant_excerpt).toBe(baseRecord.jev.request.state.recent_context.previous_assistant_excerpt);
  });

  test("not_sensitive with valid confidence preserves text", () => {
    const classification = {
      ...notSensitive("current_message_sensitive"),
      ...notSensitive("previous_user_message_sensitive"),
      ...notSensitive("previous_assistant_response_sensitive"),
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(baseRecord.prompt);
    expect(result.jev.request.state.request).toBe(baseRecord.jev.request.state.request);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(baseRecord.jev.request.state.recent_context.previous_user_request);
    expect(result.jev.request.state.recent_context.previous_assistant_excerpt).toBe(baseRecord.jev.request.state.recent_context.previous_assistant_excerpt);
  });

  test("low confidence below threshold redacts (fail closed)", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 0.2 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
    expect(result.jev.request.state.request).toBe(REDACTED);
  });

  test("missing classification redacts all fields (fail closed)", () => {
    const result = sanitizeRecord(baseRecord, undefined, 0.3);
    expect(result.prompt).toBe(REDACTED);
    expect(result.jev.request.state.request).toBe(REDACTED);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(REDACTED);
    expect(result.jev.request.state.recent_context.previous_assistant_excerpt).toBe(REDACTED);
  });

  test("invalid answer type redacts (fail closed)", () => {
    const classification = {
      current_message_sensitive: { type: "score", choice: "not_sensitive", confidence: 0.9 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
  });

  test("NaN confidence redacts (fail closed)", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: NaN },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
  });

  test("confidence > 1 redacts (fail closed)", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 1.5 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
  });

  test("absent prior fields stay absent", () => {
    const recordNoPrior = {
      ...baseRecord,
      jev: {
        ...baseRecord.jev,
        request: { state: { request: "hello" } },
      },
    };
    const result = sanitizeRecord(recordNoPrior, undefined, 0.3);
    expect(result.jev.request.state.recent_context).toBeUndefined();
  });

  test("error string is replaced with safe category", () => {
    const recordWithError = {
      ...baseRecord,
      jev: { ...baseRecord.jev, error: "Error processing: my secret password is hunter2" },
    };
    const classification = {
      ...notSensitive("current_message_sensitive"),
      ...notSensitive("previous_user_message_sensitive"),
      ...notSensitive("previous_assistant_response_sensitive"),
    };
    const result = sanitizeRecord(recordWithError, classification as any, 0.3);
    expect(result.jev.error).toBe(REDACTED_ERROR);
    expect(result.jev.error).not.toContain("hunter2");
  });

  test("original record is not mutated", () => {
    const original = JSON.parse(JSON.stringify(baseRecord));
    sanitizeRecord(baseRecord, undefined, 0.3);
    expect(baseRecord).toEqual(original);
  });

  test("decisions, timing, and cache data are preserved", () => {
    const recordWithCache = {
      ...baseRecord,
      cache: { window: "1h", observed_responses: 5 },
    };
    const result = sanitizeRecord(recordWithCache, undefined, 0.3);
    expect(result.decision).toEqual(baseRecord.decision);
    expect(result.jev.ms).toBe(42);
    expect(result.cache).toEqual({ window: "1h", observed_responses: 5 });
    expect(result.id).toBe("test-id");
    expect(result.at).toBe("2026-10-15T12:00:00Z");
  });

  test("independent redaction: current sensitive, previous not", () => {
    const classification = {
      ...sensitive("current_message_sensitive"),
      ...notSensitive("previous_user_message_sensitive"),
      ...notSensitive("previous_assistant_response_sensitive"),
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(baseRecord.jev.request.state.recent_context.previous_user_request);
  });

  test("independent redaction: previous user sensitive, current not", () => {
    const classification = {
      ...notSensitive("current_message_sensitive"),
      ...sensitive("previous_user_message_sensitive"),
      ...notSensitive("previous_assistant_response_sensitive"),
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(baseRecord.prompt);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(REDACTED);
  });

  test("append with classification sanitizes before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-sanitize-test-"));
    try {
      const hist = sessionHistory("sanitize-test", dir);
      const classification = {
        current_message_sensitive: { type: "choice", choice: "sensitive", confidence: 0.95 },
      };
      hist.append(baseRecord, classification as any, 0.3);
      const content = readFileSync(hist.path, "utf-8");
      const written = JSON.parse(content.trim());
      expect(written.prompt).toBe(REDACTED);
      expect(written.jev.request.state.request).toBe(REDACTED);
      expect(written.decision).toEqual(baseRecord.decision);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("append without classification writes record unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-nosani-test-"));
    try {
      const hist = sessionHistory("nosani-test", dir);
      hist.append(baseRecord);
      const content = readFileSync(hist.path, "utf-8");
      const written = JSON.parse(content.trim());
      expect(written.prompt).toBe(baseRecord.prompt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exact confidence boundary (confidence === minConfidence) preserves text", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 0.3 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(baseRecord.prompt);
    expect(result.jev.request.state.request).toBe(baseRecord.jev.request.state.request);
  });

  test("confidence just below threshold redacts", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 0.29 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(REDACTED);
  });

  test("independent redaction: previous assistant sensitive only", () => {
    const classification = {
      current_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 0.85 },
      previous_user_message_sensitive: { type: "choice", choice: "not_sensitive", confidence: 0.85 },
      previous_assistant_response_sensitive: { type: "choice", choice: "sensitive", confidence: 0.95 },
    };
    const result = sanitizeRecord(baseRecord, classification as any, 0.3);
    expect(result.prompt).toBe(baseRecord.prompt);
    expect(result.jev.request.state.recent_context.previous_user_request).toBe(baseRecord.jev.request.state.recent_context.previous_user_request);
    expect(result.jev.request.state.recent_context.previous_assistant_excerpt).toBe(REDACTED);
  });
});
