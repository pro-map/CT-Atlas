// The header's casualty counts, on the real records of the 6 Nov audit: 2 Nov read
// 0 killed with 86 attack records, 1 Nov read 200 from one statement of 100, and
// "Navy Marines kill 34 terrorists" counted as 34 victims. These rules were read
// by hand against 90 days of live records. Do not widen them by more: the wider
// reader, a capitalised-name guard and a CT_OPERATION guard each added new errors.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync("index.html","utf8");

function extract(name){
  const start=html.indexOf(`function ${name}(`);
  assert.ok(start>=0,name);
  let depth=0,i=html.indexOf("{",start);
  for(;i<html.length;i++){
    if(html[i]==="{")depth++;
    else if(html[i]==="}"&&--depth===0)break;
  }
  return html.slice(start,i+1);
}

const c=vm.createContext({isCurrentCasualtyEvent:()=>true});
vm.runInContext(html.slice(html.indexOf("const TERRORIST_SIDE_CASUALTY_WORDS"),html.indexOf("function casualtyNumber("))+
  ["casualtyTextForEvent","explicitStructuredCasualtyValue","casualtyPhraseSide","casualtyNumber","casualtyStatements",
    "extractStrict24hCasualtyBreakdown","extractStrict24hCapturedCount"].map(extract).join("\n"),c);

const deaths=event=>({...c.extractStrict24hCasualtyBreakdown(event,"death")});
const wounded=event=>c.extractStrict24hCasualtyBreakdown(event,"wounded").victim;
const captured=event=>c.extractStrict24hCapturedCount(event);

test("number words and 'N deaths' are read (2 and 5 Nov showed 0 killed)",()=>{
  const mozambique={title:"Islamic State claims attacks in Muidumbe and Mueda causing at least 14 deaths in Mozambique",
    summary:"The Islamic State has claimed responsibility for recent attacks in Muidumbe and Mueda, Mozambique, which resulted in at least 14 deaths."};
  assert.deepEqual(deaths(mozambique),{terrorist:0,victim:14});
  const refinery={title:"One Killed and Three Injured in Shooting at Oil Refinery Between Erbil and Kirkuk",
    summary:"One person was killed and three others injured in a shooting targeting an oil refinery located between Erbil and Kirkuk."};
  assert.deepEqual(deaths(refinery),{terrorist:0,victim:1});
  assert.equal(wounded(refinery),3);
  const aviation={title:"Four killed and fourteen injured in terrorist attack on Turkish state aviation site",
    summary:"A terrorist attack on a Turkish state aviation facility resulted in four deaths and fourteen injuries."};
  assert.deepEqual(deaths(aviation),{terrorist:0,victim:4},"'fourteen injured' must not be read as killed");
  assert.equal(wounded(aviation),14);
  assert.deepEqual(deaths({title:"Twenty-five people killed in Kaduna village"}),{terrorist:0,victim:25});
  assert.equal(captured({title:"Eighteen arrested during outpost evacuation in Samaria"}),18);
});

test("the comma is a boundary: 'Two dead, 5 wounded' is 2 killed, not 7",()=>{
  const france={title:"Two dead, 5 wounded in suspected terrorist knife attack in France",
    summary:"A suspected terrorist knife attack has left two dead and five wounded in France.",
    original_title:"2 dead, 5 wounded in suspected terrorist knife attack in France"};
  assert.deepEqual(deaths(france),{terrorist:0,victim:2});
  assert.equal(wounded(france),5);
  assert.equal(captured({title:"'La Cabra', leader of Mara 18, arrested in Tabasco"}),0,"'18, arrested' is the name of a gang");
  assert.equal(captured({title:"Kalabagan, 4 arrested"}),4);
  assert.deepEqual(deaths({title:"Nigerian troops killed 1,106 insurgents in Borno"}),{terrorist:1106,victim:0},"a thousands separator is not a boundary");
});

test("the same toll in two wordings is counted once (138 arrested read 276, 'over 100' read 200)",()=>{
  assert.deepEqual(deaths({title:"Islamic State claims to have killed over 100 Al-Qaeda members in Burkina Faso",
    summary:"The Islamic State claims to have killed more than 100 members of rival Al-Qaeda factions in Burkina Faso."}),{terrorist:0,victim:100});
  assert.equal(captured({title:"Ethiopian government arrested 138 people accused of being linked to Al-Shabaab and ISIS",
    summary:"The Ethiopian government detained 138 individuals on suspicion of connections to Al-Shabaab and ISIS."}),138);
  assert.equal(captured({title:"Over 800 Detained in SCO Member Countries During Operation 'Spiderweb'",
    summary:"Law enforcement agencies across Shanghai Cooperation Organisation member states detained over 800 individuals in a coordinated security operation named 'Spiderweb'."}),800);
  assert.equal(wounded({title:"Chad: 72 soldiers injured in violent clashes in Tibesti",summary:"72 soldiers were wounded during intense fighting in the Tibesti region of Chad."}),72);
  assert.deepEqual(deaths({title:"Violence in Sinaloa leaves 5 dead",summary:"At least 5 people were killed in violence occurring between Culiacán and Mazatlán in Sinaloa, Mexico."}),{terrorist:0,victim:5});
  assert.deepEqual(deaths({title:"Over 30 militants killed in security operation in Northwest Nigeria",summary:"Over 30 militants were killed during a security operation conducted in northwestern Nigeria."}),{terrorist:30,victim:0});
});

