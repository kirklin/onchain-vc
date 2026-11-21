"use client";

import type { FormEvent } from "react";
import type { Address } from "viem";
import type { PitchDocument } from "~/chain/committee";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { useBytecode, useConfig, useConnection, useReadContract } from "wagmi";
import { readContract, writeContract } from "wagmi/actions";
import { useAutoConnect } from "~/chain/burner/use-auto-connect";
import { isCommitteeText, MAX_NAME_BYTES } from "~/chain/committee";
import { useDeployment } from "~/chain/contracts";
import { storeDocument, useFund } from "~/chain/deals";
import { isDecimal } from "~/chain/format";
import { useRelay } from "~/chain/relay";
import { useTransact } from "~/chain/transact";
import { ConnectHint, Field, FormError, NotDeployed, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";

const MAX_SUMMARY = 140;
const MAX_DESCRIPTION = 2000;
const MAX_LINKS = 5;
const DELEGATION_PREFIX = "0xef0100";

export function Pitch() {
  const t = useTranslations("pitch");
  const committee = useDeployment("Committee");
  const { address } = useConnection();
  useAutoConnect();

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t("title")} description={t("description")} />
      {committee === undefined
        ? <NotDeployed name="Committee" />
        : address === undefined ? <ConnectHint /> : <PitchForm founder={address} />}
    </div>
  );
}

function PitchForm({ founder }: { founder: Address }) {
  const t = useTranslations("pitch");
  const id = useId();
  const ids = { project: `${id}project`, name: `${id}name`, summary: `${id}summary`, description: `${id}description`, links: `${id}links`, ask: `${id}ask` };
  const router = useRouter();
  const config = useConfig();
  const committee = useDeployment("Committee")!;
  const fund = useFund();
  const { transact, pending } = useTransact();
  const { available: relayed, relay } = useRelay();
  const { data: openDeal } = useReadContract({ ...committee, functionName: "openDealOf", args: [founder] });

  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState("");
  const [ask, setAsk] = useState("");
  const [error, setError] = useState<string>();

  const projectAddress = isAddress(project.trim()) ? getAddress(project.trim()) : undefined;
  const { data: code, isFetched: codeChecked } = useBytecode({ address: projectAddress, query: { enabled: projectAddress !== undefined } });
  const isContract = code !== undefined && code !== null && code !== "0x" && !code.startsWith(DELEGATION_PREFIX);

  if (openDeal !== undefined && openDeal > 0n) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-2xl bg-fill p-6">
        <p className="font-medium">{t("busy")}</p>
        <Button asChild><Link href={`/deals/${openDeal}`}>{t("viewOpen")}</Link></Button>
      </div>
    );
  }

  const linkList = links.split("\n").map(line => line.trim()).filter(line => line !== "");
  const maxAsk = fund === undefined ? undefined : Number(formatUnits(fund.maxAsk, fund.decimals));

  function problem(): string | undefined {
    if (projectAddress === undefined) {
      return t("invalidProject");
    }
    if (!isContract) {
      return t("notContract");
    }
    if (!isCommitteeText(name.trim(), MAX_NAME_BYTES)) {
      return t("invalidName");
    }
    if (summary.trim() === "") {
      return t("summaryRequired");
    }
    if (linkList.length > MAX_LINKS || linkList.some(link => !URL.canParse(link) || !/^https?:/.test(link))) {
      return t("invalidLinks", { count: MAX_LINKS });
    }
    if (!isDecimal(ask) || Number(ask) <= 0 || (maxAsk !== undefined && Number(ask) > maxAsk)) {
      return t("invalidAsk", { max: maxAsk ?? 0 });
    }
    return undefined;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = problem();
    setError(found);
    if (found !== undefined || fund === undefined || projectAddress === undefined) {
      return;
    }

    const document: PitchDocument = {
      kind: "pitch",
      project: projectAddress,
      name: name.trim(),
      summary: summary.trim(),
      description: description.trim(),
      links: linkList,
      ask: Number(ask),
    };
    let cid: string;
    try {
      cid = await storeDocument(document);
    } catch (cause) {
      console.error(cause);
      setError(t("storeFailed"));
      return;
    }

    const call = { ...committee, functionName: "pitch", args: [projectAddress, parseUnits(ask, fund.decimals), document.name, cid] } as const;
    const receipt = await transact(
      () => (relayed ? relay(call, { from: founder }) : writeContract(config, call)),
      {
        title: t("submitTitle"),
        success: t("submitted"),
        errors: {
          NotAContract: t("notContract"),
          AskOutOfRange: t("invalidAsk", { max: maxAsk ?? 0 }),
          InvalidText: t("invalidName"),
          FounderBusy: t("busy"),
          ProjectTaken: t("taken"),
        },
        unprompted: relayed,
      },
    );
    if (receipt !== undefined) {
      const id = await readContract(config, { ...committee, functionName: "openDealOf", args: [founder] });
      router.push(`/deals/${id}`);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <Field label={t("project")} htmlFor={ids.project} trailing={projectAddress !== undefined && codeChecked ? <span className={isContract ? "text-success" : "text-destructive"}>{isContract ? t("contractFound", { bytes: (code!.length - 2) / 2 }) : t("notContract")}</span> : undefined}>
        <input id={ids.project} value={project} onChange={e => setProject(e.target.value)} placeholder="0x…" autoComplete="off" autoCapitalize="none" spellCheck={false} className="w-full bg-transparent font-mono text-base outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("name")} htmlFor={ids.name} trailing={<span className="tabular-nums">{`${new TextEncoder().encode(name.trim()).length}/${MAX_NAME_BYTES}`}</span>}>
        <input id={ids.name} value={name} onChange={e => setName(e.target.value)} placeholder={t("namePlaceholder")} className="w-full bg-transparent text-lg outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("summary")} htmlFor={ids.summary} trailing={<span className="tabular-nums">{`${summary.trim().length}/${MAX_SUMMARY}`}</span>}>
        <input id={ids.summary} value={summary} maxLength={MAX_SUMMARY} onChange={e => setSummary(e.target.value)} placeholder={t("summaryPlaceholder")} className="w-full bg-transparent text-base outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("details")} htmlFor={ids.description}>
        <textarea id={ids.description} value={description} maxLength={MAX_DESCRIPTION} rows={5} onChange={e => setDescription(e.target.value)} placeholder={t("detailsPlaceholder")} className="w-full resize-none bg-transparent text-base outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("links")} htmlFor={ids.links}>
        <textarea id={ids.links} value={links} rows={2} onChange={e => setLinks(e.target.value)} placeholder={t("linksPlaceholder")} className="w-full resize-none bg-transparent font-mono text-sm outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("ask")} htmlFor={ids.ask} trailing={maxAsk === undefined ? undefined : <span>{t("maxAsk", { max: maxAsk, symbol: fund!.symbol })}</span>}>
        <div className="flex items-center gap-3">
          <input id={ids.ask} value={ask} onChange={e => setAsk(e.target.value.trim())} inputMode="decimal" placeholder="0" autoComplete="off" className="w-full min-w-0 bg-transparent text-3xl font-semibold tracking-tight tabular-nums outline-none placeholder:text-faint-foreground/70" />
          <span className="font-semibold">{fund?.symbol}</span>
        </div>
      </Field>
      {error !== undefined && <FormError>{error}</FormError>}
      <Button type="submit" size="lg" className="mt-3" disabled={pending}>{pending ? t("submitting") : t("submit")}</Button>
      <p className="text-center text-sm text-muted-foreground">{relayed ? t("freeHint") : t("gasHint")}</p>
    </form>
  );
}
