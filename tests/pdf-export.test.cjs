const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("the dependency-free exporter creates and downloads a PDF blob", async () => {
  let downloaded = false;
  let capturedBlob = null;
  const context2d = {
    beginPath(){}, fillRect(){}, fillText(){}, lineTo(){}, moveTo(){}, stroke(){},
    measureText(value){ return { width: String(value).length * 9 }; },
    set fillStyle(_){}, set strokeStyle(_){}, set lineWidth(_){},
    set font(_){}, set textAlign(_){}, set direction(_){}
  };
  const body = { appendChild(){} };
  const document = {
    body,
    fonts: { ready: Promise.resolve() },
    createElement(tag){
      if(tag === "canvas"){
        return {
          width: 0,
          height: 0,
          getContext(){ return context2d; },
          toDataURL(){ return "data:image/jpeg;base64,/9j/2Q=="; }
        };
      }
      return {
        style: {},
        remove(){},
        click(){ downloaded = true; }
      };
    }
  };
  const url = {
    createObjectURL(blob){ capturedBlob = blob; return "blob:ct-atlas-test"; },
    revokeObjectURL(){}
  };
  const sandbox = {
    window: {}, document, URL: url, Blob, TextEncoder, Uint8Array, atob,
    requestAnimationFrame(callback){ callback(); },
    setTimeout(callback){ callback(); },
    Element: class Element {}
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "pdf-export.js"), "utf8");
  vm.runInNewContext(source, sandbox, { filename: "pdf-export.js" });

  const result = await sandbox.window.CTAtlasPdf.download({
    filename: "Test report.pdf",
    title: "Test report",
    meta: "22 Sep 2026",
    blocks: [{ text: "A direct PDF download.", type: "body" }],
    footer: "Test disclaimer"
  });

  assert.equal(downloaded, true);
  assert.ok(capturedBlob);
  assert.equal(capturedBlob.type, "application/pdf");
  assert.equal(result.filename, "Test-report.pdf");
  assert.equal(result.pages, 1);
  const bytes = Buffer.from(await capturedBlob.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(bytes.toString("latin1"), /%%EOF\n$/);
});
