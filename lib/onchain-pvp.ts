import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";

export const PANCHO_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PANCHO_PROGRAM_ID ?? "52nguesHaBuF4psFr2uybVnW4angLW2ZtsBRSRmdF8k3"
);

export const CREATE_ROUND_DISCRIMINATOR = Buffer.from([229, 218, 236, 169, 231, 80, 134, 112]);
export const JOIN_ROUND_DISCRIMINATOR = Buffer.from([191, 222, 86, 25, 234, 174, 157, 249]);
export const LOCK_ROUND_DISCRIMINATOR = Buffer.from([68, 124, 43, 230, 30, 44, 248, 227]);
export const SETTLE_ROUND_DISCRIMINATOR = Buffer.from([40, 101, 18, 1, 31, 129, 52, 77]);
export const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
// Must match current Anchor discriminator for account:Round.
const ROUND_ACCOUNT_DISCRIMINATOR = Buffer.from([87, 127, 165, 51, 73, 78, 116, 174]);
const POSITION_ACCOUNT_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
const CONFIG_ACCOUNT_DISCRIMINATOR = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]);
const OPEN_ENTRY_SECONDS = 60;
const SETTLEMENT_SECONDS = 5 * 60;

export type OnchainRoundState = {
  oraclePriceAccount: PublicKey;
  status: number;
  winnerSide: number;
  lockTs: number;
  endTs: number;
  distributableLamports: bigint;
  upTotal: bigint;
  downTotal: bigint;
};

export type OnchainPositionState = {
  side: number;
  amountLamports: bigint;
  claimed: boolean;
};

export type OnchainConfigState = {
  treasury: PublicKey;
  oracleAccountSol: PublicKey;
  oracleAccountBtc: PublicKey;
  oracleAccountEth: PublicKey;
};

export function marketKeyToCode(market: string): number {
  const key = market.toUpperCase();
  if (key === "SOL") return 0;
  if (key === "BTC") return 1;
  if (key === "ETH") return 2;
  throw new Error(`Unsupported market key: ${market}`);
}

export function directionToSide(direction: "UP" | "DOWN"): number {
  return direction === "UP" ? 0 : 1;
}

export function marketKeyToFeedIdHex(market: string): string {
  const key = market.toUpperCase();
  if (key === "SOL") return "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
  if (key === "BTC") return "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
  if (key === "ETH") return "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
  throw new Error(`Unsupported market key: ${market}`);
}

export function roundIdFromStartMs(roundStartMs: number): bigint {
  return BigInt(Math.floor(roundStartMs / 1000));
}

export function roundStartMsFromRoundId(roundId: string): number {
  const parts = roundId.split("-");
  if (parts.length < 2) {
    throw new Error(`Invalid round id: ${roundId}`);
  }
  const sec = Number(parts[1]);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`Invalid round id timestamp: ${roundId}`);
  }
  return sec * 1000;
}

export function deriveConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PANCHO_PROGRAM_ID)[0];
}

export function deriveRoundPda(marketCode: number, roundId: bigint): PublicKey {
  const roundIdBytes = Buffer.alloc(8);
  roundIdBytes.writeBigUInt64LE(roundId, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), Buffer.from([marketCode]), roundIdBytes],
    PANCHO_PROGRAM_ID
  )[0];
}

export function deriveVaultPda(round: PublicKey, side: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), round.toBuffer(), Buffer.from([side])],
    PANCHO_PROGRAM_ID
  )[0];
}

export function derivePositionPda(round: PublicKey, user: PublicKey, side: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), round.toBuffer(), user.toBuffer(), Buffer.from([side])],
    PANCHO_PROGRAM_ID
  )[0];
}

export function buildJoinRoundInstruction(params: {
  user: PublicKey;
  marketKey: string;
  roundStartMs: number;
  direction: "UP" | "DOWN";
  lamports: number;
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const side = directionToSide(params.direction);

  const config = deriveConfigPda();
  const round = deriveRoundPda(marketCode, roundId);
  const position = derivePositionPda(round, params.user, side);
  const sideVault = deriveVaultPda(round, side);

  const data = Buffer.alloc(8 + 1 + 8);
  JOIN_ROUND_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(side, 8);
  data.writeBigUInt64LE(BigInt(Math.floor(params.lamports)), 9);

  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: sideVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  });
}

export function buildCreateRoundInstruction(params: {
  payer: PublicKey;
  marketKey: string;
  roundStartMs: number;
  oraclePriceAccount: PublicKey;
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const lockTs = Number(roundId) + OPEN_ENTRY_SECONDS;
  const endTs = lockTs + SETTLEMENT_SECONDS;
  const feedIdHex = marketKeyToFeedIdHex(params.marketKey);

  const config = deriveConfigPda();
  const round = deriveRoundPda(marketCode, roundId);
  const upVault = deriveVaultPda(round, 0);
  const downVault = deriveVaultPda(round, 1);

  const data = Buffer.alloc(8 + 1 + 8 + 8 + 8 + 32 + 32);
  CREATE_ROUND_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(marketCode, 8);
  data.writeBigInt64LE(roundId, 9);
  data.writeBigInt64LE(BigInt(lockTs), 17);
  data.writeBigInt64LE(BigInt(endTs), 25);
  Buffer.from(feedIdHex, "hex").copy(data, 33);
  params.oraclePriceAccount.toBuffer().copy(data, 65);

  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  });
}

