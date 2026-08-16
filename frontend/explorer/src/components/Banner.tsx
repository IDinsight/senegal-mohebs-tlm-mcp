import { Loader2 } from "lucide-react";

type Props = {
  kind: "load" | "err";
  text: string;
  retryLabel?: string;
  onRetry?: (() => void) | null;
};

// The transient loading / error strip below the header. On error it can offer a
// retry button (used when a graph fails to load).
export function Banner({ kind, text, retryLabel, onRetry }: Props) {
  return (
    <div
      className={`flex items-center gap-2.5 border-b border-line px-[22px] py-3.5 text-[13px] ${
        kind === "err" ? "text-err" : "text-muted"
      }`}
    >
      {kind === "load" && <Loader2 size={14} className="flex-shrink-0 animate-spin" />}
      <span>{text}</span>
      {kind === "err" && onRetry && (
        <button
          className="rounded-md border border-line px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-txt"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
