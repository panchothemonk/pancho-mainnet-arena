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
const frontendCodecPath = "lib/onchain-pvp.ts";

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
const frontendCodecText = readFileSync(frontendCodecPath, "utf8");
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

function parseBufferConstArray(text, constName) {
  const match = text.match(new RegExp(`const\\s+${constName}\\s*=\\s*Buffer\\.from\\(\\[([^\\]]+)\\]\\);`));
  if (!match) {
    fail(`Codec drift: missing ${constName} in ${frontendCodecPath}.`);
  }
  return match[1]
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function expectInstructionDiscriminator(idlName, frontendConst) {
  const instruction = Array.isArray(idl?.instructions)
    ? idl.instructions.find((ix) => ix?.name === idlName)
    : null;
  if (!instruction || !Array.isArray(instruction.discriminator)) {
    fail(`ABI snapshot missing discriminator for instruction ${idlName}.`);
  }
  const frontendDiscriminator = parseBufferConstArray(frontendCodecText, frontendConst);
  if (!arraysEqual(frontendDiscriminator, instruction.discriminator)) {
    fail(
      `Codec drift: ${frontendConst} in ${frontendCodecPath} does not match IDL discriminator for ${idlName}.`
    );
  }
}

function expectAccountDiscriminator(idlName, frontendConst) {
  const account = Array.isArray(idl?.accounts)
    ? idl.accounts.find((entry) => entry?.name === idlName)
    : null;
  if (!account || !Array.isArray(account.discriminator)) {
    fail(`ABI snapshot missing discriminator for account ${idlName}.`);
  }
  const frontendDiscriminator = parseBufferConstArray(frontendCodecText, frontendConst);
  if (!arraysEqual(frontendDiscriminator, account.discriminator)) {
    fail(
      `Codec drift: ${frontendConst} in ${frontendCodecPath} does not match IDL discriminator for ${idlName}.`
    );
  }
}

expectInstructionDiscriminator("create_round", "CREATE_ROUND_DISCRIMINATOR");
expectInstructionDiscriminator("join_round", "JOIN_ROUND_DISCRIMINATOR");
expectInstructionDiscriminator("lock_round", "LOCK_ROUND_DISCRIMINATOR");
expectInstructionDiscriminator("settle_round", "SETTLE_ROUND_DISCRIMINATOR");
expectInstructionDiscriminator("claim", "CLAIM_DISCRIMINATOR");

expectAccountDiscriminator("Round", "ROUND_ACCOUNT_DISCRIMINATOR");
expectAccountDiscriminator("Position", "POSITION_ACCOUNT_DISCRIMINATOR");
expectAccountDiscriminator("GlobalConfig", "CONFIG_ACCOUNT_DISCRIMINATOR");

const requiredCodecMarkers = [
  "data.length < 152",
  "new PublicKey(data.subarray(49, 81))",
  "data.readBigInt64LE(81)",
  "data.readBigInt64LE(89)",
  "data.readUInt8(117)",
  "data.readUInt8(118)",
  "data.readBigUInt64LE(119)",
  "data.readBigUInt64LE(127)",
  "data.readBigUInt64LE(143)",
  "data.length < 200",
  "new PublicKey(data.subarray(40, 72))",
  "new PublicKey(data.subarray(104, 136))",
  "new PublicKey(data.subarray(136, 168))",
  "new PublicKey(data.subarray(168, 200))",
  "data.length < 83",
  "data.readUInt8(72)",
  "data.readBigUInt64LE(73)",
  "data.readUInt8(81) === 1"
];

for (const marker of requiredCodecMarkers) {
  if (!frontendCodecText.includes(marker)) {
    fail(`Codec drift: expected marker "${marker}" missing from ${frontendCodecPath}.`);
  }
}

console.log("[ci-guard] OK");
