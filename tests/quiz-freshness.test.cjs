const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function harness(){
 const nodes=new Map();const classes=()=>({add(){},remove(){},contains(){return false;}});
 const node=()=>({textContent:'',innerHTML:'',hidden:false,style:{},classList:classes(),setAttribute(){},querySelectorAll(){return []},before(n){nodes.set('.daily-quiz-freshness',n)}});
 for(const name of ['.daily-quiz-question','.daily-quiz-head span:last-child','.daily-quiz-options','.daily-quiz-result'])nodes.set(name,node());
 const panel={classList:classes(),setAttribute(){},querySelector:key=>nodes.get(key),querySelectorAll:()=>[]};
 const context=vm.createContext({Intl,Date,document:{body:{classList:classes()},createElement:node,addEventListener(){}},sessionStorage:{getItem:()=>''},setInterval(){},panelFixture:panel});
 const source=fs.readFileSync('daily-quiz.js','utf8').replace(/\}\)\(\);\s*$/,`panel=panelFixture;globalThis.api={load,openQuiz,parisDay,setResponse:value=>{api=async()=>value;},answered:()=>answered};})();`);
 vm.runInContext(source,context);return {api:context.api,nodes};
}
const quiz={id:'old',date:'2000-01-01',question:'Old question',options:['A','B','C']};
test('stale notice remains visible with an already recorded answer',async()=>{
 const {api,nodes}=harness();api.setResponse({quiz,answered:true,answer:{quiz_id:'old',correct:true,correct_index:0}});
 await api.load();assert.equal(nodes.get('.daily-quiz-freshness').hidden,false);assert.match(nodes.get('.daily-quiz-freshness').textContent,/2000-01-01/);assert.equal(api.answered(),true);
});
test('reopening fetches new daily quiz, removes stale notice and resets answered state',async()=>{
 const {api,nodes}=harness();api.setResponse({quiz,answered:true,answer:{quiz_id:'old',correct:true}});await api.load();
 api.setResponse({quiz:{...quiz,id:'new',date:api.parisDay(),question:'New question'},answered:false});
 api.openQuiz();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nodes.get('.daily-quiz-question').textContent,'New question');assert.equal(nodes.get('.daily-quiz-freshness').hidden,true);assert.equal(api.answered(),false);
});

