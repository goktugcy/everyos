import { Alert } from "../../components/ui/alert.tsx";
import { WidgetConfigureDialog } from "./configure.tsx";
import { WidgetGallery } from "./gallery.tsx";
import { WidgetOfferDialog } from "./offer.tsx";
import { WidgetSidebar } from "./sidebar.tsx";
import { useWidgetUi } from "./ui-store.ts";

function WidgetNotice() {
  const notice = useWidgetUi((state) => state.notice);
  if (!notice) return null;
  return (
    <div
      className="fixed left-1/2 top-12 z-[75] w-[min(92vw,26rem)] -translate-x-1/2"
      role="status"
    >
      <Alert tone="warning">{notice}</Alert>
    </div>
  );
}

/** Sidebar, dialogs and feedback of the widget platform (desktop layer is separate). */
export function WidgetHost() {
  return (
    <>
      <WidgetSidebar />
      <WidgetGallery />
      <WidgetConfigureDialog />
      <WidgetOfferDialog />
      <WidgetNotice />
    </>
  );
}
