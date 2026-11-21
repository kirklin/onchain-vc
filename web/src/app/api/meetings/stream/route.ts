import type { MeetingSnapshot } from "~/chain/committee";
import type { BusEvent } from "~/server/committee/bus";
import { z } from "zod";
import { meetingBus } from "~/server/committee/bus";
import { notesOf } from "~/server/committee/meeting";
import { database } from "~/server/db";

export const dynamic = "force-dynamic";

const query = z.object({
  chainId: z.coerce.number().int(),
  dealId: z.coerce.number().int().positive().optional(),
});

const KEEP_ALIVE_MS = 15_000;

function dealOf(event: BusEvent): number {
  return event.type === "note" ? event.note.dealId : event.dealId;
}

/**
 * Pushes what happens in meetings as server-sent events: first a snapshot of the meetings in
 * progress, or of the one about `dealId`, with every note so far, then each event as it
 * happens. Events that arrive while the snapshot is being read follow it, so nothing is lost
 * between the two.
 */
export async function GET(request: Request) {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { chainId, dealId } = parsed.data;
  const bus = meetingBus();
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const waiting: BusEvent[] = [];
      let ready = false;
      const unsubscribe = bus.subscribe((event) => {
        if (event.chainId !== chainId || (dealId !== undefined && dealOf(event) !== dealId)) {
          return;
        }
        if (ready) {
          send(event);
        } else {
          waiting.push(event);
        }
      });
      const timer = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), KEEP_ALIVE_MS);
      stop = () => {
        unsubscribe();
        clearInterval(timer);
      };
      request.signal.addEventListener("abort", () => {
        stop();
        controller.close();
      });

      const live = bus.live(chainId, dealId);
      const deals = dealId === undefined ? live.map(meeting => meeting.dealId) : [dealId];
      const db = await database();
      const meetings: MeetingSnapshot[] = await Promise.all(deals.map(async (id) => {
        const current = live.find(meeting => meeting.dealId === id);
        return {
          dealId: id,
          round: current?.round ?? 0,
          phase: current?.phase ?? null,
          notes: await notesOf(db, chainId, id),
          live: current?.live ?? [],
        };
      }));
      send({ type: "snapshot", meetings });
      for (const event of waiting) {
        send(event);
      }
      ready = true;
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