test("militants go to the terrorist side, and the two sides stay separate",()=>{
  assert.deepEqual(deaths({title:"Navy Marines kill 34 terrorists and disrupt operations in Lake Chad",
    summary:"Leadership Newspapers reports that Nigerian Navy Marines killed 34 terrorists and disrupted their operations in the Lake Chad region."}),{terrorist:34,victim:0});
  assert.deepEqual(deaths({title:"Police kill 30 bandits in Zamfara"}),{terrorist:30,victim:0});
  assert.deepEqual(deaths({title:"Security forces killed 14 armed bandits in Katsina"}),{terrorist:14,victim:0});
  assert.deepEqual(deaths({title:"the army stated it killed nine of the assailants"}),{terrorist:9,victim:0});
  assert.deepEqual(deaths({title:"21 militants killed and six security personnel killed in clashes in Balochistan",
    summary:"Security forces killed 21 militants during counter-terrorism operations in Balochistan, while six security personnel were killed in the clashes and related attacks."}),{terrorist:21,victim:6});
});

test("a side word that names the attack or the next field does not move victims to the terrorist side",()=>{
  assert.deepEqual(deaths({title:"Bomb killed 12 in a terrorist attack"}),{terrorist:0,victim:12});
  assert.deepEqual(deaths({title:"Gunmen killed 5 in suspected militant ambush"}),{terrorist:0,victim:5});
  assert.deepEqual(deaths({title:"Gunmen ambush police convoy in Zamfara, killing 8",
    summary:"Unidentified armed attackers ambushed a police convoy in Zamfara State, Nigeria."}),{terrorist:0,victim:0});
  assert.deepEqual(deaths({title:"Boko Haram attacks village in Adamawa State, killing 30",
    summary:"Boko Haram militants launched an attack in southeast Adamawa State, murdering 30 people."}),{terrorist:0,victim:0},
    "'killing 30' alone says nothing about who died");
  assert.deepEqual(deaths({title:"Leaves Two Dead",summary:"5 people were displaced"}),{terrorist:0,victim:2},"a field ends a phrase like a comma");
});

test("what looks like a figure but is not one reads as nothing",()=>{
  assert.deepEqual(deaths({title:"Blast in market, no one was killed"}),{terrorist:0,victim:0});
  assert.equal(wounded({title:"Drone hit the depot, no one injured"}),0);
  assert.equal(captured({title:"Mother of eight arrested for terrorism financing in Moscow",
    summary:"A mother of eight has been arrested in Moscow on charges of financing terrorism."}),0);
  assert.deepEqual(deaths({title:"Father of three killed in Kaduna attack"}),{terrorist:0,victim:0});
  assert.equal(captured({title:"Frente 4 member arrested for murder in Segovia"}),0);
  assert.equal(captured({title:"One suspect arrested in Lyon"}),1);
});

test("death toll and total statements still take precedence",()=>{
  assert.deepEqual(deaths({title:"Death toll rises to 25 after Kano bombing, 3 attackers killed"}),{terrorist:0,victim:25});
  assert.deepEqual(deaths({title:"Fatalities: 9 in Kabul"}),{terrorist:0,victim:9});
  assert.deepEqual(deaths({title:"Attack leaves 12 fatalities"}),{terrorist:0,victim:12});
});

test("structured figures still win over the text",()=>{
  assert.deepEqual(deaths({title:"Two dead in attack",fatalities:7}),{terrorist:0,victim:7});
  assert.equal(captured({title:"Two arrested",arrested:5}),5);
});

test("the rejected ideas stay out",()=>{
  assert.equal(captured({title:"Frente 57 captured in Cauca"}),57,"no capitalised-name guard: it also erased 'Kalabagan, 4 arrested'");
  const header=extract("updateHeaderCasualties24");
  assert.doesNotMatch(header,/CT_OPERATION/,"no type guard on Victims: it removed real tolls such as '3 soldiers killed'");
  assert.doesNotMatch(header,/incident_id/,"grouping by incident changed nothing on any of 46 days");
});

test("attack_update rows are skipped: a follow-up restates its attack's toll",()=>{
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:""});return nodes.get(id);};
  const event={title:"At least 11 people were killed in a suicide bombing",categories:["Attacks"]};
  const h=vm.createContext({...c,document:{getElementById:node},allEvents:[event],
    recentContextEvents:[{...event,attack_update:true},{title:"Over 30 arrested",categories:["Arrests"],attack_update:true}],
    eventCategories:row=>row.categories,headerCasualtyDayStatus:()=>({finished:true,label:"NOV 5, 2026 · FULL DAY (PARIS)",note:""}),
    parisCasualtyWindowLabel:()=>"NOV 5, 2026 · FULL DAY (PARIS)"});
  vm.runInContext(html.slice(html.indexOf("const TERRORIST_SIDE_CASUALTY_WORDS"),html.indexOf("function casualtyNumber("))+
    ["casualtyTextForEvent","explicitStructuredCasualtyValue","casualtyPhraseSide","casualtyNumber","casualtyStatements",
      "extractStrict24hCasualtyBreakdown","extractStrict24hCapturedCount","updateHeaderCasualties24"].map(extract).join("\n")+
    "function isCurrentCasualtyEvent(){return true;}",h);
  h.updateHeaderCasualties24();
  assert.equal(node("headerVictimsDeaths24").textContent,"11");
  assert.equal(node("headerTerroristsCaptured24").textContent,"0");
});
