-- Migration 001: Initial the platform schema + Lifecycle management tables
-- This represents the existing schema plus new additions for technician lifecycle tracking.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ══════════════════════════════════════════════
-- Existing the platform tables (simplified)
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  pos_provider VARCHAR(50) NOT NULL DEFAULT 'none' CHECK (pos_provider IN ('servicetitan', 'housecallpro', 'none')),
  pos_tenant_id VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  cell_phone VARCHAR(20),
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'technician' CHECK (role IN ('technician', 'admin', 'asr')),
  company_id UUID NOT NULL REFERENCES companies(id),
  pos_technician_id VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  stripe_account_id VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_by_company_id UUID NOT NULL REFERENCES companies(id),
  homeowner_phone VARCHAR(20),
  summary TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'routed', 'completed', 'canceled')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════
-- NEW: Technician Lifecycle Management tables
-- ══════════════════════════════════════════════

-- Tracks every sync run for auditability
CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id),
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  technicians_processed INTEGER NOT NULL DEFAULT 0,
  changes_detected INTEGER NOT NULL DEFAULT 0,
  changes_applied INTEGER NOT NULL DEFAULT 0,
  flags_for_review INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

-- Granular events within each sync run
CREATE TABLE IF NOT EXISTS sync_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_run_id UUID NOT NULL REFERENCES sync_runs(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  event_type VARCHAR(50) NOT NULL,
  user_id UUID REFERENCES users(id),
  pos_technician_id VARCHAR(255),
  details JSONB NOT NULL DEFAULT '{}',
  action_taken TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Tracks technician status transitions for operations visibility
CREATE TABLE IF NOT EXISTS technician_status_changes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  previous_status VARCHAR(30) NOT NULL,
  new_status VARCHAR(30) NOT NULL,
  reason TEXT NOT NULL,
  pos_technician_id VARCHAR(255),
  phone_number VARCHAR(20),
  requires_review BOOLEAN NOT NULL DEFAULT false,
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(255),
  resolution TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Audit trail for phone number changes - critical for the identity conflict problem
CREATE TABLE IF NOT EXISTS phone_number_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number VARCHAR(20) NOT NULL,
  previous_user_id UUID REFERENCES users(id),
  new_user_id UUID REFERENCES users(id),
  action VARCHAR(30) NOT NULL CHECK (action IN ('released', 'reassigned', 'conflict_flagged')),
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════
-- NEW: Column additions to existing users table
-- ══════════════════════════════════════════════

-- Track when a technician was deactivated and their departure details
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;
-- Preserve the phone number at time of departure so we can detect reassignment
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_known_phone VARCHAR(20);
-- Track which sync run last touched this user
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;

-- ══════════════════════════════════════════════
-- Indexes for performance
-- ══════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_users_cell_phone ON users(cell_phone);
CREATE INDEX IF NOT EXISTS idx_users_company_active ON users(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_users_pos_technician ON users(pos_technician_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_company ON sync_runs(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_run ON sync_events(sync_run_id);
CREATE INDEX IF NOT EXISTS idx_status_changes_user ON technician_status_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_status_changes_review ON technician_status_changes(requires_review, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_phone_audit_phone ON phone_number_audit(phone_number);
