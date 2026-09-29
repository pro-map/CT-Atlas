// Completes a feature that was clearly designed but never wired up: usage-admin.css already
// shipped a #adminUsageSummary grid (4 .admin-usage-metric boxes) with no HTML using it, and an
// old local build of usage-admin.js (_pages_mirror/, not in git) shows how it was meant to be
// populated. This restores it at the top of the admin usage panel -- above the tables, right
// under the TODAY/7 DAYS/30 DAYS/ALL TIME period bar -- so the admin can see active-user and
// activity counts for whichever period is selected without scrolling to the tables.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

const client=fs.readFileSync("usage-admin.js","utf8");
const css=fs.readFileSync("usage-admin.css","utf8");

test("the summary strip sits between the period bar and the status line, with the 4 designed metrics",()=>{
  const periodsEnd=client.indexOf('data-period="all">ALL TIME</button>');
  const summaryStart=client.indexOf('id="adminUsageSummary"');
  const statusStart=client.indexOf('id="adminUsageStatus"');
  assert.ok(periodsEnd!==-1&&summaryStart!==-1&&statusStart!==-1,"missing one of the three anchor elements");
  assert.ok(periodsEnd<summaryStart,"the summary strip must come after the period buttons");
  assert.ok(summaryStart<statusStart,"the summary strip must come before the status line (i.e. above the tables)");

  const block=client.slice(summaryStart,statusStart);
  for(const [id,label] of [
    ["adminActiveUsers","ACTIVE USERS"],
    ["adminSearches","SEARCHES"],
    ["adminReportRequests","REPORT REQUESTS"],
    ["adminAiReports","AI REPORTS"]
  ]){
    assert.ok(block.includes('<span>'+label+'</span>'),"missing label "+label);
    assert.ok(block.includes('id="'+id+'"'),"missing metric element "+id);
  }
});

test("loadAdmin populates all 4 metrics from usagePayload.summary for the currently selected period",()=>{
  const fnStart=client.indexOf("async function loadAdmin");
  assert.ok(fnStart!==-1);
  const fnBody=client.slice(fnStart,client.indexOf("\ndocument.addEventListener",fnStart));
  assert.ok(fnBody.includes("usagePayload.summary"));
  for(const [id,field] of [
    ["adminActiveUsers","active_users"],
    ["adminSearches","searches"],
    ["adminReportRequests","report_requests"],
    ["adminAiReports","reports_generated"]
  ]){
    assert.ok(fnBody.includes('setMetric("'+id+'",summary.'+field+')'),"missing wiring for "+id+" <- summary."+field);
  }
  // Regression guard: on a failed fetch, stale numbers from a previous period must not linger.
  assert.ok(/catch\(error\)\{[\s\S]*adminActiveUsers[\s\S]*\}/.test(fnBody),"the error path must reset the summary metrics, not leave a previous period's numbers on screen");
});

test("usage-admin.css already ships the 4-column summary grid this strip relies on",()=>{
  assert.ok(css.includes("#adminUsageSummary{display:grid"));
  assert.ok(css.includes(".admin-usage-metric{"));
});
