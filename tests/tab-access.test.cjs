const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('cloudflare-worker/report-gate.js','utf8')
 .replace(/^import[\s\S]*?from\s*["']\.\/shared\.js["'];\s*/,'')
 .replace('export class ReportGate','class ReportGate')+'\nglobalThis.__ReportGate=ReportGate;';

function harness(){
 const values=new Map();
 const storage={
  async get(key){
   if(Array.isArray(key)){
    const result=new Map();
    for(const item of key)if(values.has(item))result.set(item,values.get(item));
    return result;
   }
   return values.get(key);
  },
  async put(entries){for(const [key,value] of Object.entries(entries))values.set(key,value);},
  async transaction(callback){return callback(storage);},
  values
 };
 const context=vm.createContext({
  getAllowedUsers:env=>new Set(env.users),
  normalizeUsername:value=>String(value||'').trim().toLowerCase(),
  isAllowedUser:(username,env)=>env.users.includes(username),
  parisDayKey:value=>new Date(value).toISOString().slice(0,10),
  usageTemplate:username=>({username})
 });
 vm.runInContext(source,context);
 const ReportGate=context.__ReportGate;
 return {gate:new ReportGate({storage},{users:['admin','group-i-1','group-p-1']}),storage};
}

test('tab access stats count only the five workspace opens per user and period',async()=>{
 const {gate}=harness();
 const now=Date.UTC(2026,8,28,12);
 await gate.recordTabAccess('group-i-1','crypto',now);
 await gate.recordTabAccess('group-i-1','crypto',now);
 await gate.recordTabAccess('group-i-1','map',now);
 await gate.recordTabAccess('group-i-1','darkweb',now);
 await gate.recordTabAccess('group-i-1','social',now-86400000);
 await gate.recordTabAccess('group-p-1','facial',now);

 const today=await gate.tabAccessStats('today',now);
 const analyst=today.users.find(row=>row.username==='group-i-1');
 const second=today.users.find(row=>row.username==='group-p-1');
 assert.deepEqual(
  {crypto:analyst.crypto,facial:analyst.facial,map:analyst.map,social:analyst.social},
  {crypto:2,facial:0,map:1,social:0}
 );
 assert.equal(second.facial,1);
 assert.equal(analyst.darkweb,1);
 assert.equal(today.users.length,3);
 assert.equal(Object.keys(analyst).some(key=>['searches','logins','report_requests'].includes(key)),false);

 const lastSevenDays=await gate.tabAccessStats('7',now);
 assert.equal(lastSevenDays.users.find(row=>row.username==='group-i-1').social,1);
 const allTime=await gate.tabAccessStats('all',now);
 assert.equal(allTime.users.find(row=>row.username==='group-i-1').crypto,2);
});

test('tab access rejects values outside the five known workspaces',async()=>{
 const {gate,storage}=harness();
 const result=await gate.recordTabAccess('group-i-1','other',Date.UTC(2026,8,28,12));
 assert.equal(result,false);
 assert.equal(storage.values.size,0);
});
