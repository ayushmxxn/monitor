import { Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ClearAllMonitorsDialogProps {
  monitorCount: number;
  onConfirm: () => void;
  trigger: React.ReactElement;
}

export function ClearAllMonitorsDialog({
  monitorCount,
  onConfirm,
  trigger,
}: ClearAllMonitorsDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear all monitors?</DialogTitle>
          <DialogDescription>
            This removes all {monitorCount} monitor{monitorCount === 1 ? '' : 's'} and their full
            check history. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              Cancel
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={onConfirm}>
              <Trash2 />
              Clear all
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
