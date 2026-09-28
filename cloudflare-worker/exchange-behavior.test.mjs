import test from "node:test";
import assert from "node:assert/strict";
import { detectExchangeBehavior } from "./exchange-behavior.mjs";

const hexAddress = value => "0x" + Number(value).toString(16).padStart(40, "0");

function highThroughputAnalysis(address = hexAddress(999)) {
  const assets = ["ETH", "USDT", "USDC", "DAI"];
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  return {
    kind: "address",
    chain: "ethereum",
    query: address,
    transactions: Array.from({ length: 100 }, (_, index) => ({
      id: "tx-" + index,
      time: new Date(now - (index % 20) * 86400000 - Math.floor(index / 20) * 3600000).toISOString(),
      direction: index % 2 ? "OUT" : "IN",
      asset: assets[index % assets.length],
      amount: 1,
      counterparties: [hexAddress(index % 30 + 1)]
    }))
  };
}

test("surfaces an exchange-like hub only after the configured 80/100 threshold", () => {
  const result = detectExchangeBehavior(highThroughputAnalysis());
  assert.equal(result.status, "behavioral_candidate");
  assert.equal(result.candidate, true);
  assert.ok(result.score >= 80);
  assert.match(result.limitations, /not a calibrated probability/i);
});

test("does not surface a small or weakly connected sample as an exchange", () => {
  const analysis = highThroughputAnalysis();
  analysis.transactions = analysis.transactions.slice(0, 18).map(row => ({
    ...row,
    counterparties: [hexAddress(1)]
  }));
  const result = detectExchangeBehavior(analysis);
  assert.equal(result.status, "below_threshold");
  assert.equal(result.candidate, false);
  assert.ok(result.score < 80);
});

test("preserves an exact source-backed exchange label separately from behaviour scoring", () => {
  const analysis = highThroughputAnalysis(hexAddress(1));
  const result = detectExchangeBehavior(analysis, [{
    chain: "ethereum",
    address: hexAddress(1).toUpperCase().replace("0X", "0x"),
    name: "Binance",
    category: "EXCHANGE",
    confidence: "MEDIUM",
    source_title: "Official reserve disclosure",
    source_url: "https://example.org/source"
  }]);
  assert.equal(result.status, "sourced_match");
  assert.equal(result.exchange_name, "Binance");
  assert.equal(result.source_confidence, "MEDIUM");
});

test("reports repeated links to a named exchange without claiming common ownership", () => {
  const analysis = highThroughputAnalysis();
  const exchangeWallets = [hexAddress(1), hexAddress(2)];
  analysis.transactions.forEach((row, index) => {
    if (index < 6) row.counterparties = [exchangeWallets[index % exchangeWallets.length]];
  });
  const result = detectExchangeBehavior(analysis, exchangeWallets.map(address => ({
    chain: "ethereum",
    address,
    name: "Binance",
    category: "EXCHANGE",
    source_title: "Official exchange disclosure"
  })));
  assert.equal(result.status, "behavioral_candidate");
  assert.equal(result.related_exchange.name, "Binance");
  assert.equal(result.related_exchange.labelled_wallets, 2);
  assert.match(result.limitations, /does not prove exchange identity, control, custody, or common ownership/i);
});

test("does not score transaction-only lookups as wallet behaviour", () => {
  const result = detectExchangeBehavior({ kind: "transaction", chain: "ethereum", query: "0xabc" });
  assert.equal(result.status, "not_assessed");
  assert.equal(result.candidate, false);
});
