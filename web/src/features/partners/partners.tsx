"use client";

import type { Address } from "viem";
import type { IndexedEvent, PartnerProfile, Seat } from "~/chain/deals";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useChainId } from "wagmi";
import { networkOf } from "~/chain/config";
import { useDeployment } from "~/chain/contracts";
import { useEvents, useFund, useProfiles, useSeats } from "~/chain/deals";
import { shortAddress } from "~/chain/format";
import { Money, RoleIcon } from "~/components/committee";
import { NotDeployed, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";

export function Partners() {
  const t = useTranslations("partners");
  const committee = useDeployment("Committee");
  const seats = useSeats();
  const { data: profiles } = useProfiles();
  const { data: votes } = useEvents({ names: ["Voted", "Slashed"], limit: 200 });

  if (committee === undefined) {
    return <NotDeployed name="Committee" />;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {seats?.map(seat => (
          <PartnerCard
            key={seat.role}
            seat={seat}
            profile={profiles?.profiles.find(profile => profile.role === seat.role)}
            events={votes?.filter(event => event.account === seat.account) ?? []}
          />
        ))}
      </div>
      <Candidates seated={seats?.flatMap(seat => seat.account ?? []) ?? []} />
    </div>
  );
}

function AccountLink({ address }: { address: Address }) {
  const explorer = networkOf(useChainId())?.chain.blockExplorers?.default.url;
  return explorer === undefined
    ? <span className="font-mono" title={address}>{shortAddress(address)}</span>
    : <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address} className="font-mono underline-offset-4 hover:underline">{shortAddress(address)}</a>;
}

function PartnerCard({ seat, profile, events }: { seat: Seat; profile: PartnerProfile | undefined; events: IndexedEvent[] }) {
  const t = useTranslations("partners");
  const tRoles = useTranslations("roles");
  const fund = useFund();
  const [expanded, setExpanded] = useState(false);
  const votes = events.filter(event => event.name === "Voted");
  const inFavour = votes.filter(event => event.args.inFavour === true).length;
  const slashed = events.filter(event => event.name === "Slashed").reduce((sum, event) => sum + BigInt(String(event.args.amount)), 0n);
  const matches = profile !== undefined && profile.profileHash === seat.profileHash;
  const published = seat.profileHash !== "0x" && BigInt(seat.profileHash) !== 0n;
  const bonded = fund !== undefined && seat.bond >= fund.minBond;

  return (
    <article className="flex flex-col gap-5 surface p-5 sm:p-6" data-role={seat.role}>
      <header className="flex items-center gap-3">
        <RoleIcon role={seat.role} />
        <div className="flex min-w-0 flex-col">
          <h2 className="text-heading">{tRoles(seat.role)}</h2>
          <span className="text-sm text-muted-foreground">{tRoles(`${seat.role}Brief`)}</span>
        </div>
      </header>

      {seat.account === undefined
        ? <p className="rounded-xl bg-fill px-4 py-3 text-[15px]">{t("vacant")}</p>
        : (
            <dl className="grid grid-cols-2 gap-4">
              <Fact label={t("account")}><AccountLink address={seat.account} /></Fact>
              <Fact label={t("bond")}>
                <span className={bonded ? undefined : "text-destructive"}><Money value={seat.bond} /></span>
              </Fact>
              <Fact label={t("record")}>{t("votes", { total: votes.length, inFavour })}</Fact>
              <Fact label={t("slashed")}><Money value={slashed} /></Fact>
            </dl>
          )}

      {profile !== undefined && seat.account !== undefined && (
        <div className="flex flex-col gap-3 rounded-xl bg-fill p-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {matches ? <CheckIcon className="size-4 text-success" /> : <TriangleAlertIcon className="size-4 text-destructive" />}
            {matches ? t("hashMatches") : published ? t("hashDiffers") : t("hashMissing")}
          </p>
          {published && <p className="font-mono text-xs break-all text-muted-foreground">{seat.profileHash}</p>}
          <p className="text-sm text-muted-foreground">{t("model", { model: profile.model })}</p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{t("instructions")}</span>
            <Button variant="secondary" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? t("hideInstructions") : t("showInstructions")}
            </Button>
          </div>
          {expanded && <p className="text-sm leading-relaxed whitespace-pre-wrap" data-testid="instructions">{profile.instructions}</p>}
        </div>
      )}
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-[17px] font-semibold">{children}</dd>
    </div>
  );
}

/** Accounts that published a profile without holding a seat, for investors to consider. */
function Candidates({ seated }: { seated: Address[] }) {
  const t = useTranslations("partners");
  const { data: profiles } = useEvents({ names: ["ProfileSet"], limit: 200 });
  const latest = new Map<string, IndexedEvent>();
  for (const event of [...(profiles ?? [])].reverse()) {
    if (event.account !== null && !seated.includes(event.account)) {
      latest.set(event.account, event);
    }
  }
  if (latest.size === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-heading">{t("candidates")}</h2>
      <p className="text-[15px] text-muted-foreground">{t("candidatesHint")}</p>
      <ul className="flex flex-col divide-y border-y">
        {[...latest.values()].map(event => (
          <li key={event.account} className="flex flex-wrap items-center justify-between gap-3 py-3 text-[15px]">
            <span className="font-semibold">{String(event.args.name)}</span>
            <AccountLink address={event.account!} />
          </li>
        ))}
      </ul>
    </section>
  );
}
