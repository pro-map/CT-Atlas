(function(){
"use strict";

function inject(){
  if(document.getElementById("cryptoIntelButton")) return;
  const anchor=document.getElementById("quickAskButton")||document.getElementById("downloadMapButton");
  if(!anchor){setTimeout(inject,150);return;}

  const button=document.createElement("button");
  button.id="cryptoIntelButton";
  button.type="button";
  button.className="layer-button";
  button.textContent="CRYPTO";
  button.title="Open CT Atlas Crypto Intelligence";
  button.addEventListener("click",()=>{ window.location.href="crypto.html"; });
  anchor.insertAdjacentElement("afterend",button);
}

document.addEventListener("DOMContentLoaded",inject);
if(document.readyState!=="loading") inject();
})();