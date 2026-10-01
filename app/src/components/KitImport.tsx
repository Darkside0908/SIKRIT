import { useRef } from "react";

/** File picker for a capsule kit that did not arrive through this browser's mailbox. */
export function KitImport({
  onImport,
  rejected,
  message,
}: {
  onImport: (text: string) => void;
  rejected?: boolean;
  message?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-ink-600 p-4 text-sm text-bone-400">
      <span>{rejected ? "Try another kit file." : (message ?? "No kit for this capsule in this browser.")}</span>
      <button className="btn-ghost py-1.5 text-xs" onClick={() => fileRef.current?.click()}>
        Import kit file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void file.text().then(onImport);
          e.target.value = "";
        }}
      />
    </div>
  );
}