export function buildLockRoundInstruction(params: { marketKey: string; roundStartMs: number; oraclePrice: PublicKey }): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const config = deriveConfigPda();
  const round = deriveRoundPda(marketCode, roundId);
  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: params.oraclePrice, isSigner: false, isWritable: false }
    ],
    data: LOCK_ROUND_DISCRIMINATOR
  });
}

export function buildSettleRoundInstruction(params: {
  marketKey: string;
  roundStartMs: number;
  treasury: PublicKey;
  oraclePrice: PublicKey;
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const config = deriveConfigPda();
  const round = deriveRoundPda(marketCode, roundId);
  const upVault = deriveVaultPda(round, 0);
  const downVault = deriveVaultPda(round, 1);
  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true },
      { pubkey: params.oraclePrice, isSigner: false, isWritable: false },
      { pubkey: params.treasury, isSigner: false, isWritable: true }
    ],
    data: SETTLE_ROUND_DISCRIMINATOR
  });
}

export function buildClaimInstruction(params: {
  user: PublicKey;
  marketKey: string;
  roundStartMs: number;
  direction: "UP" | "DOWN";
}): TransactionInstruction {
  const marketCode = marketKeyToCode(params.marketKey);
  const roundId = roundIdFromStartMs(params.roundStartMs);
  const side = directionToSide(params.direction);

  const round = deriveRoundPda(marketCode, roundId);
  const position = derivePositionPda(round, params.user, side);
  const upVault = deriveVaultPda(round, 0);
  const downVault = deriveVaultPda(round, 1);

  return new TransactionInstruction({
    programId: PANCHO_PROGRAM_ID,
    keys: [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: round, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: upVault, isSigner: false, isWritable: true },
      { pubkey: downVault, isSigner: false, isWritable: true }
    ],
    data: CLAIM_DISCRIMINATOR
  });
}

export function decodeRoundAccount(data: Buffer): OnchainRoundState | null {
  if (data.length < 152 || !data.subarray(0, 8).equals(ROUND_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    oraclePriceAccount: new PublicKey(data.subarray(49, 81)),
    lockTs: Number(data.readBigInt64LE(81)),
    endTs: Number(data.readBigInt64LE(89)),
    status: data.readUInt8(117),
    winnerSide: data.readUInt8(118),
    upTotal: data.readBigUInt64LE(119),
    downTotal: data.readBigUInt64LE(127),
    distributableLamports: data.readBigUInt64LE(143)
  };
}

export function decodeConfigAccount(data: Buffer): OnchainConfigState | null {
  if (data.length < 200 || !data.subarray(0, 8).equals(CONFIG_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    treasury: new PublicKey(data.subarray(40, 72)),
    oracleAccountSol: new PublicKey(data.subarray(104, 136)),
    oracleAccountBtc: new PublicKey(data.subarray(136, 168)),
    oracleAccountEth: new PublicKey(data.subarray(168, 200))
  };
}

export function configOracleForMarket(config: OnchainConfigState, marketCode: number): PublicKey {
  if (marketCode === 0) return config.oracleAccountSol;
  if (marketCode === 1) return config.oracleAccountBtc;
  if (marketCode === 2) return config.oracleAccountEth;
  throw new Error(`Unsupported market code: ${marketCode}`);
}

export function decodePositionAccount(data: Buffer): OnchainPositionState | null {
  if (data.length < 83 || !data.subarray(0, 8).equals(POSITION_ACCOUNT_DISCRIMINATOR)) {
    return null;
  }
  return {
    side: data.readUInt8(72),
    amountLamports: data.readBigUInt64LE(73),
    claimed: data.readUInt8(81) === 1
  };
}

export function estimatePositionPayoutLamports(round: OnchainRoundState, position: OnchainPositionState): bigint {
  const zero = BigInt(0);
  if (position.amountLamports === zero) {
    return zero;
  }
  const total = round.upTotal + round.downTotal;
  if (total <= zero || round.distributableLamports <= zero) {
    return zero;
  }
  if (round.winnerSide === 255) {
    return (position.amountLamports * round.distributableLamports) / total;
  }
  if (position.side !== round.winnerSide) {
    return zero;
  }
  const winnerTotal = round.winnerSide === 0 ? round.upTotal : round.downTotal;
  if (winnerTotal <= zero) {
    return zero;
  }
  return (position.amountLamports * round.distributableLamports) / winnerTotal;
}
