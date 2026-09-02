"use client";

import type { AssignedToolConfig, RiskClass } from "@/lib/api-client";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import {
  effectivePermission,
  groupPermission,
  partitionToolsByRisk,
  setGroupPermission,
  setToolPermission,
  type ToolPermission,
} from "@/lib/tool-permissions";

export interface PermissionToolOption {
  id: string;
  label: string;
  sourceName: string;
  riskClass: RiskClass;
  unavailable?: boolean;
}

function groupOptions(
  options: PermissionToolOption[],
  query: string,
): Array<{ sourceName: string; options: PermissionToolOption[] }> {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = new Map<string, PermissionToolOption[]>();
  for (const option of options) {
    if (
      normalizedQuery &&
      !option.label.toLowerCase().includes(normalizedQuery) &&
      !option.id.toLowerCase().includes(normalizedQuery) &&
      !option.sourceName.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }
    const group = groups.get(option.sourceName) ?? [];
    group.push(option);
    groups.set(option.sourceName, group);
  }
  return Array.from(groups, ([sourceName, groupedOptions]) => ({ sourceName, options: groupedOptions }));
}

function PermissionToggle({
  label,
  permission,
  allowDisabled,
  onChange,
}: {
  label: string;
  permission: ToolPermission;
  allowDisabled: boolean;
  onChange: (permission: ToolPermission) => void;
}) {
  const options: Array<SegmentedOption<ToolPermission>> = [
    {
      value: "allow",
      label: "Allow",
      disabled: allowDisabled,
      disabledReason: allowDisabled ? "Destructive tools always require approval — they cannot be allowed" : undefined,
    },
    { value: "ask", label: "Ask" },
    { value: "blocked", label: "Block" },
  ];
  return (
    <SegmentedControl
      label={`${label} permission`}
      value={permission}
      options={options}
      onChange={onChange}
      className="w-full sm:w-auto"
    />
  );
}

function RiskSection({
  title,
  options,
  tools,
  onChange,
}: {
  title: string;
  options: PermissionToolOption[];
  tools: Record<string, AssignedToolConfig>;
  onChange: (next: Record<string, AssignedToolConfig>) => void;
}) {
  if (options.length === 0) return null;
  const aggregate = groupPermission(options, tools);
  const bulkId = `bulk-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <h5 className="m-0 font-sans text-[13px] font-medium text-fg">{title}</h5>
          <span
            className="rounded-full px-1.5 font-mono text-[10px] text-fg-faint"
            style={{ background: "var(--neutral-soft)" }}
          >
            {options.length}
          </span>
        </div>
        <label className="sr-only" htmlFor={bulkId}>
          Set all {title} to
        </label>
        <select
          id={bulkId}
          value={aggregate}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom" || (value !== "allow" && value !== "ask" && value !== "blocked")) return;
            onChange(setGroupPermission(tools, options, value));
          }}
          className="rounded-full border px-2 py-1 font-sans text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
        >
          <option value="allow">Always allow</option>
          <option value="ask">Ask</option>
          <option value="blocked">Blocked</option>
          {aggregate === "custom" && <option value="custom">Custom</option>}
        </select>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {options.map((opt) => {
          const permission = effectivePermission(opt.riskClass, tools[opt.id]);
          return (
            <li
              key={opt.id}
              className="flex flex-col items-stretch justify-between gap-2 border-t py-3 sm:flex-row sm:items-center sm:gap-4"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0">
                <p className="m-0 font-sans text-sm text-fg">{opt.label}</p>
                {opt.unavailable && <p className="m-0 font-mono text-[11px] text-fg-faint">Unavailable</p>}
              </div>
              <PermissionToggle
                label={opt.label}
                permission={permission}
                allowDisabled={opt.unavailable === true || opt.riskClass === "destructive"}
                onChange={(next) => onChange(setToolPermission(tools, opt.id, next, opt.riskClass))}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ToolPermissionsEditor({
  options,
  tools,
  query,
  onQueryChange,
  onChange,
  subjectName,
}: {
  options: PermissionToolOption[];
  tools: Record<string, AssignedToolConfig>;
  query: string;
  onQueryChange: (query: string) => void;
  onChange: (next: Record<string, AssignedToolConfig>) => void;
  subjectName: string;
}) {
  const groups = groupOptions(options, query);
  return (
    <fieldset className="flex flex-col gap-3 border-0 p-0">
      <legend className="mb-1 font-serif text-lg text-fg">Tool permissions</legend>
      <p className="m-0 font-sans text-[13px] text-fg-muted">
        Choose when {subjectName} is allowed to use these tools.
      </p>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search tools or connections…"
        aria-label="Search tools or connections"
        name="tool-search"
        autoComplete="off"
        className="w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
      />
      {groups.map((group) => {
        const { readOnly, write } = partitionToolsByRisk(group.options);
        return (
          <section
            key={group.sourceName}
            className="rounded-button border px-3 py-3"
            style={{ borderColor: "var(--border)" }}
          >
            <h4 className="m-0 mb-3 font-sans text-sm font-semibold text-fg">{group.sourceName}</h4>
            <div className="flex flex-col gap-4">
              <RiskSection title="Read-only tools" options={readOnly} tools={tools} onChange={onChange} />
              <RiskSection title="Write/delete tools" options={write} tools={tools} onChange={onChange} />
            </div>
          </section>
        );
      })}
      {groups.length === 0 && <p className="m-0 font-sans text-sm text-fg-muted">No tools match that search.</p>}
    </fieldset>
  );
}
