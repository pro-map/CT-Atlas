// The admin usage panel puts every user who connected in the selected period up front:
// a CONNECTED panel listing their names, then their rows first, in green, in both tables.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const client=fs.readFileSync("usage-admin.js","utf8");
const css=fs.readFileSync("usage-admin.css","utf8");

function helpers(){
  const start=client.indexOf("function escapeCell");
  const end=client.indexOf("function refreshAdminButton");
  assert.ok(start!==-1&&end>start,"helper block not found");
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{id,innerHTML:"",textContent:"",classes:new Set(),
      classList:{add(c){this.owner.classes.add(c);},toggle(c,on){on?this.owner.classes.add(c):this.owner.classes.delete(c);}}});
    const el=elements.get(id);el.classList.owner=el;return el;
  };
  const c=vm.createContext({document:{getElementById:element}});
  vm.runInContext(client.slice(start,end)+
    "\nglobalThis.api={adminConnectedUsers,adminConnectedFirst,adminUserCell,adminRowClass,renderAdminConnected};",c);
  return {api:c.api,element};
}

const access=[
  {username:"admin",crypto:0,facial:0,map:0,social:0,darkweb:0,ip:0},
  {username:"group-i-1",display_name:"Ed",crypto:0,facial:0,map:0,social:0,darkweb:0,ip:0},
  {username:"group-i-11",display_name:"Kitty",crypto:0,facial:0,map:3,social:0,darkweb:0,ip:0},
  {username:"group-s-11",display_name:"Adrien CBRN",crypto:0,facial:0,map:0,social:0,darkweb:0,ip:0},
  {username:"group-p-12",crypto:0,facial:0,map:0,social:0,darkweb:0,ip:0}
];
const usage=[
  {username:"admin",logins:0,last_activity:""},
  {username:"group-i-1",display_name:"Ed",logins:0,last_activity:""},
  {username:"group-i-11",display_name:"Kitty",logins:0,last_activity:"2026-10-06T08:00:00.000Z"},
  {username:"group-s-11",display_name:"Adrien CBRN",logins:2,last_activity:"2026-10-06T09:30:00.000Z"},
  {username:"group-p-12",logins:1,last_activity:"2026-10-06T07:00:00.000Z"}
];

test("anyone who logged in, opened a workspace or used a feature counts as connected, newest first",()=>{
  const {api}=helpers();
  const connected=api.adminConnectedUsers(access,usage);
  assert.deepEqual([...connected.map(entry=>entry.username)],["group-s-11","group-i-11","group-p-12"]);
  assert.equal(connected[0].display_name,"Adrien CBRN");
  assert.equal(connected[0].logins,2);
  assert.equal(connected[1].display_name,"Kitty","a map visit on an existing session still counts");
  const ordered=[...api.adminConnectedFirst(access,connected).map(item=>item.username)];
  assert.deepEqual(ordered,["group-s-11","group-i-11","group-p-12","admin","group-i-1"],"connected first, the rest in roster order");
});

test("connected rows show the name big with a CONNECTED badge; idle rows keep the plain label",()=>{
  const {api}=helpers();
  const names=new Set(["group-i-11"]);
  const kitty=api.adminUserCell(access[2],true);
  assert.match(kitty,/class="admin-user-connected"/);
  assert.match(kitty,/<strong class="admin-connected-name">Kitty<\/strong>/);
  assert.match(kitty,/group-i-11/);
  assert.match(kitty,/CONNECTED/);
  assert.equal(api.adminRowClass(access[2],names),' class="admin-row-connected"');
  assert.equal(api.adminRowClass(access[1],names),' class="admin-row-idle"');
  assert.equal(api.adminUserCell(access[1],false),"<td>group-i-1 — Ed</td>");
  assert.match(api.adminUserCell({username:"<b>x</b>"},true),/&lt;b&gt;x&lt;\/b&gt;/,"names are escaped");
});

test("the CONNECTED panel lists every connected name and says so when nobody connected",()=>{
  const {api,element}=helpers();
  api.renderAdminConnected(api.adminConnectedUsers(access,usage));
  const list=element("adminConnectedList").innerHTML;
  for(const name of ["Adrien CBRN","Kitty","group-p-12"])assert.ok(list.includes("<strong>"+name+"</strong>"),name);
  assert.ok(list.includes("2 logins"));
  assert.ok(!list.includes("Ed<"),"idle users are not listed");
  assert.match(element("adminConnectedTitle").textContent,/CONNECTED THIS PERIOD · 3 USERS/);
  assert.equal(element("adminConnectedPanel").classes.has("is-empty"),false);
  api.renderAdminConnected([]);
  assert.match(element("adminConnectedList").innerHTML,/Nobody has connected/);
  assert.equal(element("adminConnectedPanel").classes.has("is-empty"),true);
});

test("the panel sits above the tables, both tables use the highlight, and the style is large",()=>{
  const panel=client.indexOf('id="adminConnectedPanel"');
  assert.ok(panel!==-1&&panel<client.indexOf("WORKSPACE ACCESS</div>"));
  const loader=client.slice(client.indexOf("async function loadAdmin"));
  assert.equal((loader.match(/adminConnectedFirst\(/g)||[]).length,2);
  assert.equal((loader.match(/adminUserCell\(/g)||[]).length,2);
  assert.ok(/\.admin-connected-chip strong\{[^}]*font-size:18px/.test(css));
  assert.ok(/\.admin-connected-name\{[^}]*font-size:14px/.test(css));
  assert.ok(css.includes("tr.admin-row-connected td"));
});
