"use client";

import type { FormEvent } from "react";
import type { Address } from "viem";
import type { RoleKey } from "~/chain/committee";
import type { Deal } from "~/chain/deals";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useId, useState } from "react";
import { getAddress, isAddress, parseUnits } from "viem";
import { useConnection, useReadContract, useReadContracts } from "wagmi";
import { ROLES, VETOABLE } from "~/chain/committee";
import { useDeployment } from "~/chain/contracts";
import { useDeals, useEvents, useFund } from "~/chain/deals";
import { formatAmount, isDecimal, shortAddress } from "~/chain/format";
import { useChainNow, useOnBlock } from "~/chain/live";
import { useTransact } from "~/chain/transact";
import { Money, StageBadge } from "~/components/committee";
import { ConnectHint, Field, FormError, NotDeployed, PageHeader, Section, Stat } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Segmented } from "~/components/ui/segmented";

export function Investors() {
  const t = useTranslations("investors");
  const fund = useDeployment("Fund");
  const { address } = useConnection();

  if (fund === undefined) {
    return <NotDeployed name="Fund" />;
  }
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("title")} description={t("description")} />
      <Overview investor={address} />
      {address === undefined
        ? <ConnectHint />
        : (
            <>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Deposit investor={address} />
                <Redeem investor={address} />
              </div>
              <Vetoes investor={address} />
              <Seats investor={address} />
            </>
          )}
    </div>
  );
}

function useHoldings(investor: Address | undefined) {
  const fund = useDeployment("Fund")!;
  const token = useDeployment("Token")!;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    contracts: investor === undefined
      ? []
      : [
          { ...fund, functionName: "balanceOf", args: [investor] },
          { ...fund, functionName: "maxWithdraw", args: [investor] },
          { ...token, functionName: "balanceOf", args: [investor] },
          { ...token, functionName: "nextClaimAt", args: [investor] },
        ],
  });
  useOnBlock(() => void refetch());
  const [shares, value, cash, nextClaimAt] = (data ?? []) as [bigint?, bigint?, bigint?, bigint?];
  return { shares, value, cash, nextClaimAt };
}

function Overview({ investor }: { investor: Address | undefined }) {
  const t = useTranslations("investors");
  const fund = useFund();
  const { shares, value } = useHoldings(investor);
  const price = fund === undefined || fund.shares === 0n ? undefined : Number(fund.available * 10_000n / fund.shares) / 10_000;
  return (
    <section className="grid grid-cols-2 gap-6 border-y py-6 sm:grid-cols-4">
      <Stat label={t("available")} value={fund === undefined ? "…" : <Money value={fund.available} />} />
      <Stat label={t("committed")} value={fund === undefined ? "…" : <Money value={fund.committed} />} />
      <Stat label={t("sharePrice")} value={price === undefined ? "—" : price.toFixed(4)} />
      <Stat label={t("yourShare")} value={shares === undefined || fund === undefined || fund.shares === 0n ? "—" : <span data-testid="your-share">{`${(Number(shares * 10_000n / fund.shares) / 100).toFixed(2)}%`}</span>} />
      {value !== undefined && value > 0n && (
        <p className="col-span-full text-sm text-muted-foreground">
          {t("worth")}
          {" "}
          <Money value={value} />
        </p>
      )}
    </section>
  );
}

