const {test}=require("node:test");
const assert=require("node:assert/strict");
const {cases,wallet,native,usdt,a,DAY,MIN}=require("./fixtures/crypto-risk/cases.cjs");

const risk=import("../cloudflare-worker/crypto-risk.mjs");
const scoring=result=>result.findings.filter(item=>item.points>0);
const codes=result=>result.findings.map(item=>item.code);
const find=(name)=>cases.find(item=>item.name.startsWith(name));

for(const item of cases){
  test("fixture: "+item.name,async()=>{
    const {assessWallet}=await risk;
    const result=assessWallet(item.analysis,item.ctx);
    const seen=codes(result).join(", ");
    assert.ok(item.labels.includes(result.label),result.label+" "+result.score+" ["+seen+"]");
    for(const code of item.codes)assert.ok(codes(result).includes(code),"missing "+code+" in ["+seen+"]");
    for(const code of item.absent||[])assert.ok(!codes(result).includes(code),"unexpected "+code+" in ["+seen+"]");
    if(!item.codes.length&&!item.scoring)assert.equal(scoring(result).length,0,"a benign shape scored: "+seen);
    if(item.score!==undefined)assert.equal(result.score,item.score);
  });
}

test("row order never changes what is found",async()=>{
  const {assessWallet}=await risk;
  for(const item of cases){
    const shuffled={...item.analysis,transactions:[...item.analysis.transactions].reverse()};
    assert.deepEqual(codes(assessWallet(shuffled,item.ctx)),codes(assessWallet(item.analysis,item.ctx)),item.name);
  }
});

test("the same input and the same time give the same output",async()=>{
  const {assessWallet}=await risk;
  const now=Date.parse("2026-11-05T12:00:00Z");
  for(const item of cases){
    assert.deepEqual(assessWallet(item.analysis,{...item.ctx,now}),assessWallet(structuredClone(item.analysis),{...item.ctx,now}),item.name);
  }
});

test("scaling one asset leaves another asset's finding unchanged",async()=>{
  const {assessWallet}=await risk;
  const mule=find("mule").analysis;
  const before=assessWallet(mule).findings.find(item=>item.code==="RAPID_PASS_THROUGH");
  const extra=mule.transactions.slice(0,4).map(row=>({...row,id:row.id+"b",asset:"SHIB",asset_key:"0x5",token_contract:"0x5",stable:false,amount:row.amount*1e6}));
  const after=assessWallet({...mule,transactions:[...mule.transactions,...extra]}).findings.find(item=>item.code==="RAPID_PASS_THROUGH");
  assert.deepEqual(after.metrics,before.metrics);
});

test("value never pairs across assets: USDT in and ETH out is not a pass-through",async()=>{
  const {assessWallet}=await risk;
  const rows=[];
  for(let i=0;i<5;i++){
    rows.push(usdt(i*DAY,"IN",2000,a(10+i)));
    rows.push(native(i*DAY+5*MIN,"OUT",1800,a(20+i)));
  }
  assert.ok(!codes(assessWallet(wallet(rows))).includes("RAPID_PASS_THROUGH"));
});

test("the two old false positives are gone: two small transfers and failed sends",async()=>{
  const {assessWallet}=await risk;
  const small=assessWallet(wallet([usdt(0,"IN",5,a(10)),usdt(24*DAY,"OUT",5,a(11))]));
  assert.equal(small.label,"NOT_ASSESSED");
  assert.equal(scoring(small).length,0);
});

test("every scoring finding carries benign explanations, and transaction ids where rows exist",async()=>{
  const {assessWallet}=await risk;
  for(const item of cases){
    for(const entry of assessWallet(item.analysis,item.ctx).findings){
      assert.ok(entry.title&&entry.explanation,entry.code);
      assert.ok(Array.isArray(entry.benign)&&entry.benign.length>0,entry.code);
      assert.ok(entry.tx_ids.length<=12,entry.code);
      if(entry.points>0&&entry.code!=="LISTED_WALLET")assert.ok(entry.tx_ids.length>0,item.name+" "+entry.code);
    }
  }
});

test("a direct link to a listed entity gives HIGH with the incidental payment note",async()=>{
  const {assessWallet}=await risk;
  for(const name of ["sent funds to a terrorism","real value received","a listed exchange that is not"]){
    const item=find(name);
    const entry=assessWallet(item.analysis,item.ctx).findings.find(found=>found.code==="DIRECT_SANCTIONS_EXPOSURE");
    assert.equal(entry.floor,"HIGH");
    assert.ok(entry.benign.some(text=>/incidental payment/.test(text)),name);
  }
  const terror=assessWallet(find("sent funds to a terrorism").analysis).findings[0];
  const other=assessWallet(find("a listed exchange that is not").analysis).findings[0];
  assert.equal(terror.points,70);
  assert.equal(other.points,60);
  assert.equal(terror.metrics.terrorism_program,true);
});

