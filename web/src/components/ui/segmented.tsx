"use client";

import { cn } from "cn";
import { RadioGroup } from "radix-ui";

/** A row of mutually exclusive choices, for a setting with two to four short options. */
export function Segmented<Value extends string>({ value, onValueChange, options, className, ...props }: {
  "value": Value;
  "onValueChange": (value: Value) => void;
  "options": readonly { value: Value; label: string }[];
  "className"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={next => onValueChange(next as Value)}
      orientation="horizontal"
      className={cn("grid auto-cols-fr grid-flow-col gap-1 rounded-full bg-fill p-1", className)}
      {...props}
    >
      {options.map(option => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className="h-8 min-w-0 truncate rounded-full px-3 text-[13px] font-semibold text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm"
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
