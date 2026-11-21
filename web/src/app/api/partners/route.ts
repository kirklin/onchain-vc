import { profileHash, PROFILES } from "~/server/committee/profiles";
import { serverEnv } from "~/server/env";

export const dynamic = "force-dynamic";

/**
 * The partners' profiles as this server runs them: the instructions each follows and the
 * model behind them, with the hash a partner publishes on chain. A page compares that hash
 * with the one the committee holds, so anyone can see the partner voting is this one.
 */
export async function GET() {
  const model = serverEnv().partnerModel;
  return Response.json({
    model,
    profiles: PROFILES.map(profile => ({ ...profile, model, profileHash: profileHash(profile, model) })),
  });
}