test("a failed send to a listed address states that no value moved",async()=>{
  const {assessWallet}=await risk;
  const entry=assessWallet(find("a failed send").analysis).findings.find(item=>item.code==="DIRECT_SANCTIONS_EXPOSURE");
  assert.equal(entry.metrics.no_value_moved,true);
});

test("a co-input link is named for what it is, and points at the transaction that made it",async()=>{
  const {assessWallet}=await risk;
  const item=find("spent in one transaction");
  const entry=assessWallet(item.analysis).findings[0];
  assert.match(entry.title,/Spent in one transaction/);
  assert.equal(entry.metrics.spent_with,1);
  assert.ok(entry.benign.some(text=>/CoinJoin/.test(text)));
  assert.deepEqual(entry.tx_ids,[item.analysis.transactions[1].id]);
  assert.ok(entry.window,"the link must come from the row, not only from the screening match");
});

test("the rules read the full party list, not the 12 the response displays",async()=>{
  const {assessWallet}=await risk;
  const listedOutput=find("a listed output past the display cap");
  const entry=assessWallet(listedOutput.analysis).findings[0];
  assert.deepEqual(entry.tx_ids,[listedOutput.analysis.transactions[1].id]);
  const fanOut=assessWallet(find("receivers past the display cap").analysis).findings.find(item=>item.code==="FAN_OUT");
  assert.equal(fanOut.metrics.receivers,18);
  assert.equal(fanOut.strength,"strong");
});

test("mixer exposure reports the direction of funds, and names the service",async()=>{
  const {assessWallet}=await risk;
  const inbound=find("funds received from a labelled mixer");
  const metrics=assessWallet(inbound.analysis,inbound.ctx).findings.find(item=>item.code==="DIRECT_MIXER_EXPOSURE").metrics;
  assert.equal(metrics.funds_from,1);
  assert.equal(metrics.funds_to,0);
  assert.deepEqual(metrics.services,["Synthetic mixer"]);
  const pool=assessWallet(find("withdrawal from a Tornado").analysis).findings.find(item=>item.code==="DIRECT_MIXER_EXPOSURE");
  assert.deepEqual(pool.metrics.services,["Tornado.Cash: 10 ETH"]);
  assert.ok(pool.benign.some(text=>/not on the current sanctions list/.test(text)));
});

test("finding text stays neutral: banned words never appear in generated wording",async()=>{
  const {assessWallet}=await risk;
  const banned=/\b(?:proves?|proven|confirmed|launder(?:s|ed|ing)?|criminal|terrorists?)\b/i;
  for(const item of cases){
    const result=assessWallet(item.analysis,item.ctx);
    const words=[
      ...result.reasons,
      ...result.not_evaluated.map(entry=>entry.reason),
      ...result.findings.flatMap(entry=>[entry.title,entry.explanation,...entry.benign,entry.needs_trace||""])
    ].join(" | ");
    assert.doesNotMatch(words,banned,item.name);
  }
});

test("LOW never appears when screening did not run",async()=>{
  const {assessWallet}=await risk;
  for(const item of cases){
    const unscreened={...item.analysis,sanctions_screening:{status:"unavailable",hit:false,counterparty_matches:[]}};
    assert.notEqual(assessWallet(unscreened,item.ctx).label,"LOW",item.name);
  }
});

test("behaviour alone reaches HIGH only with three strong families",async()=>{
  const {assessWallet,THRESHOLDS}=await risk;
  for(const item of cases){
    const result=assessWallet(item.analysis,item.ctx);
    if(result.label!=="HIGH"||result.findings.some(entry=>entry.floor==="HIGH"))continue;
    const families=new Set(result.findings.filter(entry=>entry.strength==="strong"&&entry.family!=="EXPOSURE").map(entry=>entry.family));
    const exposure=result.findings.filter(entry=>entry.family==="EXPOSURE").reduce((total,entry)=>total+entry.points,0);
    if(!exposure)assert.ok(families.size>=THRESHOLDS.strong_families_for_high,item.name);
  }
  const three=find("three independent strong");
  assert.equal(assessWallet(three.analysis).findings.some(entry=>entry.floor),false);
  assert.equal(assessWallet(three.analysis).label,"HIGH");
});

test("the service discount lowers behaviour and leaves exposure alone",async()=>{
  const {assessWallet}=await risk;
  const mule=find("mule").analysis;
  const plain=assessWallet(mule);
  const service=assessWallet(mule,{exchangeBehavior:{status:"sourced_match"}});
  assert.equal(plain.service_discount,false);
  assert.equal(service.service_discount,true);
  assert.ok(service.score<plain.score);
  const listedWallet=find("sent funds to a terrorism").analysis;
  assert.equal(assessWallet(listedWallet,{exchangeBehavior:{status:"sourced_match"}}).label,"HIGH");
});

