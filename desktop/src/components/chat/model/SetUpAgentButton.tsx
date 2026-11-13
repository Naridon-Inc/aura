// What the model picker shows when there is nothing to pick: no agent signed
// in and no key added. A picker with no rows reads as broken, so the composer
// says what is missing and opens the page that fixes it.

import { Settings } from "lucide-react";
import { Button } from "../../ui/button";
import { openModelSettings } from "./openModelSettings";

export function SetUpAgentButton({ disabled }: { disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      title="No agent set up yet."
      onClick={() => openModelSettings("agents")}
    >
      <Settings style={{ width: 12, height: 12 }} />
      Set up an agent
    </Button>
  );
}
