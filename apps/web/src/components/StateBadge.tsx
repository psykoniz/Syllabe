import { getBadgeClasses } from "../utils";

interface Props {
  state: string;
}

export default function StateBadge({ state }: Props) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getBadgeClasses(state)}`}
    >
      {state}
    </span>
  );
}
