import type { DrizzleDb } from "../db/client.js";
import type { SchedulerHandle } from "../orchestration/scheduler.js";
import { ApprovalService } from "./approval-service.js";
import { ControlAuditService } from "./audit-service.js";
import { JobService, type JobServiceControls, type JobServiceSettings } from "./job-service.js";
import { PersonaQueryService } from "./persona-query-service.js";
import { RoutineService } from "./routine-service.js";

export interface ControlPlane {
  personas: PersonaQueryService;
  jobs: JobService;
  routines: RoutineService;
  approvals: ApprovalService;
  audit: ControlAuditService;
}

export interface ControlPlaneDependencies {
  db: DrizzleDb;
  settings: JobServiceSettings;
  scheduler?: SchedulerHandle;
  jobControls?: JobServiceControls;
}

/** Builds the single shared service aggregate used by every control adapter. */
export function createControlPlane(dependencies: ControlPlaneDependencies): ControlPlane {
  return {
    personas: new PersonaQueryService(dependencies.db),
    jobs: new JobService(dependencies.db, dependencies.settings, dependencies.jobControls),
    routines: new RoutineService(dependencies.db, dependencies.scheduler),
    approvals: new ApprovalService(dependencies.db),
    audit: new ControlAuditService(dependencies.db),
  };
}