function Deposit({ investor }: { investor: Address }) {
  const t = useTranslations("investors");
  const id = useId();
  const fund = useDeployment("Fund")!;
  const token = useDeployment("Token")!;
  const stats = useFund();
  const { cash, nextClaimAt } = useHoldings(investor);
  const { write, batch, pending } = useTransact();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const now = useChainNow();
  const canClaim = nextClaimAt !== undefined && BigInt(Math.floor(now.getTime() / 1000)) >= nextClaimAt;

  async function deposit(event: FormEvent) {
    event.preventDefault();
    if (stats === undefined || !isDecimal(amount) || Number(amount) <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    const assets = parseUnits(amount, stats.decimals);
    if (cash !== undefined && assets > cash) {
      setError(t("notEnough", { symbol: stats.symbol }));
      return;
    }
    setError(undefined);
    const done = await batch([
      { to: token.address, abi: token.abi, functionName: "approve", args: [fund.address, assets] },
      { to: fund.address, abi: fund.abi, functionName: "deposit", args: [assets, investor] },
    ], { title: t("depositTitle"), success: t("deposited") });
    if (done !== undefined) {
      setAmount("");
    }
  }

  return (
    <Section title={t("deposit")} description={t("depositHint")}>
      <form onSubmit={deposit} className="flex flex-col gap-3">
        <Field label={t("amount")} htmlFor={id} trailing={stats === undefined || cash === undefined ? undefined : <span>{t("balance", { amount: formatAmount(cash, stats.decimals, 2), symbol: stats.symbol })}</span>}>
          <input id={id} value={amount} onChange={e => setAmount(e.target.value.trim())} inputMode="decimal" placeholder="0" autoComplete="off" className="w-full bg-transparent text-3xl font-semibold tracking-tight tabular-nums outline-none placeholder:text-faint-foreground/70" />
        </Field>
        {error !== undefined && <FormError>{error}</FormError>}
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" disabled={pending || !canClaim} onClick={() => write({ ...token, functionName: "claim" }, { title: t("claimTitle"), success: t("claimed", { symbol: stats?.symbol ?? "" }) })}>
            {t("claim", { symbol: stats?.symbol ?? "" })}
          </Button>
          <Button type="submit" disabled={pending}>{t("depositButton")}</Button>
        </div>
      </form>
    </Section>
  );
}

function Redeem({ investor }: { investor: Address }) {
  const t = useTranslations("investors");
  const fund = useDeployment("Fund")!;
  const { shares, value } = useHoldings(investor);
  const { write, pending } = useTransact();
  return (
    <Section title={t("redeem")} description={t("redeemHint")}>
      <div className="flex flex-col gap-1 well px-4 py-3">
        <span className="text-sm text-muted-foreground">{t("redeemable")}</span>
        <span className="text-3xl font-semibold tracking-tight">{value === undefined ? "…" : <Money value={value} />}</span>
      </div>
      <Button
        variant="secondary"
        disabled={pending || shares === undefined || shares === 0n}
        onClick={() => write({ ...fund, functionName: "redeem", args: [shares!, investor, investor] }, { title: t("redeemTitle"), success: t("redeemed") })}
      >
        {t("redeemAll")}
      </Button>
    </Section>
  );
}

/** Deals still open to a veto, each with the motion against it, if there is one. */
export function Vetoes({ investor }: { investor: Address }) {
  const t = useTranslations("investors");
  const { deals } = useDeals();
  const open = (deals ?? []).filter(deal => VETOABLE.includes(deal.stage));
  return (
    <Section title={t("vetoes")} description={t("vetoesHint")}>
      {open.length === 0
        ? <p className="text-[15px] text-muted-foreground">{t("noVetoable")}</p>
        : <ul className="flex flex-col divide-y border-y">{open.map(deal => <VetoRow key={deal.id} deal={deal} investor={investor} />)}</ul>}
    </Section>
  );
}

function VetoRow({ deal, investor }: { deal: Deal; investor: Address }) {
  const t = useTranslations("investors");
  const fund = useDeployment("Fund")!;
  const { write, pending } = useTransact();
  const { data: motionId, refetch } = useReadContract({ ...fund, functionName: "vetoMotionOf", args: [BigInt(deal.id)] });
  // The fund answers for a block only once a later one exists, so the weight is asked for again as blocks come.
  const { data: weight, refetch: refetchWeight } = useReadContract({ ...fund, functionName: "getPastVotes", args: [investor, deal.approvedAt] });
  const motion = useMotion(motionId === undefined || motionId === 0n ? undefined : motionId, investor);
  useOnBlock(() => {
    void refetch();
    if (weight === undefined) {
      void refetchWeight();
    }
  });
  const now = useChainNow();

  const open = motion !== undefined && !motion.carried && motion.deadline > now;
  const errors = { NoWeight: t("noWeight"), AlreadySupported: t("alreadySupported"), NotVetoable: t("notVetoable"), MotionPending: t("motionPending") };

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between" data-testid="veto" data-deal={deal.id}>
      <div className="flex min-w-0 flex-col gap-1">
        <Link href={`/deals/${deal.id}`} className="flex items-center gap-2 font-semibold underline-offset-4 hover:underline">
          <span className="truncate">{deal.name}</span>
          <StageBadge stage={deal.stage} />
        </Link>
        <span className="text-sm text-muted-foreground">
          {open ? t("support", { percent: motion.percent }) : t("weight", { amount: formatAmount(weight ?? 0n, 18, 2) })}
        </span>
      </div>
      {open
        ? (
            <Button variant="destructive" disabled={pending || motion.supported || weight === 0n} onClick={() => write({ ...fund, functionName: "support", args: [motionId!] }, { title: t("vetoTitle"), success: t("supported"), errors })}>
              {motion.supported ? t("alreadySupported") : t("supportVeto")}
            </Button>
          )
        : (
            <Button variant="destructive" disabled={pending || weight === undefined || weight === 0n} onClick={() => write({ ...fund, functionName: "proposeVeto", args: [BigInt(deal.id)] }, { title: t("vetoTitle"), success: t("vetoProposed"), errors })}>
              {t("proposeVeto")}
            </Button>
          )}
    </li>
  );
}

