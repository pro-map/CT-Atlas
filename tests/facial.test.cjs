const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");

test("Facial Intelligence requires an explicit lawful-basis consent checkbox before analysis runs",()=>{
  const html=fs.readFileSync("facial.html","utf8");
  const js=fs.readFileSync("facial.js","utf8");
  assert.ok(html.includes('id="fiConsent"'),"the form must render a consent checkbox");
  assert.match(html,/lawful basis/i,"the consent copy must name the lawful-basis requirement");
  assert.ok(js.includes('$("fiConsent").checked'),"submission must check the consent checkbox state");
  // The consent check must run before the network request, not after.
  const consentIndex=js.indexOf('$("fiConsent").checked');
  const fetchIndex=js.indexOf("visual-analyze");
  assert.ok(consentIndex>-1 && fetchIndex>-1 && consentIndex<fetchIndex,
    "consent must be verified before the analysis request is sent");
});

test("Facial Intelligence discloses a retention statement for uploaded media",()=>{
  const html=fs.readFileSync("facial.html","utf8");
  assert.match(html,/RETENTION/i);
  assert.match(html,/not stored/i);
});
