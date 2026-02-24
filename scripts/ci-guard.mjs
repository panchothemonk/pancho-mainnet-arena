import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`[ci-guard] ${message}`);
  process.exit(1);
}

const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const forbiddenPathMatchers = [
  /(^|\/).*keypair\.json$/i,
  /(^|\/)id\.json$/i,
  /^data\//i,
  /^onchain\/\.anchor\//i,
  /^onchain\/target\//i
];

const forbidden = tracked.filter((path) => forbiddenPathMatchers.some((rx) => rx.test(path)));
if (forbidden.length > 0) {
  fail(`Forbidden tracked artifacts detected:\n${forbidden.join("\n")}`);
}

const idlPath = "onchain/abi/pancho_pvp.idl.json";
const typesPath = "onchain/abi/pancho_pvp.types.ts";
const sourcePath = "onchain/programs/pancho_pvp/src/lib.rs";

let idl;
try {
  idl = JSON.parse(readFileSync(idlPath, "utf8"));
} catch (err) {
  fail(`Unable to read ABI snapshot ${idlPath}: ${err instanceof Error ? err.message : String(err)}`);
}

const initializeConfig = Array.isArray(idl?.instructions)
  ? idl.instructions.find((ix) => ix?.name === "initializeConfig" || ix?.name === "initialize_config")
  : null;
if (!initializeConfig) {
  fail("ABI snapshot missing initializeConfig instruction.");
}

const argNames = Array.isArray(initializeConfig.args) ? initializeConfig.args.map((arg) => arg?.name) : [];
for (const requiredArg of ["oracleAccountSol", "oracleAccountBtc", "oracleAccountEth"]) {
  const snake = requiredArg.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  if (!argNames.includes(requiredArg) && !argNames.includes(snake)) {
    fail(`ABI snapshot drift: initializeConfig missing arg ${requiredArg}.`);
  }
}

const typesText = readFileSync(typesPath, "utf8");
for (const required of ["oracleAccountSol", "oracleAccountBtc", "oracleAccountEth"]) {
  if (!typesText.includes(required)) {
    fail(`Type snapshot drift: ${typesPath} missing ${required}.`);
  }
}

const sourceText = readFileSync(sourcePath, "utf8");
const extractStringConst = (name) => {
  const match = sourceText.match(new RegExp(`const\\s+${name}\\s*:\\s*Pubkey\\s*=\\s*pubkey!\\(\"([^\"]+)\"\\);`));
  return match?.[1] ?? null;
};
const extractFeeConst = () => {
  const match = sourceText.match(/const\s+IMMUTABLE_FEE_BPS\s*:\s*u16\s*=\s*(\d+)\s*;/);
  return match ? Number(match[1]) : null;
};

const immutableAdmin = extractStringConst("INITIAL_ADMIN");
const immutableTreasury = extractStringConst("INITIAL_TREASURY");
const immutableFeeBps = extractFeeConst();
if (!immutableAdmin || !immutableTreasury || typeof immutableFeeBps !== "number") {
  fail(`Unable to parse immutable constants from ${sourcePath}.`);
}

const accountByName = (name) =>
  Array.isArray(initializeConfig.accounts)
    ? initializeConfig.accounts.find((account) => account?.name === name)
    : null;
const adminAccount = accountByName("admin");
const treasuryAccount = accountByName("treasury");
if (adminAccount?.address !== immutableAdmin) {
  fail(`ABI snapshot drift: initialize_config.admin address mismatch (${adminAccount?.address ?? "missing"} != ${immutableAdmin}).`);
}
if (treasuryAccount?.address !== immutableTreasury) {
  fail(`ABI snapshot drift: initialize_config.treasury address mismatch (${treasuryAccount?.address ?? "missing"} != ${immutableTreasury}).`);
}

const setConfig = Array.isArray(idl?.instructions)
  ? idl.instructions.find((ix) => ix?.name === "setConfig" || ix?.name === "set_config")
  : null;
if (!setConfig) {
  fail("ABI snapshot missing setConfig instruction.");
}
const setConfigFeeArg = Array.isArray(setConfig.args)
  ? setConfig.args.find((arg) => arg?.name === "feeBps" || arg?.name === "fee_bps")
  : null;
if (!setConfigFeeArg) {
  fail("ABI snapshot drift: setConfig missing fee_bps arg.");
}
if (!typesText.includes(immutableAdmin)) {
  fail(`Type snapshot drift: ${typesPath} missing immutable admin ${immutableAdmin}.`);
}
if (!typesText.includes(immutableTreasury)) {
  fail(`Type snapshot drift: ${typesPath} missing immutable treasury ${immutableTreasury}.`);
}
if (!new RegExp(`\\b${immutableFeeBps}\\b`).test(sourceText)) {
  fail(`Source drift: missing immutable fee constant ${immutableFeeBps}.`);
}

console.log("[ci-guard] OK");
