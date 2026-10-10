import { SystemInfoView } from "../../../features/system/system-card.tsx";
import { useSystemInfo } from "../../../features/system/use-system-info.ts";

/** System overview: real host information collected by the privileged agent. */
export default function SystemApp() {
  const state = useSystemInfo();
  return (
    <div className="h-full overflow-y-auto p-5">
      <SystemInfoView state={state} />
    </div>
  );
}
