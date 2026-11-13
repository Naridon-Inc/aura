// Keeps the team side of the cloud running for as long as the app is open:
// your presence, @mentions that reach you wherever in the app you are, and
// pokes from teammates.

import { useEffect } from "react";

import { startCloudPokes } from "./cloudPokes";
import { startCloudTeam } from "./cloudTeamStore";
import { PokeOverlay } from "./PokeOverlay";

export function CloudTeamHost() {
  useEffect(() => startCloudTeam(), []);
  useEffect(() => startCloudPokes(), []);
  return <PokeOverlay />;
}