/** A motion, with how far its support has come and whether the investor is already behind it. */
function useMotion(motionId: bigint | undefined, investor: Address) {
  const fund = useDeployment("Fund")!;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    contracts: motionId === undefined
      ? []
      : [
          { ...fund, functionName: "motion", args: [motionId] },
          { ...fund, functionName: "quorumOf", args: [motionId] },
          { ...fund, functionName: "supported", args: [motionId, investor] },
        ],
  });
  useOnBlock(() => void refetch());
  if (data === undefined || motionId === undefined) {
    return undefined;
  }
  const [motion, quorum, supported] = data as [{ carried: boolean; deadline: number; support: bigint; role: number; candidate: Address; kind: number }, bigint, boolean];
  return {
    ...motion,
    deadline: new Date(motion.deadline * 1000),
    quorum,
    supported,
    percent: quorum === 0n ? 0 : Math.min(100, Number(motion.support * 100n / quorum)),
  };
}

/** Moves to give a seat to someone else, or leave it vacant, and the motions already open. */
function Seats({ investor }: { investor: Address }) {
  const t = useTranslations("investors");
  const tRoles = useTranslations("roles");
  const id = useId();
  const fund = useDeployment("Fund")!;
  const { write, pending } = useTransact();
  const [role, setRole] = useState<RoleKey>("product");
  const [candidate, setCandidate] = useState("");
  const [error, setError] = useState<string>();
  const { data: opened } = useEvents({ names: ["MotionOpened"], limit: 50 });
  const replacements = (opened ?? []).filter(event => Number(event.args.kind) === 1);

  async function propose(event: FormEvent) {
    event.preventDefault();
    const trimmed = candidate.trim();
    if (trimmed !== "" && !isAddress(trimmed)) {
      setError(t("invalidCandidate"));
      return;
    }
    setError(undefined);
    await write(
      { ...fund, functionName: "proposeReplace", args: [ROLES.indexOf(role), trimmed === "" ? "0x0000000000000000000000000000000000000000" : getAddress(trimmed)] },
      { title: t("replaceTitle"), success: t("replaceProposed"), errors: { NoWeight: t("noWeight"), CandidateUnfit: t("candidateUnfit") } },
    );
  }

  return (
    <Section title={t("seats")} description={t("seatsHint")}>
      <form onSubmit={propose} className="flex flex-col gap-3">
        <Segmented value={role} onValueChange={setRole} options={ROLES.map(item => ({ value: item, label: tRoles(item) }))} aria-label={t("seat")} />
        <Field label={t("candidate")} htmlFor={id}>
          <input id={id} value={candidate} onChange={e => setCandidate(e.target.value)} placeholder={t("candidatePlaceholder")} autoComplete="off" spellCheck={false} className="w-full bg-transparent font-mono text-base outline-none placeholder:text-faint-foreground/70" />
        </Field>
        {error !== undefined && <FormError>{error}</FormError>}
        <Button type="submit" variant="secondary" disabled={pending}>{t("proposeReplace")}</Button>
      </form>
      {replacements.length > 0 && (
        <ul className="flex flex-col divide-y border-y">
          {replacements.map(event => <ReplacementRow key={event.transactionHash} motionId={BigInt(String(event.args.motionId))} investor={investor} />)}
        </ul>
      )}
    </Section>
  );
}

function ReplacementRow({ motionId, investor }: { motionId: bigint; investor: Address }) {
  const t = useTranslations("investors");
  const tRoles = useTranslations("roles");
  const fund = useDeployment("Fund")!;
  const { write, pending } = useTransact();
  const motion = useMotion(motionId, investor);
  const now = useChainNow();
  if (motion === undefined) {
    return null;
  }
  const open = !motion.carried && motion.deadline > now;
  const vacant = BigInt(motion.candidate) === 0n;
  return (
    <li className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-[15px]">
        {vacant ? t("motionVacate", { role: tRoles(ROLES[motion.role]!) }) : t("motionSeat", { role: tRoles(ROLES[motion.role]!), candidate: shortAddress(motion.candidate) })}
        <span className="ml-2 text-sm text-muted-foreground">{motion.carried ? t("carried") : open ? t("support", { percent: motion.percent }) : t("lapsed")}</span>
      </span>
      {open && (
        <Button variant="secondary" size="sm" disabled={pending || motion.supported} onClick={() => write({ ...fund, functionName: "support", args: [motionId] }, { title: t("replaceTitle"), success: t("supported"), errors: { NoWeight: t("noWeight"), CandidateUnfit: t("candidateUnfit") } })}>
          {motion.supported ? t("alreadySupported") : t("supportButton")}
        </Button>
      )}
    </li>
  );
}
