import { STATUS_CLASS, STATUS_LABEL } from "@/components/format";

export function LeadStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status] ?? ""}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
