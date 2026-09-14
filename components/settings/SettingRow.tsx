import { ExternalLink } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Setting rows shared by the options page and the panel's in-place
 * settings view.
 *
 * Deliberately icon-less and description-optional: a leading glyph per
 * row and a caption under every label both add visual weight without
 * adding information once rows are grouped under a section label, so
 * a description is only passed where the title alone would leave the
 * setting's effect ambiguous. Every row keeps the same shape - label
 * (+ optional caption) on the left, control on the right - so a
 * section reads as one aligned column instead of a stack of cards.
 */

const ROW_CLASS = 'flex items-center justify-between gap-4 px-3 py-2.5';
const LABEL_CLASS = 'text-[13px] leading-tight text-foreground';
const DESCRIPTION_CLASS = 'mt-0.5 text-[11.5px] leading-snug text-muted-foreground';

interface SettingRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingRow({ id, label, description, checked, disabled, onCheckedChange }: SettingRowProps) {
  return (
    <div className={ROW_CLASS}>
      <div className="min-w-0">
        <Label htmlFor={id} className={cn(LABEL_CLASS, 'font-normal')}>
          {label}
        </Label>
        {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="shrink-0" />
    </div>
  );
}

interface SettingSelectRowProps<T extends string | number> {
  id: string;
  label: string;
  description?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onValueChange: (value: T) => void;
}

/** Same shape as `SettingRow`, but with a small select instead of a toggle - for a preference with more than two states. */
export function SettingSelectRow<T extends string | number>({
  id,
  label,
  description,
  value,
  options,
  disabled,
  onValueChange,
}: SettingSelectRowProps<T>) {
  const isNumeric = typeof value === 'number';
  return (
    <div className={ROW_CLASS}>
      <div className="min-w-0">
        <Label htmlFor={id} className={cn(LABEL_CLASS, 'font-normal')}>
          {label}
        </Label>
        {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
      </div>
      <Select
        id={id}
        className="h-7 w-auto min-w-[84px] shrink-0 text-[12.5px]"
        disabled={disabled}
        value={value}
        onChange={(e) => onValueChange((isNumeric ? Number(e.target.value) : e.target.value) as T)}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            className="bg-popover text-popover-foreground"
          >
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface SettingLinkRowProps {
  label: string;
  description?: string;
  href: string;
}

/** Same shape as `SettingRow`, but as an outbound link - opens in a new tab. */
export function SettingLinkRow({ label, description, href }: SettingLinkRowProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        ROW_CLASS,
        'transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
      )}
    >
      <div className="min-w-0">
        <p className={LABEL_CLASS}>{label}</p>
        {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
      </div>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60" />
    </a>
  );
}

interface SettingActionRowProps {
  label: string;
  description?: string;
  action: React.ReactNode;
}

/** Same shape as `SettingRow`, but with an arbitrary trigger (e.g. a button that opens a confirm dialog) instead of a toggle. */
export function SettingActionRow({ label, description, action }: SettingActionRowProps) {
  return (
    <div className={ROW_CLASS}>
      <div className="min-w-0">
        <p className={LABEL_CLASS}>{label}</p>
        {description && <p className={DESCRIPTION_CLASS}>{description}</p>}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
