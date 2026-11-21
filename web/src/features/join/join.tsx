"use client";

import type { Address } from "viem";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useBlockNumber, useChainId, useConnection, useReadContracts } from "wagmi";
import { useAutoConnect } from "~/chain/burner/use-auto-connect";
import { networkOf } from "~/chain/config";
import { useDeployment } from "~/chain/contracts";
import { formatAmount } from "~/chain/format";
import { isPushed, useOnBlock } from "~/chain/live";
import { ConnectHint, FormError, NotDeployed, PageHeader, Section, Stat } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Vetoes } from "~/features/investors/investors";

/** The way in for the people in the room: one button makes a visitor an investor with a vote on vetoes. */
export function Join() {
  const t = useTranslations("join");
  const fund = useDeployment("Fund");
  const { address } = useConnection();
  useAutoConnect();

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t("title")} description={t("description")} />
      {fund === undefined
        ? <NotDeployed name="Fund" />
        : address === undefined ? <ConnectHint /> : <Membership investor={address} />}
    </div>
  );
}

interface JoinResponse {
  status: "joined" | "member" | "full";
  blockNumber?: string;
}

function Membership({ investor }: { investor: Address }) {
  const t = useTranslations("join");
  const chainId = useChainId();
  const fund = useDeployment("Fund")!;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...fund, functionName: "balanceOf", args: [investor] },
      { ...fund, functionName: "totalSupply" },
    ],
  });
  useOnBlock(() => void refetch());
  const [shares, supply] = (data ?? []) as [bigint?, bigint?];

  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string>();
  // The gas money a new member is sent can only be spent once it is a few blocks old.
  const [fundedAt, setFundedAt] = useState<bigint>();
  const delay = BigInt(networkOf(chainId)?.spendDelayBlocks ?? 0);
  const { data: block } = useBlockNumber({ watch: { poll: !isPushed(chainId) }, query: { enabled: fundedAt !== undefined && delay > 0n } });
  const ready = fundedAt === undefined || delay === 0n || (block !== undefined && block >= fundedAt + delay);

  async function join() {
    setJoining(true);
    setError(undefined);
    try {
      const response = await fetch("/api/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId, address: investor }),
      });
      if (!response.ok) {
        throw new Error(`/api/join failed with HTTP ${response.status}.`);
      }
      const result = await response.json() as JoinResponse;
      if (result.status === "full") {
        setError(t("full"));
      }
      if (result.blockNumber !== undefined) {
        setFundedAt(BigInt(result.blockNumber));
      }
      await refetch();
    } catch (cause) {
      console.error(cause);
      setError(t("failed"));
    } finally {
      setJoining(false);
    }
  }

  if (shares === undefined || supply === undefined) {
    return null;
  }
  if (shares === 0n) {
    return (
      <div className="flex flex-col gap-3">
        <Button size="lg" disabled={joining} onClick={join}>{joining ? t("joining") : t("button")}</Button>
        {error !== undefined && <FormError>{error}</FormError>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="membership">
      <section className="grid grid-cols-2 gap-6 border-y py-6">
        <Stat label={t("shares")} value={formatAmount(shares, 18, 2)} />
        <Stat label={t("share")} value={`${(Number(shares * 10_000n / supply) / 100).toFixed(2)}%`} />
      </section>
      {ready ? <Vetoes investor={investor} /> : <Section title={t("title")}><p className="text-[15px] text-muted-foreground">{t("preparing")}</p></Section>}
      <Button asChild variant="secondary"><Link href="/room">{t("watch")}</Link></Button>
    </div>
  );
}