test("the assessment has the agreed shape and says its thresholds are provisional",async()=>{
  const {assessWallet,DISCLAIMER}=await risk;
  const result=assessWallet(find("mule").analysis,{now:Date.parse("2026-11-05T12:00:00Z")});
  for(const key of ["version","label","score","thresholds","service_discount","reasons","findings","not_evaluated","coverage","disclaimer"]){
    assert.ok(key in result,key);
  }
  for(const key of ["rows","oldest","newest","complete","lifetime_tx_count","partial"])assert.ok(key in result.coverage,key);
  assert.equal(result.thresholds.elevated,25);
  assert.equal(result.thresholds.high,60);
  assert.equal(result.thresholds.provisional,true);
  assert.match(result.thresholds.note,/synthetic data only/);
  assert.equal(result.disclaimer,DISCLAIMER);
  assert.match(DISCLAIMER,/^Indicator, not proof\./);
  assert.equal(result.assessed_at,"2026-11-05T12:00:00.000Z");
});

test("rules not evaluated are listed with a reason, including native assets",async()=>{
  const {assessWallet}=await risk;
  const notes=name=>assessWallet(find(name).analysis);
  const structuring=notes("mule").not_evaluated.find(item=>item.code==="STRUCTURING_BAND");
  assert.match(structuring.reason,/native assets not evaluated/);
  const bitcoinNotes=notes("a 25-row Bitcoin").not_evaluated;
  assert.match(bitcoinNotes.find(item=>item.code==="STRUCTURING_BAND").reason,/No stablecoin contract.*native assets not evaluated/);
  assert.ok(bitcoinNotes.some(item=>item.code==="PEEL_STEP"));
  assert.ok(notes("mule").not_evaluated.some(item=>item.code==="ONE_HOP_EXPOSURE"));
  assert.ok(notes("three transfers only").not_evaluated.some(item=>item.code==="BEHAVIOUR_RULES"));
  assert.ok(notes("quiet wallet but sanctions").not_evaluated.some(item=>item.code==="SANCTIONS_SCREENING"));
  assert.ok(notes("a provider failed").not_evaluated.some(item=>item.code==="PARTIAL_HISTORY"));
});

test("excluded rows are counted, so the coverage line can say what was left out",async()=>{
  const {assessWallet}=await risk;
  const failed=assessWallet(find("six failed sends").analysis).coverage;
  assert.equal(failed.excluded.failed,6);
  assert.equal(failed.usable_rows,5);
  assert.equal(failed.rows,11);
  assert.equal(assessWallet(find("airdrop spam").analysis).coverage.excluded.zero_value,30);
});

test("a dormancy finding says when it only saw the sample",async()=>{
  const {assessWallet}=await risk;
  const entry=assessWallet(find("dormancy then").analysis).findings.find(item=>item.code==="DORMANT_THEN_BURST");
  assert.match(entry.explanation,/Only gaps inside the sample/);
  assert.equal(entry.metrics.sample_complete,false);
});

test("the stablecoin allow-list matches by contract, never by symbol",async()=>{
  const {isStablecoin}=await risk;
  assert.equal(isStablecoin("ethereum","0xDAC17F958D2EE523A2206206994597C13D831EC7"),true);
  assert.equal(isStablecoin("tron","TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),true);
  assert.equal(isStablecoin("polygon","0xdac17f958d2ee523a2206206994597c13d831ec7"),false,"a contract only counts on its own chain");
  assert.equal(isStablecoin("ethereum","0x0000000000000000000000000000000000000001"),false);
  assert.equal(isStablecoin("bsc","0x55d398326f99059ff775485246999027b3197955"),false,"unverified contracts stay out");
});

test("the older response fields are a reading of the assessment",async()=>{
  const {assessWallet,derivePatterns,deriveAlertSummary}=await risk;
  const high=assessWallet(find("sent funds to a terrorism").analysis);
  const patterns=derivePatterns(high);
  assert.equal(patterns[0].code,"DIRECT_SANCTIONS_EXPOSURE");
  assert.equal(patterns[0].severity,"HIGH");
  assert.match(patterns[0].explanation,/does not establish/);
  assert.deepEqual(deriveAlertSummary(high),{highest_severity:"HIGH",highest_score:high.score,total:scoring(high).length});
  const elevated=assessWallet(find("mule").analysis);
  assert.equal(deriveAlertSummary(elevated).highest_severity,"MEDIUM");
  assert.equal(deriveAlertSummary(assessWallet(find("three transfers only").analysis)).highest_severity,"LOW");
  assert.equal(derivePatterns(assessWallet(find("three transfers only").analysis)).length,0);
});
