// "Your Aura account is your git identity" — the other half of not fighting git
// identity in a signed-in team. When an Aura account is signed in, the account
// IS the identity: this derives a stable git author from it and adopts it in one
// click, instead of leaving the user to hand-configure user.name / user.email
// (and instead of Aura silently guessing from whatever git email happens to be
// set).
//
// PLACE-AWARE, and that is the point of this revision rather than a nicety. It
// used to call `gitIdentitySet`, which shelled git in a local directory — so the
// identity could only ever be adopted on the laptop, and work that ran on a box
// came back authored by whoever the box thought it was. On a runner box that was
// a hardcoded `Aura Runner <runner@auravcs.com>`, which is worse than nothing:
// it is well-formed, it never errors, and the audit trail loses the person while
// looking completely healthy. It now asks a `Place` and writes through the same
// seam for both, so there is no mode where this feature is absent.
//
// Renders nothing when signed out — solo, git-config-derived identity still
// works exactly as before, so nothing regresses.

import { useCallback, useEffect, useState } from "react";
import { IdCard } from "lucide-react";

import { api } from "../../lib/api";
import { gitIdentityFromAccount, type GitAuthor } from "../../lib/accountIdentity";
import {
  adoptAuthor,
  askAuthor,
  needsAdopting,
  placeHere,
  whyNotMe,
  type AuthorPlan,
  type Place,
} from "../../lib/place";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { toast } from "../../lib/toast";

/** The place this row is about. `repoRoot` alone still means this laptop — the
 *  settings pane's own case — so existing callers keep working and get the same
 *  behaviour through the same seam. */
export function CloudGitIdentityRow({
  repoRoot,
  place,
}: {
  repoRoot: string;
  place?: Place | null;
}) {
  const [author, setAuthor] = useState<GitAuthor | null>(null);
  const [plan, setPlan] = useState<AuthorPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const target = place ?? placeHere(repoRoot);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const s = await api.cloudAuthStatus();
        if (alive) setAuthor(gitIdentityFromAccount(s));
      } catch {
        if (alive) setAuthor(null);
      }
    };
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("aura:cloud-auth-changed", onChange);
    return () => {
      alive = false;
      window.removeEventListener("aura:cloud-auth-changed", onChange);
    };
  }, []);

  // Whose name the next commit would carry, asked of the place rather than
  // assumed. A place that can't be reached leaves the plan null: the row then
  // offers the identity without claiming to know what is there, which is the
  // honest state rather than a claim that nothing is set.
  useEffect(() => {
    let alive = true;
    if (!author) {
      setPlan(null);
      return;
    }
    void askAuthor(target, author)
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
  }, [author, target.machineId, target.project.root]);

  const apply = useCallback(async () => {
    if (!author || busy) return;
    setBusy(true);
    try {
      const after = await adoptAuthor(target, author);
      setPlan(after);
      toast.success("Git identity set", after.note);
    } catch (e) {
      toast.danger("Couldn't set the git identity", String(e));
    } finally {
      setBusy(false);
    }
  }, [author, busy, target]);

  // Signed out / no account username → nothing to adopt; git config stands.
  if (!author) return null;

  // Already theirs. Nothing to offer, and a button that changed nothing would
  // be worse than the absence of one.
  const settled = plan !== null && !needsAdopting(plan);
  const why = plan ? whyNotMe(plan) : "";

  return (
    <div className="mb-3 rounded-lg border border-line-soft bg-bg-2/40 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm text-text-2">
        <IdCard size={14} strokeWidth={1.75} aria-hidden />
        <span className="font-medium">Your Aura account is your identity</span>
      </div>
      <p className="mb-2 text-xs text-text-4">
        Signed in, Aura can author your commits from your account — no git
        identity to set up. {plan ? `On ${plan.place}, this` : "This"} project
        will use:
      </p>
      <div className="mb-2 font-mono text-xs text-text-3">
        {author.name} &lt;{author.email}&gt;
      </div>
      {/* The uncomfortable half: what the commit would say instead. Shown only
          when it isn't already theirs, because that is the only time it is
          something to act on. */}
      {!settled && why ? (
        <p className="mb-2 text-xs text-amber-500/90">{why}</p>
      ) : null}
      <Button
        variant="accentSoft"
        size="sm"
        disabled={busy || settled}
        onClick={() => void apply()}
      >
        {busy ? (
          <>
            <AsciiSpinner /> Setting…
          </>
        ) : settled ? (
          "Using your Aura identity"
        ) : (
          "Use for this project"
        )}
      </Button>
    </div>
  );
}
