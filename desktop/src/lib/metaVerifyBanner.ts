// What the "Why & proof" banner is allowed to say.
//
// The panel's green state is the strongest claim Aura makes anywhere:
//
//     ✓ Verified on this clone     12 of 40 changes proven
//
// It was gated on `report.ok && report.proven > 0`, and `proven` was counted
// in the engine like this:
//
//     let proof = note_body(repo, PROOF_REF, oid).and_then(parse_proof_note);
//     match &proof { Some(p) => { proven += 1; … } }
//
// — incremented for any proof note that parsed. But a proof note records a
// verdict: "verified", "partial", "not_wired" or "unknown". A commit whose
// goals were never wired up carries a proof that says exactly that, and it
// was counted as proven. So the panel could show a green shield reading
// "Verified on this clone" over evidence stating the opposite.
//
// The engine now counts by verdict and reports `proofs` (a proof exists),
// `proven` (it says verified) and `partial` separately, flags proof notes it
// couldn't read instead of folding them into "none recorded", and says when
// the walk stopped at its 200-commit cap rather than letting `commits` read
// as the size of the repo.
//
// One more trap this module exists to close: `aura` on PATH can be older than
// the app (the CLI is bundled, but a stale `~/.cargo/bin/aura` wins if it's
// first). An older engine sends no `proofs` field at all, and its `proven`
// still means "a note is here". Absence of a field is not a zero and it is
// certainly not good news — so when the shape says "older engine", the banner
// says it can't grade the proofs rather than repeating the old lie.

/** The verify roll-up, as much of it as this banner needs. Fields the older
 *  engine doesn't send are optional — and their absence is load-bearing. */
export type VerifyReportLike = {
  commits: number;
  intent_covered: number;
  proven: number;
  issues: string[];
  ok: boolean;
  /** Commits carrying a proof snapshot at all. Absent from older engines. */
  proofs?: number;
  /** Commits whose proof reads "partial". Absent from older engines. */
  partial?: number;
  /** True when the walk stopped at the cap with history still to go. */
  truncated?: boolean;
};

export type VerifyTone = "ok" | "warn" | "calm";

export type VerifyBanner = {
  tone: VerifyTone;
  title: string;
  /** The basis for the title — always a number this report actually carries. */
  detail: string;
  /** How much was looked at, when that isn't "everything". */
  scope: string | null;
};

/** True when the engine that wrote this report grades proofs by verdict. An
 *  older one sends `proven` meaning "a proof note is present", which is not
 *  the same claim and must not be rendered as one. */
export function gradesVerdicts(r: VerifyReportLike): boolean {
  return typeof r.proofs === "number";
}

function changes(n: number): string {
  return `${n} change${n === 1 ? "" : "s"}`;
}

/** The cap in the engine is 200 commits; past that `commits` is the most
 *  recent slice and not the history. A roll-up that doesn't say so reads as
 *  a claim about all of it. */
function scopeLine(r: VerifyReportLike): string | null {
  return r.truncated
    ? `Checked the most recent ${changes(r.commits)}. There's more history before that.`
    : null;
}

export function verifyBanner(r: VerifyReportLike): VerifyBanner {
  const scope = scopeLine(r);

  // Something needs a look. This wins over every other state: a mis-bound or
  // unreadable proof means the evidence itself is in question.
  if (!r.ok) {
    const n = r.issues.length;
    return {
      tone: "warn",
      title: `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a look`,
      detail: r.issues[0] ?? "",
      scope,
    };
  }

  // An engine that doesn't grade verdicts can't tell us whether the proofs
  // passed — only that they exist. Say that, don't guess.
  if (!gradesVerdicts(r)) {
    if (r.proven > 0) {
      return {
        tone: "calm",
        title: "Proof recorded, not graded here",
        detail: `${r.proven} of ${changes(r.commits)} carry a proof this version of Aura can’t read the verdict from. Update Aura to see whether they passed.`,
        scope,
      };
    }
    return {
      tone: "calm",
      title: "Nothing needs a look",
      detail: `${r.intent_covered} of ${changes(r.commits)} carry a reason`,
      scope,
    };
  }

  const proofs = r.proofs ?? 0;
  const partial = r.partial ?? 0;

  // Green is earned by a verdict that says verified, not by a file existing.
  if (r.proven > 0) {
    const also = partial > 0 ? `, ${partial} partly` : "";
    return {
      tone: "ok",
      title: "Verified on this copy",
      detail: `${r.proven} of ${changes(r.commits)} proven${also}`,
      scope,
    };
  }

  if (partial > 0) {
    return {
      tone: "calm",
      title: "Partly proven",
      detail: `${partial} of ${changes(r.commits)} met some of what they set out to do, none all of it`,
      scope,
    };
  }

  // Proofs exist and every one of them says the work isn't wired up. That is
  // a real finding, and the old fold printed it as "N changes proven".
  if (proofs > 0) {
    return {
      tone: "calm",
      title: "Nothing proven yet",
      detail: `${proofs} of ${changes(r.commits)} have a proof on record, and none of them found the work finished`,
      scope,
    };
  }

  return {
    tone: "calm",
    title: "Nothing needs a look",
    detail: `${r.intent_covered} of ${changes(r.commits)} carry a reason`,
    scope,
  };
}
