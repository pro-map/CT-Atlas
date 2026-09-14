const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/shared.js','utf8').replace(/export /g,'');

function harness(){
 const c=vm.createContext({crypto,fetch:async()=>({}),TextEncoder,console});
 vm.runInContext(source,c);
 return vm.runInContext('({corsHeaders,isAllowedUser,passwordHashForUser,getAllowedUsers,matchesRegion})',c);
}

test('corsHeaders allows the primary ALLOWED_ORIGIN when the request comes from it',()=>{
 const h=harness();
 const headers=h.corsHeaders({ALLOWED_ORIGIN:'https://ct-atlas.com',__requestOrigin:'https://ct-atlas.com'});
 assert.equal(headers['Access-Control-Allow-Origin'],'https://ct-atlas.com');
});

test('corsHeaders reflects a mirror origin listed in EXTRA_ALLOWED_ORIGINS',()=>{
 const h=harness();
 const headers=h.corsHeaders({
  ALLOWED_ORIGIN:'https://ct-atlas.com',
  EXTRA_ALLOWED_ORIGINS:'https://ct-atlas-mirror.fairpeace.workers.dev',
  __requestOrigin:'https://ct-atlas-mirror.fairpeace.workers.dev'
 });
 assert.equal(headers['Access-Control-Allow-Origin'],'https://ct-atlas-mirror.fairpeace.workers.dev');
});

test('corsHeaders supports multiple comma-separated EXTRA_ALLOWED_ORIGINS entries',()=>{
 const h=harness();
 const env={ALLOWED_ORIGIN:'https://ct-atlas.com',EXTRA_ALLOWED_ORIGINS:'https://mirror-a.example, https://mirror-b.example'};
 assert.equal(h.corsHeaders({...env,__requestOrigin:'https://mirror-a.example'})['Access-Control-Allow-Origin'],'https://mirror-a.example');
 assert.equal(h.corsHeaders({...env,__requestOrigin:'https://mirror-b.example'})['Access-Control-Allow-Origin'],'https://mirror-b.example');
});

test('corsHeaders never reflects an origin that is not on the allowlist -- falls back to ALLOWED_ORIGIN, not to an arbitrary attacker origin',()=>{
 const h=harness();
 const headers=h.corsHeaders({
  ALLOWED_ORIGIN:'https://ct-atlas.com',
  EXTRA_ALLOWED_ORIGINS:'https://ct-atlas-mirror.fairpeace.workers.dev',
  __requestOrigin:'https://evil.example'
 });
 assert.equal(headers['Access-Control-Allow-Origin'],'https://ct-atlas.com','an unlisted Origin must never be reflected back');
});

test('corsHeaders handles a missing EXTRA_ALLOWED_ORIGINS and a missing __requestOrigin without throwing',()=>{
 const h=harness();
 assert.equal(h.corsHeaders({ALLOWED_ORIGIN:'https://ct-atlas.com'})['Access-Control-Allow-Origin'],'https://ct-atlas.com');
 assert.equal(h.corsHeaders({})['Access-Control-Allow-Origin'],'*','no ALLOWED_ORIGIN configured at all falls back to *, matching the pre-existing behaviour');
});


test('secret-backed auth uses only the configured roster',()=>{
 const h=harness();
 const hash='a'.repeat(64);
 const env={AUTH_USERS_JSON:JSON.stringify({analyst:hash})};
 assert.equal(h.isAllowedUser('analyst',env),true);
 assert.equal(h.isAllowedUser('group-i-1',env),false);
 assert.equal(h.passwordHashForUser('analyst',env),hash);
 assert.deepEqual(Array.from(h.getAllowedUsers(env)),['analyst']);
});


test('missing AUTH_USERS_JSON never activates the legacy roster',()=>{
 const h=harness();
 assert.equal(h.isAllowedUser('group-i-1',{}),false);
 assert.equal(h.passwordHashForUser('group-i-1',{}),'');
 assert.deepEqual(Array.from(h.getAllowedUsers({})),[]);
});

test('country filters accept ISO country codes and common frontend aliases',()=>{
 const h=harness();
 assert.equal(h.matchesRegion({country:'Republic of the Congo',country_code:'CG'},'Congo'),true);
 assert.equal(h.matchesRegion({country:'Democratic Republic of the Congo',country_code:'CD'},'Congo (Democratic Rep.)'),true);
 assert.equal(h.matchesRegion({country:'Czechia',country_code:'CZ'},'Czech Republic'),true);
 assert.equal(h.matchesRegion({country:'Côte d’Ivoire',country_code:'CI'},"Côte d'Ivoire"),true);
});
