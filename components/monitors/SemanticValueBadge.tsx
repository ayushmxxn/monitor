import {
  DollarSign,
  TrendingUp,
  Percent,
  Users,
  Eye,
  Star,
  HardDrive,
  Clock,
  Hash,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeSemanticType, type SemanticValueType } from '@/lib/monitors/semanticValue';

const TYPE_ICON: Record<SemanticValueType, React.ReactNode> = {
  currency: <DollarSign className="h-3 w-3" />,
  revenue: <TrendingUp className="h-3 w-3" />,
  percentage: <Percent className="h-3 w-3" />,
  followers: <Users className="h-3 w-3" />,
  views: <Eye className="h-3 w-3" />,
  stars: <Star className="h-3 w-3" />,
  storage: <HardDrive className="h-3 w-3" />,
  duration: <Clock className="h-3 w-3" />,
  count: <Hash className="h-3 w-3" />,
  number: <Hash className="h-3 w-3" />,
  text: <Type className="h-3 w-3" />,
};

/**
 * A tiny inline tag showing what kind of value was detected
 * (currency, followers, storage, ...). Purely informational — the
 * value itself is always displayed using its original formatted text
 * elsewhere; this just tells the user how that text was understood.
 * Renders nothing for the 'text' fallback and 'number' (too generic
 * to be worth a badge) unless `showGeneric` is set.
 */
export function SemanticValueBadge({
  type,
  showGeneric = false,
  className,
}: {
  type: SemanticValueType;
  showGeneric?: boolean;
  className?: string;
}) {
  if (!showGeneric && (type === 'text' || type === 'number')) return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      title={describeSemanticType(type)}
    >
      {TYPE_ICON[type]}
      {describeSemanticType(type)}
    </span>
  );
}
