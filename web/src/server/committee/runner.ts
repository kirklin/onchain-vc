import type { Address, Hex } from "viem";
import type { ChainServices } from "../services";
import type { MeetingContext, Seat } from "./meeting";
import type { RoleKey, StageKey } from "~/chain/committee";
import { encodeFunctionData, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROLES, SETTLED, STAGES } from "~/chain/committee";
import { addressOn } from "~/chain/contracts";
import { DEFAULT_GAS_MARGIN_PERCENT, networks } from "~/chain/networks";
import { committeeAbi, faucetAbi, tokenAbi } from "~/contracts/abis";
import { database } from "../db";
import { serverEnv } from "../env";
import { fileStore } from "../files";
import { Operator } from "../operator";
import { chainServices } from "../services";
import { meetingBus } from "./bus";
import { holdMilestoneMeeting, holdPitchMeeting, loadDeal } from "./meeting";
import { partnerModel } from "./models";
import { profileHash, profileOf } from "./profiles";

/**
 * Meetings held at the same time, so that a room of founders pitching together is heard
 * together. Each meeting keeps up to four model streams open, and its votes touch only its
 * own deal, so the chain takes them side by side.
 */
const CONCURRENCY = 32;
/** What a partner's gas balance is raised to on live chains, and when. */
const GAS_TARGET = parseEther("0.5");
const GAS_LOW = parseEther("0.2");
const STAGES_RUNNING: readonly StageKey[] = ["review", "approved", "offered", "funded", "milestone"];

/**
 * Speaks for the partners whose keys this server holds, on one chain. It looks at the
 * deals once per block, holds a meeting wherever one of its seats still has to speak, and
 * closes deals whose time ran out. Meetings that fail are tried again on a later block.
 */
export class CommitteeRunner {
  readonly #context: MeetingContext;
  readonly #services: ChainServices;
  readonly #keys: Hex[];
  #seats: Seat[] = [];
  readonly #busy = new Set<number>();
  /** Deals nothing more can happen to, or nothing more is asked of this server. */
  readonly #settled = new Set<number>();
  readonly #stages = new Map<number, StageKey>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;

  constructor(context: MeetingContext, services: ChainServices, keys: Hex[]) {
    this.#context = context;
    this.#services = services;
    this.#keys = keys;
  }

