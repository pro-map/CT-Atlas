(function(){
"use strict";

const API_BASE="https://ct-report-generator.fairpeace.workers.dev";
const TOKEN_KEY="ct_map_session_token";
const USER_KEY="ct_map_username";
const VALID_TABS=new Set(["map","crypto","facial","social","darkweb"]);
const tab=String(document.body&&document.body.dataset.ctTab||"").trim().toLowerCase();
if(!VALID_TABS.has(tab))return;

let sent=false;
let attempts=0;
let retryTimer=null;

async function record(){
  if(sent)return;
  const username=String(sessionStorage.getItem(USER_KEY)||"").trim().toLowerCase();
  const token=String(sessionStorage.getItem(TOKEN_KEY)||"");

  if(!username||!token){
    if(attempts++<120)retryTimer=setTimeout(record,250);
    return;
  }

  sent=true;
  clearTimeout(retryTimer);
  try{
    const response=await fetch(API_BASE+"/usage-record",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Session-Token":token},
      body:JSON.stringify({username,action:"tab_access",tab}),
      keepalive:true
    });
    if(!response.ok)console.warn("CT Atlas tab access was not recorded:",response.status);
  }catch(error){
    console.warn("CT Atlas tab access analytics unavailable:",error);
  }
}

window.CTAtlasTabAccess={record};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",record,{once:true});
else record();
})();