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

interface DeleteMonitorDialogProps {
  monitorName: string;
  onConfirm: () => void;
  trigger: React.ReactElement;
}

export function DeleteMonitorDialog({
  monitorName,
  onConfirm,
  trigger,
}: DeleteMonitorDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10">
          <Trash2 className="h-4 w-4 text-destructive" />
        </div>
        <DialogHeader className="mb-0 gap-1">
          <DialogTitle className="text-[14px]">Delete “{monitorName}”?</DialogTitle>
          <DialogDescription>
            This removes the monitor and its full check history. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 my-3.5 border-t border-border" />
        <DialogFooter className="mt-0">
          <DialogClose asChild>
            <Button variant="outline" size="sm" className="text-xs">
              No, keep it
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="destructive" size="sm" className="text-xs" onClick={onConfirm}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
