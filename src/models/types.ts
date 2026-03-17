// ── Existing the platform schema types ──

export interface Company {
  id: string;
  name: string;
  pos_provider: 'servicetitan' | 'housecallpro' | 'none';
  pos_tenant_id: string | null;
}

export type UserRole = 'technician' | 'admin' | 'asr';

export interface User {
  id: string;
  first_name: string;
  last_name: string;
  cell_phone: string;
  email: string | null;
  role: UserRole;
  company_id: string;
  pos_technician_id: string | null;
  is_active: boolean;
  stripe_account_id: string | null;
  created_at: Date;
}

export type JobStatus = 'pending' | 'routed' | 'completed' | 'canceled';

export interface Job {
  id: string;
  created_by_user_id: string;
  created_by_company_id: string;
  homeowner_phone: string;
  summary: string;
  status: JobStatus;
  created_at: Date;
}

// ── New schema additions for lifecycle management ──

export type TechnicianLifecycleStatus =
  | 'active'
  | 'deactivated'
  | 'phone_released'
  | 'phone_reassigned';

export interface TechnicianStatusChange {
  id: string;
  user_id: string;
  company_id: string;
  previous_status: TechnicianLifecycleStatus;
  new_status: TechnicianLifecycleStatus;
  reason: string;
  pos_technician_id: string | null;
  phone_number: string | null;
  requires_review: boolean;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  resolution: string | null;
  created_at: Date;
}

export type SyncEventType =
  | 'technician_deactivated'
  | 'technician_activated'
  | 'new_technician_detected'
  | 'phone_conflict_detected'
  | 'phone_released'
  | 'phone_reassigned'
  | 'technician_returned'
  | 'earnings_preserved'
  | 'no_changes';

export interface SyncEvent {
  id: string;
  sync_run_id: string;
  company_id: string;
  event_type: SyncEventType;
  user_id: string | null;
  pos_technician_id: string | null;
  details: Record<string, any>;
  action_taken: string;
  created_at: Date;
}

export interface SyncRun {
  id: string;
  company_id: string;
  started_at: Date;
  completed_at: Date | null;
  status: 'running' | 'completed' | 'failed';
  technicians_processed: number;
  changes_detected: number;
  changes_applied: number;
  flags_for_review: number;
  error_message: string | null;
}

export interface PhoneNumberAudit {
  id: string;
  phone_number: string;
  previous_user_id: string | null;
  new_user_id: string | null;
  action: 'released' | 'reassigned' | 'conflict_flagged';
  reason: string;
  created_at: Date;
}

// ── ServiceTitan API response types ──

export interface ServiceTitanTechnician {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phoneNumber: string | null;
  active: boolean;
  createdOn: string;
  modifiedOn: string;
}

export interface ServiceTitanResponse {
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  data: ServiceTitanTechnician[];
}

// ── Provider interface (extensible for Housecall Pro, etc.) ──

export interface PoSTechnician {
  externalId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  active: boolean;
}

export interface PoSProvider {
  name: string;
  fetchTechnicians(tenantId: string): Promise<PoSTechnician[]>;
}
