// The header's casualty counts, on the real records of the 6 Nov audit: 2 Nov read
// 0 killed with 86 attack records, 1 Nov read 200 from one statement of 100, and
// "Navy Marines kill 34 terrorists" counted as 34 victims. These rules were read
// by hand against 90 days of live records. Do not widen them by more: the wider
// reader, a capitalised-name guard and a CT_OPERATION guard each added new errors.
// The only additions since (16 Nov) were read the same way, every changed record by
// hand: "N injuries", "one death", "one injury" and alleged/suspected/presumed.
// Casualties written without a number ("killed a police inspector") come from the
// collection's review instead: see the last tests and casualty_figures_test.py.
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

const READERS=["casualtyTextForEvent","explicitStructuredCasualtyValue","casualtyPhraseSide","casualtyNumber","casualtyStatements",
  "extractStrict24hCasualtyBreakdown","extractStrict24hCapturedCount","reviewedCasualtyFigure","headerCasualtyFigures"];
const PATTERNS=html.slice(html.indexOf("const TERRORIST_SIDE_CASUALTY_WORDS"),html.indexOf("function casualtyNumber("));
const c=vm.createContext({isCurrentCasualtyEvent:()=>true});
vm.runInContext(PATTERNS+READERS.map(extract).join("\n"),c);

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

test("no lookbehind in the page: Safari before 16.4 throws on it and the whole script stops",()=>{
  assert.doesNotMatch(html,/\(\?<[=!]/);
  assert.equal(captured({title:"No one arrested, not 5 detained, one suspect apprehended"}),1);
  assert.equal(wounded({title:"Parent of two injured"}),0);
  assert.deepEqual(deaths({title:"Mother of 4 killed, 3 people dead"}),{terrorist:0,victim:3});
  assert.deepEqual(deaths({title:"1 soldier killed and 1 terrorist killed"}),{terrorist:1,victim:1});
});

test("a summary's 'one death and N injuries' is read, as 'N deaths' already was (13 Nov read 0 wounded)",()=>{
  const balochistan={title:"Car bomb attack on Balochistan security checkpoint",
    summary:"A car bomb attack on a security checkpoint in Balochistan resulted in 2 deaths and 16 injuries."};
  assert.deepEqual(deaths(balochistan),{terrorist:0,victim:2});
  assert.equal(wounded(balochistan),16);
  const berlin={title:"Terrorist vehicle-ramming attack in Berlin",
    summary:"A terrorist vehicle-ramming attack in Berlin resulted in one death and 26 injuries; the suspect is a supporter of ISIS."};
  assert.deepEqual(deaths(berlin),{terrorist:0,victim:1});
  assert.equal(wounded(berlin),26);
  assert.deepEqual(deaths({title:"Bomb attack kills one in Pandeglang, Banten",summary:"A bomb explosion resulted in one fatality in Pandeglang, Banten, Indonesia."}),{terrorist:0,victim:1});
  assert.equal(wounded({title:"Unidentified gunmen attack vehicle in Rif Dimashq",summary:"Unidentified gunmen opened fire on a vehicle, resulting in one injury."}),1);
  assert.equal(wounded({title:"Settlers shot at a town near Hebron",summary:"Settlers fired at a town, causing no injuries."}),0);
  assert.equal(wounded({title:"Blast near the depot, not 2 injuries as first reported"}),0);
});

test("a qualifier before the noun keeps the figure: 'Two suspected terrorists arrested'",()=>{
  assert.equal(captured({title:"Two suspected terrorists arrested near Jerusalem",summary:"Two suspected terrorists were arrested near Jerusalem over a plot to attack Israelis."}),2);
  assert.equal(captured({title:"Four Suspected Terrorists Arrested In Yobe"}),4);
  assert.equal(captured({title:"One alleged member arrested in Cauca"}),1);
  assert.deepEqual(deaths({title:"Police repel terrorist attack in Zamfara, over 30 suspected bandits killed"}),{terrorist:30,victim:0});
  assert.equal(captured({title:"Frente 4 suspected member arrested in Segovia"}),0,"a singular noun still needs 'one'");
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

function header(allEvents,recentContextEvents=[]){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:""});return nodes.get(id);};
  const h=vm.createContext({document:{getElementById:node},allEvents,recentContextEvents,
    eventCategories:row=>row.categories,mapDataFacts:null,
    headerCasualtyDay:()=>({day:"2026-11-05",state:"finished"}),parisCasualtyWindowLabel:()=>"NOV 5, 2026 · FULL DAY (PARIS)"});
  vm.runInContext(PATTERNS+[...READERS,"updateHeaderCasualties24"].map(extract).join("\n")+
    "function isCurrentCasualtyEvent(){return true;}",h);
  h.updateHeaderCasualties24();
  const read=id=>node(id).textContent;
  return {victimsKilled:read("headerVictimsDeaths24"),victimsWounded:read("headerVictimsWounded24"),
    terroristsKilled:read("headerTerroristsDeaths24"),terroristsCaptured:read("headerTerroristsCaptured24")};
}

