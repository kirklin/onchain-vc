/** Runs once when the server starts. Next.js calls it in every runtime, and the indexer and the partners need Node. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIndexers } = await import("./server/indexing");
    const { startCommittees } = await import("./server/committee/runner");
    await startIndexers();
    await startCommittees();
  }
}
