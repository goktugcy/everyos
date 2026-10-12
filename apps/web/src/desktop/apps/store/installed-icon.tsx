import type { InstalledAppView } from "@everyos/shared";
import { Package } from "lucide-react";
import { useState } from "react";

export function InstalledAppIcon({ app }: { app: InstalledAppView }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  return app.icon && failedIcon !== app.icon ? (
    <img
      src={app.icon}
      alt=""
      draggable={false}
      loading="lazy"
      className="size-14 rounded-xl object-contain"
      onError={() => setFailedIcon(app.icon!)}
    />
  ) : (
    <span className="grid size-14 place-items-center rounded-xl bg-accent/10 text-accent">
      <Package className="size-8" aria-hidden />
    </span>
  );
}
