import type { CreateRoutineInput } from './routine-types';
import type { SkillCategory } from './skills-catalog';

export type PackSurface = 'chat' | 'agent' | 'routine' | 'companion' | 'board';
export type PackAccess = 'read' | 'write' | 'execute' | 'admin';
export type PackConfirmation = 'never' | 'once' | 'each_time';
export type PackSourceType = 'manifest' | 'run' | 'url' | 'folder';

export interface PackPermission {
  id: string;
  action: string;
  access: PackAccess;
  resource?: string;
  accountScope?: string;
  parameters?: Record<string, unknown>;
  confirmation: PackConfirmation;
  surfaces: PackSurface[];
}

export interface PackSkillDefinition {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  promptHint: string;
  permissionIds?: string[];
}

export interface PackCommandDefinition {
  id: string;
  syntax: string;
  description: string;
  promptTemplate: string;
  permissionIds?: string[];
  surfaces: PackSurface[];
}

export interface PackAgentTemplate {
  id: string;
  name: string;
  description?: string;
  model?: string;
  skills: string[];
  integrationRequirements?: string[];
  permissionIds?: string[];
}

export interface PackMcpRequirement {
  id: string;
  presetId?: string;
  name: string;
  command?: string;
  args?: string[];
  requiredEnv?: string[];
  permissionIds?: string[];
}

export interface PackHookDefinition {
  id: string;
  event: string;
  routineTemplateId?: string;
  permissionIds?: string[];
}

export interface PackRoutineTemplate {
  id: string;
  name: string;
  description?: string;
  definition: Omit<CreateRoutineInput, 'id' | 'agentId'> & { agentId?: string };
  permissionIds?: string[];
}

export interface PackSetupCheck {
  id: string;
  kind: 'integration' | 'mcp_preset' | 'env' | 'path';
  value: string;
  required?: boolean;
}

export interface PackTestDefinition {
  id: string;
  kind: 'contains' | 'permission_declared' | 'setup';
  value: string;
  target?: string;
}

export interface PackMigration {
  fromVersion: string;
  note: string;
  reversible: boolean;
}

export interface CapabilityPackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  supportedSurfaces: PackSurface[];
  permissions: PackPermission[];
  skills: PackSkillDefinition[];
  commands: PackCommandDefinition[];
  agents: PackAgentTemplate[];
  mcpServers: PackMcpRequirement[];
  integrationRequirements: string[];
  hooks: PackHookDefinition[];
  routineTemplates: PackRoutineTemplate[];
  setupChecks: PackSetupCheck[];
  tests: PackTestDefinition[];
  migrations: PackMigration[];
}

export interface PackScanFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  code: string;
  message: string;
  path?: string;
}

export interface PackCheckResult {
  id: string;
  passed: boolean;
  message: string;
}

export interface CapabilityPackProposal {
  id: string;
  packId: string;
  version: string;
  status: 'proposed' | 'rejected' | 'activated';
  sourceType: PackSourceType;
  sourceRef: string;
  sourceHash: string;
  manifest: CapabilityPackManifest;
  diff: Record<string, unknown>;
  scan: { passed: boolean; findings: PackScanFinding[] };
  tests: { passed: boolean; results: PackCheckResult[] };
  setup: { passed: boolean; results: PackCheckResult[] };
  requestedPermissionKeys: string[];
  createdAt: string;
  reviewedAt?: string;
}

export interface CapabilityPackRecord {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'disabled' | 'uninstalled';
  activeVersion?: string;
  previousVersion?: string;
  grantedPermissionKeys: string[];
  sourceType: PackSourceType;
  sourceRef: string;
  sourceHash: string;
  usageCount: number;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastSuccessRunId?: string;
  staleAt?: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  manifest?: CapabilityPackManifest;
  availableVersions?: string[];
}

export interface LearningJourneyEntry {
  id: string;
  kind: 'pack' | 'memory';
  title: string;
  detail: string;
  source: string;
  status: string;
  version?: string;
  pinned: boolean;
  lastSuccessAt?: string;
  staleAt?: string;
  createdAt: string;
  updatedAt: string;
}
