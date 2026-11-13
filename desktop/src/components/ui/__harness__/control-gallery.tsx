import { useState, type ReactNode } from "react";

import { Plus, Search } from "lucide-react";
import { Badge } from "../badge";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "../drawer";
import { Input } from "../input";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Switch } from "../switch";
import { TaskPanel, type TaskItem } from "../tasks";
import { Textarea } from "../textarea";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../alert-dialog";
import { Avatar, AvatarFallback } from "../avatar";
import { Code } from "../code";
import { Progress } from "../progress";
import { ScrollArea } from "../scroll-area";
import { Select } from "../select";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../sheet";
import { ListSkeleton } from "../skeleton";
import { Slider } from "../slider";
import { ToggleGroup, ToggleGroupItem } from "../toggle-group";
import { Tooltip } from "../tooltip";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="lab-section">
      <h2>{title}</h2>
      <div className="lab-controls">{children}</div>
    </section>
  );
}
export function ControlGallery({
  tasks,
  setTasks,
  setCommand,
}: {
  tasks: TaskItem[];
  setTasks: (tasks: TaskItem[]) => void;
  setCommand: (open: boolean) => void;
}) {
  const [notice, setNotice] = useState("");
  const [branch, setBranch] = useState("main");
  const [progress, setProgress] = useState(65);
  return (
    <div className="lab-page">
      <h1>Components</h1>
      <p className="lab-dim">Shared controls, floating surfaces, and interaction states.</p>
      <Section title="Buttons">
        <Button>Continue</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
        <Button disabled>Disabled</Button>
      </Section>
      <Section title="Compact sizes">
        <Button size="xs">24 px</Button>
        <Button size="sm">28 px</Button>
        <Button>32 px</Button>
        <Button size="lg">36 px</Button>
        <Button size="icon-sm" variant="outline" aria-label="Add item">
          <Plus />
        </Button>
      </Section>
      <Section title="Fields">
        <Input placeholder="Workspace name" aria-label="Workspace name" />
        <Input
          prefix={<Search size={14} />}
          placeholder="Search files…"
          aria-label="Search files"
        />
        <Textarea placeholder="Description" aria-label="Description" />
      </Section>
      <Section title="Selection">
        <label className="lab-inline">
          <Checkbox defaultChecked />
          Include untracked files
        </label>
        <label className="lab-inline">
          <Switch defaultChecked />
          Notifications
        </label>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
      </Section>
      <Section title="Overlays">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>Give this workspace a name.</DialogDescription>
            <div style={{ marginTop: 20 }}>
              <Input aria-label="New workspace name" placeholder="Workspace name" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button onClick={() => setNotice("Workspace form confirmed.")}>Create</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="outline">Open drawer</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerTitle>Tasks</DrawerTitle>
            <DrawerDescription>Review the workspace tasks.</DrawerDescription>
            <div style={{ paddingBlock: 24 }}>
              <TaskPanel tasks={tasks} />
            </div>
            <DrawerClose asChild>
              <Button variant="outline">Close drawer</Button>
            </DrawerClose>
          </DrawerContent>
        </Drawer>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Open popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p>Workspace options</p>
            <Input placeholder="Filter…" aria-label="Filter options" />
          </PopoverContent>
        </Popover>
        <Button variant="outline" onClick={() => setCommand(true)}>
          Open command menu
        </Button>
      </Section>
      <Section title="Tasks">
        <TaskPanel
          tasks={tasks}
          onStatusChange={(id, status) =>
            setTasks(tasks.map((t) => (t.id === id ? { ...t, status } : t)))
          }
        />
      </Section>
      <Section title="Select and ranges">
        <Select
          aria-label="Default branch"
          value={branch}
          onChange={setBranch}
          options={[
            { value: "main", label: "main" },
            { value: "develop", label: "develop" },
            { value: "release", label: "release" },
          ]}
        />
        <div style={{ width: 240 }}>
          <Slider
            aria-label="Progress value"
            value={[progress]}
            onValueChange={([value]) => setProgress(value)}
          />
          <Progress aria-label="Task progress" value={progress} style={{ marginTop: 12 }} />
          <p className="lab-dim" style={{ marginTop: 8 }}>
            {progress}% complete
          </p>
        </div>
      </Section>
      <Section title="Avatars and inline controls">
        <Avatar>
          <AvatarFallback>MK</AvatarFallback>
        </Avatar>
        <Code>src/components</Code>
        <Tooltip content="Create a new workspace">
          <Button variant="outline">Tooltip target</Button>
        </Tooltip>
        <ToggleGroup type="single" defaultValue="list" aria-label="Layout">
          <ToggleGroupItem value="list">List</ToggleGroupItem>
          <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
        </ToggleGroup>
      </Section>
      <Section title="Collapsible content">
        <Accordion type="single" collapsible style={{ width: "100%" }}>
          <AccordionItem value="details">
            <AccordionTrigger>Workspace details</AccordionTrigger>
            <AccordionContent>Branch main · 3 changed files</AccordionContent>
          </AccordionItem>
          <AccordionItem value="history">
            <AccordionTrigger>Recent activity</AccordionTrigger>
            <AccordionContent>Command menu added to the workspace.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </Section>
      <Section title="Sheets and confirmations">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open sheet</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetTitle>Workspace details</SheetTitle>
            <SheetDescription>Review the changes and tasks in this workspace.</SheetDescription>
            <TaskPanel tasks={tasks} />
          </SheetContent>
        </Sheet>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">Open confirmation</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Clear preview notification?</AlertDialogTitle>
            <AlertDialogDescription>
              This only clears the message shown in this component gallery.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => setNotice("")}>
                Clear notification
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Section>
      <Section title="Scrolling and loading">
        <ScrollArea style={{ height: 140, width: "100%" }}>
          <ListSkeleton rows={6} />
        </ScrollArea>
      </Section>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
