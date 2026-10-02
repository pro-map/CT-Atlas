"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let modulePromise;
function loadShared() {
  if (!modulePromise) {
    const source = fs.readFileSync(path.join(__dirname, "../cloudflare-worker/shared.js"), "utf8");
    modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }
  return modulePromise;
}

function mockResponse(status, payload = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async json() { return payload; },
    async text() { return typeof payload === "string" ? payload : JSON.stringify(payload); }
  };
}

function successResponse() {
  return mockResponse(200, {
    output_text: JSON.stringify({ title: "Report", analysis: "Generated report." })
  });
}

async function withGeminiMocks(responses, run) {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalRandom = Math.random;
  const calls = [];
  const delays = [];
  let responseIndex = 0;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body).model);
    const response = responses[Math.min(responseIndex, responses.length - 1)];
    responseIndex += 1;
    return response;
  };
  globalThis.setTimeout = (callback, ms) => {
    delays.push(ms);
    queueMicrotask(callback);
    return 1;
  };
  Math.random = () => 0.5;
  try {
    return await run({ calls, delays });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    Math.random = originalRandom;
  }
}

const ENV = {
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  GEMINI_FALLBACK_MODEL: "gemini-3.6-flash",
  GEMINI_API_KEY: "test-key"
};

test("a Gemini 503 on configured 3.6 falls back to 3.5 Flash Lite", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks([mockResponse(503), successResponse()], async ({ calls }) => {
    const result = await callGemini(
      { GEMINI_MODEL: "gemini-3.6-flash", GEMINI_API_KEY: "test-key" },
      { sample: true }
    );
    assert.deepEqual(calls, ["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    assert.equal(result.analysis, "Generated report.");
  });
});

test("transient failures rotate through the three models with exponential backoff", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks(
    [mockResponse(503), mockResponse(503), mockResponse(503), successResponse()],
    async ({ calls, delays }) => {
      await callGemini(ENV, {});
      assert.deepEqual(calls, [
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite"
      ]);
      assert.deepEqual(delays, [1000, 2000, 4000]);
    }
  );
});

test("a model that answers 429 is skipped while another model remains", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks(
    [mockResponse(429), mockResponse(503), mockResponse(503), successResponse()],
    async ({ calls }) => {
      await callGemini(ENV, {});
      assert.deepEqual(calls, [
        "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
        "gemini-3.1-flash-lite",
        "gemini-3.6-flash"
      ]);
    }
  );
});

test("with the primary and 3.6 Flash out of quota, 3.1 Flash Lite answers", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks(
    [mockResponse(429), mockResponse(429), successResponse()],
    async ({ calls }) => {
      const result = await callGemini(ENV, {});
      assert.deepEqual(calls, ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash-lite"]);
      assert.equal(result.analysis, "Generated report.");
    }
  );
});

test("Retry-After is honored and capped at eight seconds", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks(
    [mockResponse(503, {}, { "retry-after": "30" }), successResponse()],
    async ({ delays }) => {
      await callGemini(ENV, {});
      assert.deepEqual(delays, [8000]);
    }
  );
});

test("final failed attempt does not add an unnecessary wait", async () => {
  const { callGemini } = await loadShared();
  await withGeminiMocks([mockResponse(503)], async ({ calls, delays }) => {
    await assert.rejects(callGemini(ENV, {}), /Gemini temporary error 503 on gemini-3\.6-flash/);
    assert.deepEqual(calls, [
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash"
    ]);
    assert.equal(delays.length, 4);
  });
});

test("the rotation goes back to every model once all have answered 429", async () => {
  const { geminiModelRotation } = await loadShared();
  const rotation = geminiModelRotation(["a", "b", "a", "", "c"]);
  assert.deepEqual([rotation.next(), rotation.next(), rotation.next()], ["a", "b", "c"]);
  rotation.spent("a");
  rotation.spent("c");
  assert.deepEqual([rotation.next(), rotation.next()], ["b", "b"]);
  rotation.spent("b");
  assert.deepEqual([rotation.next(), rotation.next()], ["c", "a"]);
});
