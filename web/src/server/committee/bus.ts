import type { Activity, MeetingEvent, MeetingSnapshot, Phase, RoleKey } from "~/chain/committee";

export type BusEvent = MeetingEvent & { chainId: number };
type Listener = (event: BusEvent) => void;

interface LiveEntry {
  phase: Phase;
  role: RoleKey;
  activity: Activity;
  tool?: string;
  text: string;
}

interface LiveMeeting {
  round: number;
  phase: Phase | null;
  entries: Map<string, LiveEntry>;
}

/**
 * Carries what happens in meetings to every open page as it happens, and remembers what each
 * partner is in the middle of, so a page that opens mid-meeting starts from the same place.
 * Finished notes are kept in the database; this only holds what is still being said.
 */
export class MeetingBus {
  readonly #listeners = new Set<Listener>();
  readonly #meetings = new Map<string, LiveMeeting>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: BusEvent) {
    this.#remember(event);
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  /** The meetings in progress on a chain, or the one about `dealId`, without their finished notes. */
  live(chainId: number, dealId?: number): MeetingSnapshot[] {
    return [...this.#meetings.entries()]
      .filter(([key]) => key.startsWith(`${chainId}:`) && (dealId === undefined || key === `${chainId}:${dealId}`))
      .map(([key, meeting]) => ({
        dealId: Number(key.split(":")[1]),
        round: meeting.round,
        phase: meeting.phase,
        notes: [],
        live: [...meeting.entries.values()],
      }));
  }

  #remember(event: BusEvent) {
    const dealId = event.type === "note" ? event.note.dealId : event.dealId;
    const key = `${event.chainId}:${dealId}`;
    switch (event.type) {
      case "phase": {
        const meeting = this.#meetings.get(key);
        if (meeting === undefined || meeting.round !== event.round) {
          this.#meetings.set(key, { round: event.round, phase: event.phase, entries: new Map() });
        } else {
          meeting.phase = event.phase;
        }
        return;
      }
      case "activity":
      case "text": {
        const meeting = this.#meetings.get(key);
        if (meeting === undefined) {
          return;
        }
        const entryKey = `${event.phase}:${event.role}`;
        const entry = meeting.entries.get(entryKey) ?? { phase: event.phase, role: event.role, activity: "reading" as Activity, text: "" };
        if (event.type === "activity") {
          entry.activity = event.activity;
          entry.tool = event.tool;
        } else {
          entry.activity = "speaking";
          entry.text = event.text;
        }
        meeting.entries.set(entryKey, entry);
        return;
      }
      case "note":
        this.#meetings.get(key)?.entries.delete(`${event.note.phase}:${event.note.role}`);
    }
  }

  /** Forgets a meeting that ended, whether it reached a decision or failed. */
  finish(chainId: number, dealId: number) {
    this.#meetings.delete(`${chainId}:${dealId}`);
  }
}

// One bus per process. Stored on globalThis so dev-server reloads keep the open streams.
const holder = globalThis as typeof globalThis & { onchainVcBus?: MeetingBus };

export function meetingBus(): MeetingBus {
  holder.onchainVcBus ??= new MeetingBus();
  return holder.onchainVcBus;
}