test("attack_update rows are skipped: a follow-up restates its attack's toll",()=>{
  const event={title:"At least 11 people were killed in a suicide bombing",categories:["Attacks"]};
  const counts=header([event],[{...event,attack_update:true,casualties:{victims_killed:11}},
    {title:"Over 30 arrested",categories:["Arrests"],attack_update:true,casualties:{perpetrators_captured:30}}]);
  assert.equal(counts.victimsKilled,"11");
  assert.equal(counts.terroristsCaptured,"0");
});

// The collection's review now writes casualties on each record (collector.py
// CASUALTY_FIELDS). The figures below are the ones the new prompt asks for, written by hand
// on the live records of 14-15 Nov that the readers above leave at 0: no Gemini call was made.
const figures=(event)=>({...c.headerCasualtyFigures(event,"2026-11-15")});

test("the review's figure wins, one field at a time, and the text readers fill the rest",()=>{
  assert.deepEqual(figures({title:"Suspected terrorists kill Chinese national and police inspector in Bauchi",
    casualties:{victims_killed:2}}),{victimsKilled:2,victimsWounded:0,terroristsKilled:0,terroristsCaptured:0});
  assert.deepEqual(figures({title:"21 militants killed and six security personnel killed in clashes in Balochistan",
    casualties:{victims_killed:6,victims_wounded:3}}),{victimsKilled:6,victimsWounded:3,terroristsKilled:21,terroristsCaptured:0},
    "a figure the review left out is read from the text");
  assert.deepEqual(figures({title:"Security operations in Jalisco result in arrests and neutralizations",
    summary:"The operations led to the capture of nine key suspects and the death of three alleged criminals.",
    casualties:{perpetrators_killed:3,perpetrators_captured:9}}),{victimsKilled:0,victimsWounded:0,terroristsKilled:3,terroristsCaptured:9});
  assert.deepEqual(figures({title:"Blast in market, 3 people dead",casualties:{victims_killed:0}}).victimsKilled,0,
    "a review's 0 stands");
});

test("a record reviewed before the fields, or with a figure out of shape, keeps the text readers",()=>{
  const text={title:"Two dead, 5 wounded in suspected terrorist knife attack in France"};
  const expected={victimsKilled:2,victimsWounded:5,terroristsKilled:0,terroristsCaptured:0};
  assert.deepEqual(figures(text),expected);
  for(const casualties of [{},{victims_killed:null},{victims_killed:"7"},{victims_killed:-1},{victims_killed:2.5},{victims_killed:100001}]){
    assert.deepEqual(figures({...text,casualties}),expected,JSON.stringify(casualties));
  }
  assert.equal(c.reviewedCasualtyFigure({casualties:null},"victims_killed"),null);
});

test("the header keeps its rules with the review's figures (15 Nov read 3, 0, 0, 2)",()=>{
  const counts=header([
    {title:"Suspected terrorists kill Chinese national and police inspector in Bauchi",categories:["Attacks"],casualties:{victims_killed:2}},
    {title:"Somalia MP killed in drive-by shooting",categories:["Attacks"],casualties:{victims_killed:1}},
    {title:"Sound bomb explosion injures civilians in Amuda",categories:["Attacks"],casualties:{victims_wounded:2}},
    {title:"Hamas-linked plot disrupted in Vienna",categories:["Attacks"],casualties:{perpetrators_captured:1}}
  ],[
    {title:"Troops neutralize terrorist and recover motorcycles in Wase, Plateau State",categories:["Counter Terrorism Action"],
      casualties:{perpetrators_killed:1,victims_killed:4}},
    {title:"Ten presumed members of 'Los Cocos' captured in raids in Guainía",categories:["Arrests","Counter Terrorism Action"],
      casualties:{perpetrators_captured:10}},
    {title:"Military operation in Nigeria neutralizes eight terrorists",categories:["Arrests"],casualties:{perpetrators_killed:8}},
    {title:"Ransom paid in Kaduna",categories:["Terrorist Financing"],casualties:{victims_killed:5,perpetrators_captured:2}}
  ]);
  assert.deepEqual(counts,{victimsKilled:"3",victimsWounded:"2",terroristsKilled:"1",terroristsCaptured:"10"},
    "victims count on attacks only, terrorists killed on attacks and CT actions, captured on CT actions and arrests");
});