  start() {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;
    const pass = () => {
      this.tick()
        .catch(error => console.error(`The committee on chain ${this.#context.chainId} failed a pass, retrying.`, error))
        .finally(() => {
          if (!this.#stopped) {
            this.#timer = setTimeout(pass, this.#services.network.chain.blockTime ?? 1000);
          }
        });
    };
    pass();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  /** Finds the seats this server holds, publishes their profiles and keeps them in gas. */
  async prepare() {
    const { client, committee } = this.#context;
    const seats = await client.readContract({ address: committee, abi: committeeAbi, functionName: "getSeats" });
    const mine = this.#keys.map(key => ({ key, account: privateKeyToAccount(key).address }));
    this.#seats = seats.flatMap((holder, index) => {
      const found = mine.find(item => item.account === getAddress(holder));
      if (found === undefined) {
        return [];
      }
      const role = ROLES[index] as RoleKey;
      return [{
        role,
        account: found.account,
        profile: profileOf(role),
        wallet: new Operator({ key: found.key, chain: this.#services.network.chain, gateway: this.#services.gateway }),
      }];
    });

    await this.#fuel();
    await this.#rebond();
    for (const seat of this.#seats) {
      const name = seat.profile.name;
      const hash = profileHash(seat.profile, this.#context.modelName);
      const current = await client.readContract({ address: committee, abi: committeeAbi, functionName: "getPartner", args: [seat.account] });
      if (current.name === name && current.profileHash === hash) {
        continue;
      }
      const data = encodeFunctionData({ abi: committeeAbi, functionName: "setProfile", args: [name, hash] });
      const gas = await client.estimateGas({ account: seat.account, to: committee, data });
      await seat.wallet.send({ to: committee, data, gas: gas + gas * BigInt(this.#context.gasMarginPercent) / 100n });
    }
  }

  get seats(): readonly Seat[] {
    return this.#seats;
  }

  /** Tops up the partners' gas from the operator through the Faucet. The local chain funds them at genesis. */
  async #fuel() {
    const { client } = this.#context;
    const faucet = addressOn("Faucet", client.chain.id);
    const operator = this.#services.operator;
    if (client.chain.id === 31_337 || faucet === undefined || operator === undefined) {
      return;
    }
    const balances = await Promise.all(this.#seats.map(seat => client.getBalance({ address: seat.account })));
    const low = this.#seats.filter((_, index) => balances[index]! < GAS_LOW).map(seat => seat.account);
    if (low.length === 0) {
      return;
    }
    const data = encodeFunctionData({ abi: faucetAbi, functionName: "drip", args: [low, GAS_TARGET] });
    const value = GAS_TARGET * BigInt(low.length);
    const gas = await client.estimateGas({ account: operator.address, to: faucet, data, value });
    await operator.send({ to: faucet, data, value, gas: gas + gas / 5n });
  }

  /**
   * Posts what is missing from the bond of each seat this server holds, as whoever runs a
   * partner must after a veto has cost it part of its bond: a seat below the minimum cannot
   * vote. The operator pays from its own tokens, and mints them where it owns the asset.
   */
  async #rebond() {
    const { client, committee, asset, gasMarginPercent } = this.#context;
    const operator = this.#services.operator;
    if (operator === undefined || this.#seats.length === 0) {
      return;
    }
    const minBond = await client.readContract({ address: committee, abi: committeeAbi, functionName: "minBond" });
    const partners = await Promise.all(this.#seats.map(seat => client.readContract({ address: committee, abi: committeeAbi, functionName: "getPartner", args: [seat.account] })));
    const short = this.#seats.flatMap((seat, index) => partners[index]!.bond < minBond ? [{ account: seat.account, missing: minBond - partners[index]!.bond }] : []);
    if (short.length === 0) {
      return;
    }
    const total = short.reduce((sum, item) => sum + item.missing, 0n);
    const send = async (to: Address, data: Hex) => {
      const gas = await client.estimateGas({ account: operator.address, to, data });
      await operator.send({ to, data, gas: gas + gas * BigInt(gasMarginPercent) / 100n });
    };

    const [held, owner] = await Promise.all([
      client.readContract({ address: asset.address, abi: tokenAbi, functionName: "balanceOf", args: [operator.address] }),
      client.readContract({ address: asset.address, abi: tokenAbi, functionName: "owner" }),
    ]);
    if (held < total) {
      if (getAddress(owner) !== operator.address) {
        throw new Error(`The operator holds ${held} of the ${total} ${asset.symbol} the partners' bonds are short of, and cannot mint more.`);
      }
      await send(asset.address, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [operator.address, total - held] }));
    }
    await send(asset.address, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [committee, total] }));
    for (const item of short) {
      await send(committee, encodeFunctionData({ abi: committeeAbi, functionName: "postBond", args: [item.account, item.missing] }));
    }
  }

  async tick() {
    const { client, committee, chainId, bus } = this.#context;
    const count = Number(await client.readContract({ address: committee, abi: committeeAbi, functionName: "dealCount" }));
    const { timestamp } = await client.getBlock();

    for (let dealId = 1; dealId <= count; dealId += 1) {
      if (this.#settled.has(dealId) || this.#busy.has(dealId)) {
        continue;
      }
      const deal = await loadDeal(this.#context, dealId);
      const stage = STAGES[deal.stage]!;
      if (this.#stages.get(dealId) !== stage) {
        this.#stages.set(dealId, stage);
        bus.emit({ chainId, type: "stage", dealId, stage });
        // A veto has just cost the approving seats part of their bonds.
        if (stage === "vetoed") {
          await this.#rebond();
        }
      }

      // A running deal whose time ran out is closed, which returns what was set aside for it.
      if (STAGES_RUNNING.includes(stage) && BigInt(deal.deadline) < timestamp) {
        await this.#close(dealId);
        continue;
      }

      const ballots = await client.readContract({ address: committee, abi: committeeAbi, functionName: "getBallots", args: [BigInt(dealId), BigInt(deal.round)] });
      const owed = this.#seats.some(seat => !ballots[ROLES.indexOf(seat.role)]!.cast);
      const speaking = deal.round === 0
        ? (["review", "approved", "rejected"].includes(stage) && owed) || (stage === "approved" && this.#seats.some(seat => seat.role === "risk"))
        : ["milestone", "funded", "completed"].includes(stage) && owed;
      if (speaking) {
        this.#hold(dealId, deal.round === 0 ? holdPitchMeeting : holdMilestoneMeeting);
      } else if (SETTLED.includes(stage)) {
        this.#settled.add(dealId);
      }
    }
  }

  #hold(dealId: number, meeting: typeof holdPitchMeeting) {
    if (this.#busy.size >= CONCURRENCY) {
      return;
    }
    this.#busy.add(dealId);
    const { chainId, bus } = this.#context;
    meeting(this.#context, this.#seats, dealId)
      .catch((error: unknown) => {
        console.error(`The meeting on deal ${dealId} failed and will be held again.`, error);
        bus.emit({ chainId, type: "failed", dealId, round: 0, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        bus.finish(chainId, dealId);
        this.#busy.delete(dealId);
      });
  }

  /** Ends a deal whose time ran out, returning what was set aside for it to the fund. */
  async #close(dealId: number) {
    const operator = this.#services.operator;
    if (operator === undefined) {
      return;
    }
    const { client, committee } = this.#context;
    const data = encodeFunctionData({ abi: committeeAbi, functionName: "close", args: [BigInt(dealId)] });
    const gas = await client.estimateGas({ account: operator.address, to: committee, data });
    await operator.send({ to: committee, data, gas: gas + gas / 5n });
  }
}

// One runner per chain per process. Stored on globalThis so dev-server reloads do not start a second one.
const holder = globalThis as typeof globalThis & { onchainVcRunners?: Promise<CommitteeRunner[]> };

/** Starts the partners on every enabled chain where the committee is deployed and this server holds seats. */
export function startCommittees(): Promise<CommitteeRunner[]> {
  holder.onchainVcRunners ??= (async () => {
    const env = serverEnv();
    if (!env.committeeEnabled) {
      return [];
    }
    const model = await partnerModel();
    const runners: CommitteeRunner[] = [];
    for (const name of env.networkNames) {
      const keys = env.partnerKeys(name);
      const services = chainServices(networks[name].chain.id)!;
      const chainId = services.network.chain.id;
      const committee = addressOn("Committee", chainId);
      const fund = addressOn("Fund", chainId);
      const token = addressOn("Token", chainId);
      if (keys === undefined || committee === undefined || fund === undefined || token === undefined) {
        continue;
      }
      const [symbol, decimals] = await Promise.all([
        services.client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
        services.client.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }),
      ]);
      const runner = new CommitteeRunner({
        chainId,
        client: services.client,
        database: await database(),
        files: fileStore(),
        bus: meetingBus(),
        model,
        modelName: env.partnerModel,
        committee,
        fund,
        asset: { address: token as Address, symbol, decimals },
        gasMarginPercent: services.network.gasMarginPercent ?? DEFAULT_GAS_MARGIN_PERCENT,
      }, services, keys);
      await runner.prepare();
      runner.start();
      runners.push(runner);
    }
    return runners;
  })();
  return holder.onchainVcRunners;
}
