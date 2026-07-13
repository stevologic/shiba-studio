import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { can, listPermissions } from './rbac.ts';

describe('RBAC matrix', () => {
  it('OWNER can delete team and manage billing', () => {
    assert.equal(can('OWNER', 'team', 'delete'), true);
    assert.equal(can('OWNER', 'team_billing', 'manage'), true);
    assert.equal(can('OWNER', 'team_sso', 'manage'), true);
  });

  it('ADMIN cannot delete team or manage payments', () => {
    assert.equal(can('ADMIN', 'team', 'delete'), false);
    assert.equal(can('ADMIN', 'team_payments', 'manage'), false);
    assert.equal(can('ADMIN', 'team_invitation', 'create'), true);
    assert.equal(can('ADMIN', 'team_sso', 'update'), true);
  });

  it('MEMBER is read-mostly', () => {
    assert.equal(can('MEMBER', 'team', 'read'), true);
    assert.equal(can('MEMBER', 'team_member', 'delete'), false);
    assert.equal(can('MEMBER', 'team_api_key', 'create'), false);
    assert.equal(can('MEMBER', 'team_sso', 'manage'), false);
  });

  it('permission lists are non-empty and OWNER is largest', () => {
    const o = listPermissions('OWNER').length;
    const a = listPermissions('ADMIN').length;
    const m = listPermissions('MEMBER').length;
    assert.ok(o > a && a > m && m > 0);
  });
});
