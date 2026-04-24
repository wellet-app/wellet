// Unit test for ehr-persist row builders. Validates:
// 1. Fingerprints are stable across calls with identical input
// 2. Fingerprints differ when key fields differ
// 3. Row shapes match DB column names (spot check)
// 4. Garbage rows ('Unknown *', missing dates) are filtered out
// 5. Observation splitter correctly routes vitals vs labs

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts';

// Capture the upsert calls instead of running them
const calls: Array<{ table: string; rows: Record<string, unknown>[]; opts: any }> = [];
const fakeAdmin = {
  from(table: string) {
    return {
      upsert(rows: Record<string, unknown>[], opts: any) {
        calls.push({ table, rows, opts });
        return Promise.resolve({ error: null, count: rows.length });
      },
    };
  },
};

import { persistEhrData } from './ehr-persist.ts';

const PERSON = '2a1e1a92-f091-40d2-9f25-567d9b37fefb';

Deno.test('medications: active meds persist, names lowercased for fingerprint', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    medications: [
      { type: 'medication', source: 'ehr', name: 'Metformin 500 mg', code: '860975', status: 'active', dosage: '1 tablet by mouth twice daily', frequency: '2x per 1 d', date_asserted: '2025-11-15T00:00:00Z', prescriber_name: 'Dr. Illath' },
      { type: 'medication', source: 'ehr', name: 'Lisinopril 10 mg', code: '314076', status: 'completed', dosage: '1 tablet daily', frequency: '1x per 1 d', date_asserted: '2024-06-01T00:00:00Z', prescriber_name: 'Dr. Illath' },
    ],
  });
  assertEquals(r.medications, 2, 'both meds should persist');
  const medCall = calls.find((c) => c.table === 'medications')!;
  assertEquals(medCall.rows.length, 2);
  assertEquals(medCall.rows[0].name, 'Metformin 500 mg');
  assertEquals(medCall.rows[0].active, true);
  assertEquals(medCall.rows[1].active, false, 'completed meds are inactive');
  assertEquals(medCall.opts.onConflict, 'person_id,source_fingerprint');
});

Deno.test('fingerprint is stable across runs', async () => {
  calls.length = 0;
  const input = {
    medications: [{ name: 'Metformin 500 mg', code: '860975', status: 'active', date_asserted: '2025-11-15T00:00:00Z' }],
  };
  await persistEhrData(fakeAdmin as any, PERSON, input);
  const fp1 = calls[0].rows[0].source_fingerprint;
  calls.length = 0;
  await persistEhrData(fakeAdmin as any, PERSON, input);
  const fp2 = calls[0].rows[0].source_fingerprint;
  assertEquals(fp1, fp2, 'fingerprint must be stable');
});

Deno.test('fingerprint differs for different codes', async () => {
  calls.length = 0;
  await persistEhrData(fakeAdmin as any, PERSON, {
    medications: [
      { name: 'Metformin', code: '860975', status: 'active', date_asserted: '2025-11-15' },
      { name: 'Metformin', code: '861000', status: 'active', date_asserted: '2025-11-15' },
    ],
  });
  const rows = calls[0].rows;
  assertNotEquals(rows[0].source_fingerprint, rows[1].source_fingerprint);
});

Deno.test('allergies: Unknown allergen is filtered', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    allergies: [
      { name: 'Penicillin', code: '7980', severity: 'severe', reactions: ['Rash', 'Hives'], status: 'active', recorded_date: '2020-01-15T00:00:00Z' },
      { name: 'Unknown allergen', code: '', severity: '', reactions: [], status: '', recorded_date: '' },
    ],
  });
  assertEquals(r.allergies, 1);
  const row = calls.find((c) => c.table === 'allergies')!.rows[0];
  assertEquals(row.substance, 'Penicillin');
  assertEquals(row.reaction, 'Rash, Hives');
  assertEquals(row.severity, 'severe');
});

Deno.test('health_events: conditions, visits, immunizations, diagnostic reports all land', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    conditions: [
      { name: 'Type 2 diabetes', code: 'E11.9', status: 'active', onset_date: '2018-03-12', recorded_date: '' },
    ],
    visits: [
      { id: 'enc-123', name: 'Office Visit', start_date: '2025-11-15T14:00:00Z', location: 'Duke Clinic', reason: 'annual physical' },
    ],
    immunizations: [
      { name: 'Influenza, seasonal', code: '88', date: '2025-10-12T00:00:00Z', lot_number: 'A1B2' },
    ],
    diagnostic_reports: [
      { name: 'MRI Brain', code: '24590-2', effective_date: '2025-09-20T10:00:00Z', conclusion: 'No acute findings.', category: 'Radiology' },
    ],
  });
  assertEquals(r.health_events, 4);
  const types = calls.find((c) => c.table === 'health_events')!.rows.map((row) => row.event_type);
  assertEquals(types.sort(), ['condition', 'diagnostic_report', 'immunization', 'visit']);
});

Deno.test('health_events: rows without dates are skipped', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    conditions: [
      { name: 'Type 2 diabetes', onset_date: '', recorded_date: '' }, // no date, skip
      { name: 'Hypertension', onset_date: '2019-01-01', recorded_date: '' },
    ],
  });
  assertEquals(r.health_events, 1);
});

Deno.test('observations: split into labs and vitals by LOINC', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    observations: [
      // Vital-signs by LOINC
      { name: 'Systolic blood pressure', code: '8480-6', value: '132', unit: 'mmHg', effective_date: '2025-11-15', category: '' },
      // Vital-signs by category
      { name: 'Heart rate', code: '8867-4', value: '74', unit: 'bpm', effective_date: '2025-11-15', category: 'vital-signs' },
      // Lab by category
      { name: 'Hemoglobin A1c', code: '4548-4', value: '6.8', unit: '%', effective_date: '2025-11-15', category: 'laboratory' },
      // Lab by default (unknown category, non-vital LOINC)
      { name: 'Cholesterol', code: '2093-3', value: '190', unit: 'mg/dL', effective_date: '2025-10-01', category: '' },
    ],
  });
  assertEquals(r.vitals, 2);
  assertEquals(r.lab_results, 2);
});

Deno.test('observations: vital with no value is skipped (value NOT NULL)', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {
    observations: [
      { name: 'Systolic blood pressure', code: '8480-6', value: '', unit: '', effective_date: '2025-11-15', category: '' },
    ],
  });
  assertEquals(r.vitals, 0);
});

Deno.test('empty input produces empty result, no errors', async () => {
  calls.length = 0;
  const r = await persistEhrData(fakeAdmin as any, PERSON, {});
  assertEquals(r.medications, 0);
  assertEquals(r.allergies, 0);
  assertEquals(r.health_events, 0);
  assertEquals(r.lab_results, 0);
  assertEquals(r.vitals, 0);
  assertEquals(r.errors.length, 0);
  assertEquals(calls.length, 0, 'should not call upsert for empty batches');
});

Deno.test('upsert error is captured in errors array', async () => {
  const errAdmin = {
    from(_table: string) {
      return {
        upsert(_rows: any, _opts: any) {
          return Promise.resolve({ error: { message: 'permission denied', code: '42501' }, count: 0 });
        },
      };
    },
  };
  const r = await persistEhrData(errAdmin as any, PERSON, {
    medications: [{ name: 'Metformin', code: '1', status: 'active', date_asserted: '2025-11-15' }],
  });
  assertEquals(r.errors.length >= 1, true);
  assertEquals(r.errors[0].includes('permission denied'), true);
});
