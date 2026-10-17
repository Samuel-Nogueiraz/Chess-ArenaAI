import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../src/index.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("@arena/core", () => {
  it("não importa nada de node:* nem de pacotes do servidor", () => {
    const files = readdirSync(src).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length >= 11);
    for (const name of files) {
      const text = readFileSync(join(src, name), "utf8");
      assert.doesNotMatch(text, /from\s+["']node:/, `${name} importa node:*`);
      assert.doesNotMatch(text, /require\(/, `${name} usa require`);
      assert.doesNotMatch(text, /process\.env/, `${name} lê process.env`);
    }
  });

  it("exporta a API que a web e o servidor usam", () => {
    for (const name of [
      "createSessionStore",
      "createDemoAdapter",
      "DEMO_MODELS",
      "createHeuristicEngine",
      "analyzeGame",
      "buildMovePrompt",
      "buildCorrection",
      "parseMoveId",
      "isProviderId",
      "sumCosts",
      "sanitize",
      "SCENARIOS",
    ]) {
      assert.ok(name in core, `falta ${name}`);
    }
  });

  it("provedores aceitos são exatamente os cinco ids", () => {
    assert.deepEqual([...core.PROVIDER_IDS], ["demo", "jev", "cursor", "cli", "openai"]);
    assert.equal(core.isProviderId("typesafe"), false);
    assert.equal(core.isProviderId("jev"), true);
  });
});
