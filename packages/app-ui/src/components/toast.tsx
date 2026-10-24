import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "neutral" | "danger";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

/** Brief messages inside the app window ("Copied", "Exported"); errors stay longer. */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, tone: Tone = "neutral") => {
    if (!text) return;
    const id = Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((toast) => toast.id !== id)),
      tone === "danger" ? 6000 : 2500,
    );
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="eui-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="eui-toast"
            data-tone={toast.tone}
            role={toast.tone === "danger" ? "alert" : "status"}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: Tone) => void {
  return useContext(ToastContext);
}
