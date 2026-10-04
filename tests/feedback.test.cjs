const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('cloudflare-worker/feedback.js','utf8').replace(/^import[\s\S]*?from "\.\/shared.js";\s*/,'').replace(/export /g,'');

function harness(){
 const c=vm.createContext({cleanText:(v,n)=>String(v||'').trim().slice(0,n)});
 vm.runInContext(source,c);
 return vm.runInContext('({buildEmail,FEEDBACK_VERSION})',c);
}

test('buildEmail formats an evaluation submission with a rating AND its own comment right underneath, per item',()=>{
 const h=harness();
 const {subject,text}=h.buildEmail('group-i-4',{
  kind:'evaluation',
  ratings:{report_generator:5,deep_search:3,ct_atlas_ai:4},
  item_comments:{
   report_generator:'Rock solid.',
   deep_search:'Sometimes reads the period wrong.'
  },
  other_comments:'Would like a dark-mode toggle.'
 });
 assert.match(subject,/evaluation from group-i-4/);
 assert.match(text,/Tester: group-i-4/);
 assert.match(text,/Report Generator: 5\/5\n {2}Comment: Rock solid\./);
 assert.match(text,/Deep Search \(BETA\): 3\/5\n {2}Comment: Sometimes reads the period wrong\./);
 assert.match(text,/CT Atlas AI: 4\/5/);
 assert.match(text,/Other:\nWould like a dark-mode toggle\./);
});

test('buildEmail marks an out-of-range or missing rating as not rated, never a bogus number, and covers every listed feature',()=>{
 const h=harness();
 const {text}=h.buildEmail('admin',{kind:'evaluation',ratings:{report_generator:0,deep_search:9},item_comments:{},other_comments:''});
 assert.match(text,/Report Generator: \(not rated\)/);
 assert.match(text,/Deep Search \(BETA\): \(not rated\)/);
 assert.match(text,/CT Atlas AI: \(not rated\)/);
 for(const label of ['Heat Map','Situation 24H','Weekly Analysis','Key Developments','Events Database','Security Features']){
  assert.match(text,new RegExp(`${label}: \\(not rated\\)`),`missing evaluation item: ${label}`);
 }
 assert.match(text,/Other:\n\(none\)/);
});

test('buildEmail omits the per-item Comment line when that item has no comment, instead of printing an empty one',()=>{
 const h=harness();
 const {text}=h.buildEmail('group-s-1',{kind:'evaluation',ratings:{report_generator:5},item_comments:{report_generator:''}});
 assert.match(text,/Report Generator: 5\/5\n\n/);
 assert.ok(!text.includes('Comment: '),'no comment was given, so no "Comment:" line should appear anywhere');
});

test('buildEmail formats an issue report with category and description',()=>{
 const h=harness();
 const {subject,text}=h.buildEmail('group-p-2',{
  kind:'issue',
  category:'Bug',
  description:'Deep Search returned an empty report for a valid question.'
 });
 assert.match(subject,/issue from group-p-2/);
 assert.match(text,/Category: Bug/);
 assert.match(text,/Deep Search returned an empty report for a valid question\./);
});

test('FEEDBACK_VERSION is exported',()=>{
 const h=harness();
 assert.equal(typeof h.FEEDBACK_VERSION,'string');
 assert.ok(h.FEEDBACK_VERSION.length>0);
});

test('buildEmail includes the selected workspace and its overall rating',()=>{
 const {text,subject}=harness().buildEmail('group-p-2',{
  kind:'evaluation',workspace:'crypto',rating:4
 });
 assert.match(subject,/Crypto Intelligence/);
 assert.match(subject,/evaluation/);
 assert.match(text,/Workspace: Crypto Intelligence/);
 assert.match(text,/Overall rating: 4\/5/);
 assert.match(text,/Feedback type: \(none\)/);
});

test('buildEmail formats a social workspace bug report',()=>{
 const {text,subject}=harness().buildEmail('group-s-1',{
  kind:'issue',workspace:'social',feedback_type:'bug',
  description:'The social investigation returned no sources.'
 });
 assert.match(subject,/Social Media \(Beta\)/);
 assert.match(subject,/bug report/);
 assert.match(text,/Workspace: Social Media \(Beta\)/);
 assert.match(text,/Feedback type: Bug report/);
 assert.match(text,/The social investigation returned no sources\./);
});

test('IP Intelligence is a selectable and accepted feedback workspace',()=>{
 const {text,subject}=harness().buildEmail('group-p-2',{kind:'issue',workspace:'ip',feedback_type:'bug',description:'The domain lookup timed out.'});
 assert.match(subject,/IP Intelligence/);assert.match(text,/Workspace: IP Intelligence/);
 assert.match(source,/ip: "IP Intelligence"/);
 assert.match(fs.readFileSync('feedback.js','utf8'),/<option value="ip">IP Intelligence<\/option>/);
});

test('buildEmail supports a rating and free-text comment in one submission',()=>{
 const {text,subject}=harness().buildEmail('group-i-1',{
  kind:'evaluation',workspace:'facial',rating:5,
  feedback_type:'comment',description:'The image quality panel is useful.'
 });
 assert.match(subject,/evaluation \+ comment/);
 assert.match(text,/Overall rating: 5\/5/);
 assert.match(text,/Feedback type: Comment/);
 assert.match(text,/The image quality panel is useful\./);
});
