#!/usr/bin/env node
/**
 * Patches @clinebot/llms's bundled AI SDK to fix tool schema and message format
 * incompatibilities. Remove once @clinebot/llms publishes a compatible version.
 * See: asSchema() "schema is not a function" bug in prepareToolsAndToolChoice.
 */
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "..");

const NORMALIZE_FN = `
function normalizeLegacyMessages(m){return m.map(function(g){if(!g||typeof g!=="object"||!Array.isArray(g.content))return g;if(g.role==="assistant"){return Object.assign({},g,{content:g.content.map(function(p){if(p&&p.type==="tool-call"&&"args"in p&&!("input"in p)){var a=p.args;var rest={};for(var k in p){if(k!=="args")rest[k]=p[k];}rest.input=a!=null?a:{};return rest;}if(p&&p.type==="tool-call"&&p.input==null){return Object.assign({},p,{input:{}});}return p;})});}if(g.role==="tool"){return Object.assign({},g,{content:g.content.map(function(p){if(p&&p.type==="tool-result"&&typeof p.output==="string"){var isErr=p.isError===true;var rest={};for(var k in p){if(k!=="isError")rest[k]=p[k];}rest.output={type:isErr?"error-text":"text",value:p.output};return rest;}if(p&&p.type==="tool-result"&&p.output!=null&&typeof p.output==="object"&&!("type"in p.output)){var isErr=p.isError===true;var rest={};for(var k in p){if(k!=="isError")rest[k]=p[k];}rest.output={type:isErr?"error-json":"json",value:p.output};return rest;}return p;})});}return g;});}
`.trim();

function patchFile(filePath, patches) {
  if (!fs.existsSync(filePath)) return false;
  let code = fs.readFileSync(filePath, "utf8");
  let changed = false;
  for (const { find, replace, once } of patches) {
    if (code.includes(replace)) continue; // already patched
    if (!code.includes(find)) continue;
    code = once ? code.replace(find, replace) : code.split(find).join(replace);
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(filePath, code, "utf8");
    console.log("  patched", path.relative(ROOT, filePath));
  }
  return changed;
}

console.log("Patching AI SDK for @clinebot/llms compatibility...");

// Find all @ai-sdk/provider-utils dist files
const providerUtilsDirs = [];
function findDirs(base, target, results) {
  if (!fs.existsSync(base)) return;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.name === ".cache") continue;
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      if (full.endsWith(target)) results.push(full);
      else if (entry.name !== ".bin") findDirs(full, target, results);
    }
  }
}

// Patch 1: asSchema - handle plain JSON objects
findDirs(path.join(ROOT, "node_modules"), "@ai-sdk/provider-utils/dist", providerUtilsDirs);
for (const dir of providerUtilsDirs) {
  for (const file of ["index.mjs", "index.js"]) {
    patchFile(path.join(dir, file), [{
      find: ": schema();",
      replace: ': typeof schema === "function" ? schema() : jsonSchema(schema);',
      once: false,
    }]);
  }
}

// Patch 2: standardizePrompt - normalize legacy message formats
const aiDirs = [];
findDirs(path.join(ROOT, "node_modules"), "ai/dist", aiDirs);
for (const dir of aiDirs) {
  for (const file of ["index.mjs", "index.js"]) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) continue;
    patchFile(filePath, [
      {
        find: "async function standardizePrompt",
        replace: NORMALIZE_FN + "\nasync function standardizePrompt",
        once: true,
      },
      {
        find: "const validationResult = await safeValidateTypes({",
        replace: "messages = normalizeLegacyMessages(messages);\n  const validationResult = await safeValidateTypes({",
        once: true,
      },
    ]);
  }
}

// Patch 3: @clinebot/llms dist files - fullStream event property names changed in AI SDK v6
const streamPatches = [
  { find: "h.textDelta??h.delta", replace: "h.textDelta??h.text??h.delta", once: false },
  { find: "h.textDelta??h.reasoning", replace: "h.textDelta??h.text??h.reasoning", once: false },
  { find: "h.args??{}", replace: "h.args??h.input??{}", once: false },
];
for (const file of ["runtime.js", "providers.js", "index.js", "index.browser.js"]) {
  patchFile(path.join(ROOT, "node_modules/@clinebot/llms/dist", file), streamPatches);
}

console.log("Done.");
