const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const html=fs.readFileSync('index.html','utf8');

test('frontend authentication does not ship a password-hash table',()=>{
  assert.doesNotMatch(html,/const\s+USERS\s*=\s*\{/);
  assert.doesNotMatch(html,/candidateHash\s*===\s*expectedHash/);
  assert.match(html,/\/auth-login/);
  assert.match(html,/\/session-check/);
});

test('frontend report identity comes from the authenticated session',()=>{
  assert.match(html,/sessionStorage\.getItem\(["']ct_map_username["']\)/);
  assert.doesNotMatch(html,/ct_report_generator_user_id/);
});
