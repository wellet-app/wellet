// Unit tests for the reimbursement prefill resolver. Validates:
// 1. Missing chart data is handled gracefully — every field falls through
//    to "asked" with no throw.
// 2. Provenance correctly flags ehr / inferred / user / asked.
// 3. partial_input (the caregiver's answers) always wins over derivation.
// 4. Helpers (age band, conditions text, coverage text, role mapping)
//    behave at the boundaries.

import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';
import {
  ageBandFromDob,
  conditionsFromText,
  coverageFromText,
  caregiverRoleFromCareCircle,
  resolvePrefill,
} from './reimbursement-prefill.ts';

Deno.test('missing chart data: all derivable fields are asked, none throw', () => {
  const r = resolvePrefill(
    { person: { id: 'p1' }, ehrConnections: [], careCircleRole: null, soleCareCircleMember: false },
    {},
  );
  // The 3 always-ask + role + the 5 derivable (all empty) = every field asked.
  for (const f of ['loved_one_age_band', 'conditions', 'current_tools', 'biggest_worry', 'coverage', 'adl_level', 'hospital_system', 'caregiver_role', 'state']) {
    assertEquals(r.asked_fields.includes(f), true, f + ' should be asked');
  }
  assertEquals(r.prefilled_fields.length, 0);
});

Deno.test('ehr + profile derivation sets provenance and prefilled_fields', () => {
  const r = resolvePrefill(
    {
      person: { id: 'p1', date_of_birth: '1945-03-01', conditions: 'Type 2 diabetes, mild dementia', insurance_info: 'Medicare Part A+B, Medicaid' },
      ehrConnections: [{ hospital_name: 'Duke University Hospital', status: 'connected' }],
      careCircleRole: 'primary',
      soleCareCircleMember: false,
    },
    {},
  );
  assertEquals(r.provenance.loved_one_age_band, 'ehr');
  assertEquals(r.provenance.conditions, 'ehr');
  assertEquals(r.provenance.coverage, 'inferred');
  assertEquals(r.provenance.hospital_system, 'ehr');
  assertEquals(r.provenance.caregiver_role, 'ehr');
  // Duke -> NC via deriveState, off the prefilled hospital.
  assertEquals(r.input.state, 'NC');
  assertEquals(r.provenance.state, 'inferred');
  // Always-ask fields remain asked.
  assertEquals(r.asked_fields.includes('adl_level'), true);
  assertEquals(r.asked_fields.includes('biggest_worry'), true);
});

Deno.test('partial_input wins over derivation, provenance = user', () => {
  const r = resolvePrefill(
    {
      person: { id: 'p1', date_of_birth: '1945-03-01', conditions: 'dementia' },
      ehrConnections: [],
    },
    { loved_one_age_band: '70_79', adl_level: '3_plus', coverage: ['veteran'] },
  );
  assertEquals(r.input.loved_one_age_band, '70_79');
  assertEquals(r.provenance.loved_one_age_band, 'user');
  assertEquals(r.input.adl_level, '3_plus');
  assertEquals(r.provenance.adl_level, 'user');
  assertEquals(r.provenance.coverage, 'user');
  assertEquals(r.input.coverage[0], 'veteran');
});

Deno.test('sole care-circle member defaults role to primary (inferred)', () => {
  const r = resolvePrefill(
    { person: { id: 'p1' }, ehrConnections: [], careCircleRole: null, soleCareCircleMember: true },
    {},
  );
  assertEquals(r.input.caregiver_role, 'primary');
  assertEquals(r.provenance.caregiver_role, 'inferred');
});

Deno.test('ageBandFromDob boundaries', () => {
  const yr = new Date().getFullYear();
  assertEquals(ageBandFromDob((yr - 30) + '-01-01'), 'under_60');
  assertEquals(ageBandFromDob((yr - 65) + '-01-01'), '60_69');
  assertEquals(ageBandFromDob((yr - 75) + '-01-01'), '70_79');
  assertEquals(ageBandFromDob((yr - 95) + '-01-01'), '90_plus');
  assertEquals(ageBandFromDob(null), null);
  assertEquals(ageBandFromDob('not-a-date'), null);
});

Deno.test('conditionsFromText collapses 3+ matches to multiple', () => {
  assertEquals(conditionsFromText('diabetes'), ['diabetes']);
  assertEquals(conditionsFromText(''), []);
  assertEquals(conditionsFromText(null), []);
  assertEquals(conditionsFromText('diabetes, heart failure, kidney disease'), ['multiple']);
});

Deno.test('coverageFromText recognizes veteran/medicare/medicaid', () => {
  assertEquals(coverageFromText('VA disability').includes('veteran'), true);
  assertEquals(coverageFromText('Medicare Advantage').includes('medicare'), true);
  assertEquals(coverageFromText('').length, 0);
});

Deno.test('caregiverRoleFromCareCircle maps secondary -> shared', () => {
  assertEquals(caregiverRoleFromCareCircle('secondary', false), 'shared');
  assertEquals(caregiverRoleFromCareCircle('primary', false), 'primary');
  assertEquals(caregiverRoleFromCareCircle('emergency', false), null);
  assertEquals(caregiverRoleFromCareCircle(null, true), 'primary');
});
